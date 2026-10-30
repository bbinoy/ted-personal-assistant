import net from "node:net";
import { silentLogger, type Logger } from "./logger.ts";
import { interpretEnvelope, type IncomingDeletion, type IncomingMessage, type IncomingReaction, type Quote } from "./envelope.ts";

// The Signal client: a JSON-RPC 2.0 connection to a running `signal-cli daemon` (one JSON object per line over
// TCP): receive, send, react, read receipts, typing, group list. What signal-cli reports is interpreted by envelope.ts.

/** Why the connection ended. */
export interface CloseInfo {
  /** True when {@link SignalClient.close} was called; false when signal-cli went away or the socket failed. */
  requested: boolean;
  /** The socket error behind an unrequested close, if there was one. */
  error?: Error;
}

const ATTACHMENT_TIMEOUT_FACTOR = 4;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024; // a group list with hundreds of groups is a few MB; an envelope is a few KB

/** Options of {@link SignalClient}. */
export interface SignalClientOptions {
  /** Where signal-cli's daemon listens (JSON-RPC over TCP; there is no unix-socket or stdio support). */
  host: string;
  port: number;
  /**
   * Who signal-cli runs as (a number or an account id). Without `peer`, that is the owner's own account: the client
   * is a linked device and talks in Note to Self. With `peer`, it is the bot's own account.
   */
  account: string;
  /** Set: `account` is the bot's OWN account and `peer` is the person it talks to (`aci`: their account id, for when Signal hides their number). */
  peer?: { number: string; aci?: string };
  /** Where warnings go. Default: nowhere ({@link silentLogger}). */
  logger?: Logger;
  /** How long a request may wait for its answer, in ms (default 30 000). */
  rpcTimeoutMs?: number;
  /** How long {@link SignalClient.isOwnReaction} remembers a reaction the client sent, in ms (default 300 000). */
  ownReactionMs?: number;
  /** The longest line (one JSON message) the client will buffer before it hangs up, in characters (default 16 777 216). */
  maxLineChars?: number;
}

/** What {@link SignalClient.send} can carry besides the text. */
export interface SendOptions {
  /** signal-cli text styles like `"0:5:BOLD"` (start:length:STYLE). */
  style?: string[];
  /** Thread the message under an earlier one. */
  quote?: Quote;
  /** Absolute paths of files signal-cli can read. An audio file is shown as a voice message. */
  attachments?: string[];
  /** Mark the audio attachments as voice notes: shown inline in the chat, with no file name above the player (signal-cli's `--voice-note`). */
  voiceNote?: boolean;
  /** Send to this group instead of the default conversation (own-account mode). A target made by {@link toPerson} sends to that one person instead. */
  groupId?: string;
}

/** A conversation target for one person other than the peer (own-account mode): pass it wherever a `groupId` is taken. Group ids never contain a colon. */
export const toPerson = (id: string): string => `to:${id}`;
/** The person (number or account id) a target made by {@link toPerson} names, or undefined for a group id. */
export const personOf = (target?: string): string | undefined => (target?.startsWith("to:") ? target.slice(3) : undefined);
// signal-cli's address of a conversation: a group, a person, or (neither) the default one.
const addressOf = (target: string | undefined, dflt: () => object): object => (personOf(target) ? { recipient: [personOf(target)] } : target ? { groupId: target } : dflt());

/** A group the account is a member of. */
export interface SignalGroup {
  id: string;
  name: string;
  /** Members by phone number and/or account id, whichever Signal gives. */
  members: { number?: string; uuid?: string }[];
}

/**
 * A minimal JSON-RPC 2.0 client for signal-cli's TCP daemon (one JSON object per line in both directions).
 * Create it, register handlers, then {@link connect}. It never exits the process and installs no process handlers;
 * see {@link onClose}. There is one handler slot per kind: registering again replaces the previous handler.
 * Everything it receives is trusted to come from signal-cli; it does not decide who may talk to your bot.
 */
export class SignalClient {
  private socket: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handler: ((m: IncomingMessage) => void) | undefined;
  private reactionHandler: ((r: IncomingReaction) => void) | undefined;
  private deletionHandler: ((d: IncomingDeletion) => void) | undefined;
  private closeHandler: ((info: CloseInfo) => void) | undefined;
  private closed = false;
  private closeRequested = false;
  private lastError: Error | undefined;

  // Reactions WE sent come back as incoming reactions (in Note to Self they look exactly like the
  // owner's own). Remembered for a few minutes so isOwnReaction can tell them apart.
  private ownReactions = new Map<string, number>();

