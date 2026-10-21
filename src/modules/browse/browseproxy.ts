import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, isIP, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { ALLOWED_PORTS, dnsResolver, isPublicAddress, type Resolver } from "./browserules.ts";

// The egress filter of a browse run: a small forward proxy on 127.0.0.1 (an ephemeral port) that the run's browser is started with. Every connection the browser
// makes (the first page, a redirect, a link, a script, an image, a websocket) comes here as CONNECT host:port or as a plain http request, and THIS code resolves the
// host, refuses the whole connection if ANY answer is not a public address (isPublicAddress: private, loopback, link-local, CGNAT, ULA, mapped, NAT64 ...) and
// connects to the very IP it checked, so there is no second lookup to rebind. Only the ports the browse rules allow pass. It is an application-level egress
// filter in this process, not OS isolation: the browser could still reach out some other way a bug of its own opens (docs/SAFETY.md says so).

export interface EgressProxy {
  readonly port: number;
  refused: { host: string; why: string }[]; // what was turned away, newest last (capped)
  close(): Promise<void>;
}
export interface ProxyOptions {
  resolve?: Resolver; // injectable for tests
  connect?: (ip: string, port: number) => Socket; // injectable for tests
  ports?: readonly number[];
  onRefuse?: (host: string, why: string) => void;
}

const MAX_REFUSED = 50;
const MAX_HEADER_BYTES = 8_192; // the request headers forwarded upstream
const HOP = new Set(["connection", "proxy-connection", "proxy-authorization", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

// Pure. host and port of a CONNECT target ("example.com:443", "[2001:db8::1]:443").
export function parseTarget(t: string): { host: string; port: number } | undefined {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(t) ?? /^([^:\[\]\s]+):(\d{1,5})$/.exec(t);
  if (!m) return undefined;
  return { host: m[1]!.toLowerCase().replace(/\.$/, ""), port: Number(m[2]) };
}

// The IPs to connect to for this host, all of them public, or why not. An IP literal is judged as it is, a name by what it resolves to now.
export async function publicAddresses(host: string, resolve: Resolver): Promise<string[] | { problem: string }> {
  if (isIP(host)) return isPublicAddress(host) ? [host] : { problem: "not a public address" };
  let ips: string[];
  try {
    ips = await resolve(host);
  } catch {
    return { problem: "the name does not resolve" };
  }
  if (!ips.length) return { problem: "the name does not resolve" };
  if (!ips.every(isPublicAddress)) return { problem: "the name points to a private address" };
  return ips;
}

export async function startEgressProxy(o: ProxyOptions = {}): Promise<EgressProxy> {
  const resolve = o.resolve ?? dnsResolver;
  const connect = o.connect ?? ((ip: string, port: number) => netConnect({ host: ip, port }));
  const ports = new Set(o.ports ?? ALLOWED_PORTS);
  const refused: EgressProxy["refused"] = [];
  const sockets = new Set<Duplex>();
  const refuse = (host: string, why: string) => {
    if (refused.length >= MAX_REFUSED) refused.shift();
    refused.push({ host: host.slice(0, 100), why });
    o.onRefuse?.(host, why);
  };
  // Resolve, check, and open a connection to the first checked IP that answers. Returns the socket or the refusal.
  const open = async (host: string, port: number): Promise<{ sock: Socket } | { status: number; why: string }> => {
    if (!ports.has(port)) return refuse(host, `port ${port} is not allowed`), { status: 403, why: "port not allowed" };
    const ips = await publicAddresses(host, resolve);
    if ("problem" in ips) return refuse(host, ips.problem), { status: ips.problem === "the name does not resolve" ? 502 : 403, why: ips.problem };
    let last = "unreachable";
    for (const ip of ips) {
      try {
        const sock = await new Promise<Socket>((ok, fail) => {
          const s = connect(ip, port);
          s.once("connect", () => (s.removeListener("error", fail), ok(s)));
          s.once("error", fail);
        });
        return { sock };
      } catch (e) {
        last = (e as Error).message;
      }
    }
    return { status: 502, why: last };
  };

  const server: Server = createServer();
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  server.on("connect", async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    const t = parseTarget(req.url ?? "");
    if (!t) return void client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    const r = await open(t.host, t.port);
    if ("status" in r) return void client.end(`HTTP/1.1 ${r.status} ${r.status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Length: 0\r\n\r\n`);
    const up = r.sock;
    sockets.add(up);
    up.on("close", () => sockets.delete(up));
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  server.on("upgrade", (_req, client: Duplex) => client.end("HTTP/1.1 501 Not Implemented\r\n\r\n")); // a websocket goes through CONNECT; an upgrade on a plain request is not carried
  // A plain http request: the browser sends the absolute address. The same checks, then the request goes to the checked IP with the original Host.
  server.on("request", async (req, res) => {
    let u: URL;
    try {
      u = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (u.protocol !== "http:") return void res.writeHead(400).end();
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    const port = u.port ? Number(u.port) : 80;
    const r = await open(host, port); // (the same resolve-check-connect as a tunnel)
    if ("status" in r) return void res.writeHead(r.status).end();
    // Written as bytes on the checked connection (no http client: it would follow the environment's proxy settings). One request per connection, then it closes.
    const headers = Object.entries(req.headers).filter(([k]) => !HOP.has(k) && !k.startsWith("proxy-")).map(([k, v]) => `${k}: ${[v].flat().join(", ")}\r\n`).join("");
    if (headers.length > MAX_HEADER_BYTES) return (r.sock.destroy(), void res.writeHead(431).end());
    const up = r.sock;
    sockets.add(up);
    up.on("close", () => sockets.delete(up));
    const client = req.socket;
    // One request per connection: the upstream says "connection: close", so when it ends the pipe ends the client connection too (the browser reconnects for its next request).
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    up.write(`${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n${headers}connection: close\r\n\r\n`);
    req.pipe(up, { end: false });
    up.pipe(client);
  });

  await new Promise<void>((ok, fail) => (server.once("error", fail), server.listen(0, "127.0.0.1", ok)));
  return {
    port: (server.address() as AddressInfo).port,
    refused,
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}
