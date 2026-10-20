import net from "node:net";

// Entry point "./testing": test helpers for code that uses SignalClient. A fake signal-cli daemon, so a test talks
// to a real socket without Signal. It speaks the same line-delimited JSON-RPC, records what the client sends,
// answers as the test says, and can push what signal-cli would push (incoming messages) or misbehave (partial
// lines, hang up).

/** A request the client sent. */
export interface FakeRequest {
  id: number;
  method: string;
  params: any;
}

/** Returned from an answer function to make the request fail with this message, like signal-cli's JSON-RPC error. */
export class FakeRpcError {
  message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/**
 * What to answer a request with: a result, a {@link FakeRpcError}, or undefined to leave it unanswered (the test
 * answers later with `reply()`, or never, to exercise timeouts and a hang-up with a request in flight).
 */
export type FakeAnswer = (req: FakeRequest) => unknown;

let counter = 1;
const defaultAnswer: FakeAnswer = (r) => (r.method === "send" ? { timestamp: 1_000_000 + counter++ } : {});

/**
 * A fake signal-cli daemon on a free local port. Default answers: `send` gets a fresh timestamp, everything else `{}`.
 * @example
 * const d = await FakeSignalDaemon.start();
 * const client = new SignalClient({ host: d.host, port: d.port, account: "+10000000000" });
 * await client.connect();
 * await client.send("hi");
 * d.requests[0].params; // { noteToSelf: true, message: "hi" }
 */
export class FakeSignalDaemon {
  readonly requests: FakeRequest[] = [];
  readonly host = "127.0.0.1";
  port = 0;
  answer: FakeAnswer;
  private sockets = new Set<net.Socket>();
  private server: net.Server;
  private watchers = new Set<() => void>();

  private constructor(answer: FakeAnswer) {
    this.answer = answer;
    this.server = net.createServer((s) => this.onConnection(s));
  }

  /** Listens on a free port of 127.0.0.1. `answer` decides each reply (see {@link FakeAnswer}). */
  static async start(answer: FakeAnswer = defaultAnswer): Promise<FakeSignalDaemon> {
    const d = new FakeSignalDaemon(answer);
    await new Promise<void>((resolve) => d.server.listen(0, d.host, resolve));
    d.port = (d.server.address() as net.AddressInfo).port;
    return d;
  }

  private onConnection(s: net.Socket) {
    this.sockets.add(s);
    this.watchers.forEach((w) => w());
    s.setEncoding("utf8");
    let buf = "";
    s.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as FakeRequest;
        this.requests.push(req);
        const result = this.answer(req);
        if (result !== undefined) this.reply(req.id, result);
      }
    });
    s.on("error", () => {});
    s.on("close", () => (this.sockets.delete(s), this.watchers.forEach((w) => w())));
  }

  /**
   * Number of clients connected right now. A client's `connect()` resolves slightly before the server sees it:
   * wait for this to be above 0 before pushing.
   */
  get connections(): number {
    return this.sockets.size;
  }

  /**
   * Resolves as soon as the number of connected clients satisfies the test, checked on every connect and disconnect (no polling, no timer):
   * `await d.whenConnections((n) => n > 0)` before pushing, `(n) => n === 0` to know a client is gone.
   */
  whenConnections(test: (count: number) => boolean): Promise<void> {
    return new Promise((resolve) => {
      let settling = false;
      const check = () => {
        if (settling || !test(this.sockets.size)) return;
        settling = true;
        // The adapter probes the port with a short connection before it makes its real one, and that probe alone can satisfy `n > 0`: a message pushed
        // to it is lost. So the answer counts only if it still holds after the connection events already waiting have been handled (two event-loop turns,
        // no timer); if it does not, the watcher stays and the next connect or disconnect asks again.
        setImmediate(() =>
          setImmediate(() => {
            settling = false;
            if (!test(this.sockets.size)) return;
            this.watchers.delete(check);
            resolve();
          }),
        );
      };
      this.watchers.add(check);
      check();
    });
  }

  /** Answers a request (by id) with a result or a {@link FakeRpcError}. */
  reply(id: number, result: unknown) {
    const body = result instanceof FakeRpcError ? { error: { code: -1, message: result.message } } : { result };
    this.raw(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  }

  /** Pushes a "receive" notification carrying this signal-cli envelope. */
  push(envelope: object) {
    this.raw(JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope } }) + "\n");
  }

  /** Writes bytes as they are: for split lines, several lines in one chunk, or garbage. */
  raw(text: string) {
    for (const s of this.sockets) s.write(text);
  }

  /** Hangs up on every client but keeps listening. */
  dropConnections() {
    for (const s of this.sockets) s.destroy();
  }

  /** Resets every connection (the client sees ECONNRESET, a socket error, then the close). */
  resetConnections() {
    for (const s of this.sockets) s.resetAndDestroy();
  }

  /** Hangs up and stops listening. */
  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