  private host: string;
  private port: number;
  private account: string;
  private peer: string | undefined;
  private peerAci: string | undefined;
  private log: Logger;
  private rpcTimeoutMs: number;
  private ownReactionMs: number;
  private maxLineChars: number;

  constructor(opts: SignalClientOptions) {
    this.log = opts.logger ?? silentLogger;
    this.host = opts.host;
    this.port = opts.port;
    this.account = opts.account;
    this.peer = opts.peer?.number;
    this.peerAci = opts.peer?.aci;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 30_000;
    this.ownReactionMs = opts.ownReactionMs ?? 5 * 60_000;
    this.maxLineChars = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  }

  /**
   * The groups this account is a member of, with who is in them.
   * @throws if signal-cli answers with an error or does not answer in time
   */
  async groups(): Promise<SignalGroup[]> {
    const list = await this.call<any[]>("listGroups", {});
    return (Array.isArray(list) ? list : [])
      .filter((g) => g?.isMember !== false)
      .map((g) => ({
        id: String(g.id ?? ""),
        name: String(g.name ?? ""),
        members: (Array.isArray(g.members) ? g.members : []).map((x: any) => (typeof x === "string" ? { number: x, uuid: x } : { number: x?.number ?? undefined, uuid: x?.uuid ?? undefined })),
      }));
  }

  // Where our messages go: the recipient in peer mode, our own Note to Self otherwise.
  private to(): object {
    return this.peer ? { recipient: [this.peer] } : { noteToSelf: true };
  }

  /** True in own-account mode (a `peer` was given), false in Note to Self mode. */
  get separateAccount(): boolean {
    return this.peer !== undefined;
  }

  /**
   * Tells the person we have read their message (the "seen" check under it). Own-account mode only; in Note to Self
   * there is nobody else to tell. Best effort: a failure is logged, never thrown.
   * @param timestamp the message's timestamp
   * @param from the message's author (default: the peer); in a group the receipt goes to whoever wrote it, not to the group
   */
  async markRead(timestamp: number, from?: string): Promise<void> {
    if (!this.peer) return;
    try {
      // sendReceipt takes one recipient string, not a list like send does.
      await this.call("sendReceipt", { recipient: from || this.peer, targetTimestamp: [timestamp], type: "read" });
    } catch (e) {
      this.log.warn("read receipt failed:", (e as Error).message);
    }
  }

  /**
   * Shows or clears "typing…" in the chat. Only does something in own-account mode (Signal does not show it in Note
   * to Self). Best effort: never throws.
   * @param stop true to clear the indicator
   * @param groupId type in this group instead of the peer's chat
   */
  async typing(stop = false, groupId?: string): Promise<void> {
    if (!this.peer) return;
    try {
      await this.call("sendTyping", { ...addressOf(groupId, () => ({ recipient: [this.peer] })), ...(stop ? { stop: true } : {}) });
    } catch {
      /* best effort */
    }
  }

  /** Sets the handler for incoming messages (replaces the previous one). Register it before {@link connect}. */
  onMessage(handler: (m: IncomingMessage) => void) {
    this.handler = handler;
  }

  /**
   * Whether a reaction is one this client sent itself (it comes back as an incoming reaction, and in Note to Self it
   * looks exactly like the owner's own). Remembered for `ownReactionMs`.
   */
  isOwnReaction(r: { emoji: string; targetTimestamp: number }): boolean {
    const key = `${r.targetTimestamp}:${r.emoji}`;
    const expires = this.ownReactions.get(key) ?? 0;
    for (const [k, e] of this.ownReactions) if (e < Date.now()) this.ownReactions.delete(k);
    return expires > Date.now();
  }

  /** Sets the handler for incoming reactions (replaces the previous one). */
  onReaction(handler: (r: IncomingReaction) => void) {
    this.reactionHandler = handler;
  }

  /** Sets the handler for messages deleted for everyone (replaces the previous one). */
  onDelete(handler: (d: IncomingDeletion) => void) {
    this.deletionHandler = handler;
  }

  /**
   * Sets the handler called once when the connection ends, whether by {@link close}, by signal-cli going away or by a
   * socket error. There is no reconnect: the host decides (exit and let a supervisor restart it, or build a new client).
   */
  onClose(handler: (info: CloseInfo) => void) {
    this.closeHandler = handler;
  }

  /** Ends the connection on purpose. Requests still waiting are rejected. Safe to call twice. */
  close() {
    this.closeRequested = true;
    this.socket?.destroy();
  }

  /**
   * Opens the connection to the daemon.
   * @throws if it cannot connect (nothing listening on host:port)
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      this.socket = socket;
      this.closed = false;
      this.closeRequested = false;
      let connected = false;
      socket.setEncoding("utf8");
      socket.once("connect", () => ((connected = true), resolve()));
      // Before connecting, an error rejects connect(); after, it is logged and the "close" that follows is reported.
      socket.on("error", (e) => {
        this.lastError = e;
        if (connected) this.log.error("signal socket error:", e.message);
        else reject(e);
      });
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.on("close", () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error("socket closed"));
        this.pending.clear();
        if (connected) this.closeHandler?.({ requested: this.closeRequested, error: this.closeRequested ? undefined : this.lastError });
      });
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
    // One JSON object per line: a "line" that never ends is not signal-cli. End the connection instead of growing without limit.
    if (this.buffer.length > this.maxLineChars) {
      this.log.error(`signal-cli sent more than ${this.maxLineChars} characters without a line break; closing the connection`);
      this.buffer = "";
      this.socket?.destroy(new Error("line too long"));
    }
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn("unparseable line from signal-cli");
      return;
    }
    // A response to one of our requests.
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
      else p.resolve(msg.result);
      return;
    }
    // A pushed notification.
    if (msg.method === "receive") this.onEnvelope(msg.params?.envelope);
  }

  private onEnvelope(env: any) {
    const { message, reaction, deletion } = interpretEnvelope(env, { account: this.account, peer: this.peer, peerAci: this.peerAci });
    if (reaction) this.reactionHandler?.(reaction);
    else if (deletion) this.deletionHandler?.(deletion);
    else if (message) this.handler?.(message);
  }

  private call<T = any>(method: string, params: object, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    if (!this.socket || this.closed) return Promise.reject(new Error(this.socket ? "SignalClient is closed" : "SignalClient is not connected: call connect() first"));
    const socket = this.socket;
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`signal ${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      socket.write(line);
    });
  }

  /**
   * Reacts to a message with an emoji. A new reaction from us on the same message replaces the previous one, so this
   * doubles as a status indicator. Best effort: a failed reaction is logged, never thrown.
   * @param target the message reacted to
   * @param groupId set when the message is in a group
   */
  async react(emoji: string, target: { author: string; timestamp: number }, groupId?: string): Promise<void> {
    this.ownReactions.set(`${target.timestamp}:${emoji}`, Date.now() + this.ownReactionMs);
    try {
      await this.call("sendReaction", {
        ...addressOf(groupId, () => this.to()),
        emoji,
        targetAuthor: target.author,
        targetTimestamp: target.timestamp,
      });
    } catch (e) {
      this.log.warn(`reaction ${emoji} failed:`, (e as Error).message);
    }
  }

  /**
   * Sends a message: to our own Note to Self, or (own-account mode) to the peer, or to a group.
   * @returns the sent message's timestamp (use it to ignore our own echo when it syncs back, and to match reactions)
   * @throws if signal-cli refuses (bad attachment path, unknown group, ...) or does not answer in time
   */
  async send(text: string, opts: SendOptions = {}): Promise<number> {
    const { style: textStyle = [], quote } = opts;
    // An upload (voice note, picture, document) takes longer than text: it gets ATTACHMENT_TIMEOUT_FACTOR times the plain timeout.
    const timeoutMs = opts.attachments?.length ? this.rpcTimeoutMs * ATTACHMENT_TIMEOUT_FACTOR : this.rpcTimeoutMs;
    const result = await this.call<{ timestamp: number }>("send", {
      ...addressOf(opts.groupId, () => this.to()),
      ...(text ? { message: text } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts.voiceNote ? { voiceNote: true } : {}),
      ...(textStyle.length ? { textStyle } : {}),
      ...(quote ? { quoteTimestamp: quote.timestamp, quoteAuthor: quote.author, quoteMessage: quote.text } : {}),
    }, timeoutMs);
    return result.timestamp;
  }

  /**
   * Sends one message to somebody the account has not talked to: by phone number ("+15555550114") or by username ("name.42"; signal-cli's `username` parameter).
   * @returns the timestamp and, when signal-cli reports it, the recipient's account id (the first result's `recipientAddress.uuid`)
   * @throws if signal-cli refuses (unknown number or username, ...) or does not answer in time
   */
  async sendFirst(text: string, recipient: string): Promise<{ timestamp: number; accountId?: string }> {
    const result = await this.call<{ timestamp: number; results?: { recipientAddress?: { uuid?: unknown } }[] }>("send", {
      ...(recipient.startsWith("+") ? { recipient: [recipient] } : { username: [recipient] }),
      message: text,
    });
    const uuid = result.results?.[0]?.recipientAddress?.uuid;
    return { timestamp: result.timestamp, ...(typeof uuid === "string" && uuid ? { accountId: uuid.toLowerCase() } : {}) };
  }
}
