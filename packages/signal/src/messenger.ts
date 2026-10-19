import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import {
  directOf,
  type CloseInfo,
  type DoctorLine,
  type GroupInfo,
  type IncomingDeletion,
  type IncomingMessage,
  type IncomingReaction,
  type MessageRef,
  type Messenger,
  type MessengerCapabilities,
  type MessengerConfig,
  type OutgoingMessage,
  type Target,
  type TextStyle,
} from "@ted-personal-assistant/messenger";
import { SignalClient, toPerson } from "./client.ts";
import { ensureSignalDaemon, type DaemonOptions, type SignalDaemon } from "./daemon.ts";
import { attachmentPath, readLongText } from "./envelope.ts";

// Entry point "./messenger": Signal as a Messenger (packages/messenger), the way the assistant app uses it (MESSENGER=signal). Everything
// Signal-specific the app used to do itself lives here: the signal-cli daemon, the client and its two modes, the attachments folder,
// the text style format, person targets, the doctor's checks.
//
// Two modes, from the config: the account is the owner's own number (the assistant is her linked device and talks in Note to Self: no
// typing, no receipts, nobody else can write to it), or its own account (a normal chat with her, groups, friends, voice messages).
//
// Options (MessengerConfig.options): host, port (where the signal-cli daemon listens), attachmentsDir (where signal-cli saves attachments).

const text = (options: MessengerConfig["options"], key: string): string => {
  const v = options[key];
  if (typeof v !== "string" || !v) throw new Error(`signal: option ${key} is missing`);
  return v;
};
const port = (options: MessengerConfig["options"]): number => {
  const v = options.port;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65_535) throw new Error("signal: option port must be a port number");
  return v;
};

/** signal-cli's text style strings ("start:length:STYLE") for styled ranges. */
export const toSignalStyles = (styles: readonly TextStyle[]): string[] => styles.map((s) => `${s.start}:${s.length}:${s.style}`);

// signal-cli addresses a conversation by group id, or by "to:<account>" for one person.
const addressOf = (target: Target): string | undefined => {
  const person = directOf(target);
  return person ? toPerson(person) : target;
};

class SignalMessenger implements Messenger {
  readonly name = "signal";
  readonly summary: string;
  readonly self: string;
  readonly capabilities: MessengerCapabilities;

  #client: SignalClient;
  #daemonOptions: DaemonOptions;
  #config: MessengerConfig;
  #attachmentsDir: string;
  #daemon: SignalDaemon | undefined;
  #closeHandler: ((info: CloseInfo) => void) | undefined;
  #stopping = false;

  constructor(config: MessengerConfig) {
    const host = text(config.options, "host");
    const separate = config.account !== config.owner.address;
    this.#config = config;
    this.#attachmentsDir = text(config.options, "attachmentsDir");
    this.self = config.account;
    this.summary = separate ? "own account" : "Note to Self";
    this.#client = new SignalClient({
      host,
      port: port(config.options),
      account: config.account,
      peer: separate ? { number: config.owner.address, aci: config.owner.id } : undefined,
      logger: config.logger,
    });
    this.#daemonOptions = { account: config.account, host, port: port(config.options), logger: config.logger };
    // Note to Self shows no typing, no receipts and has nobody else in it; a voice message of ours would come back as the owner's own.
    this.capabilities = { reactions: true, typing: separate, readReceipts: separate, groups: separate, people: separate, voice: separate, quotes: true, voiceFormat: "m4a" };
  }

  async start(): Promise<void> {
    this.#stopping = false;
    const logFd = this.#config.openLog?.("signal-daemon.log");
    const daemon = (this.#daemon = await ensureSignalDaemon({ ...this.#daemonOptions, logFd }));
    void daemon.exited.then(({ code, signal }) => this.#closed(`signal-cli exited (code=${code} signal=${signal})`));
    this.#client.onClose(({ error }) => this.#closed(`signal socket closed${error ? ` (${error.message})` : ""}`));
    await this.#client.connect();
  }

  stop(): void {
    this.#stopping = true; // our own stop is not a lost connection
    this.#client.close();
    this.#daemon?.stop();
  }

  #closed(reason: string): void {
    if (!this.#stopping) this.#closeHandler?.({ reason });
  }

  onClose(handler: (info: CloseInfo) => void): void {
    this.#closeHandler = handler;
  }
  onMessage(handler: (m: IncomingMessage) => void): void {
    this.#client.onMessage(handler);
  }
  onReaction(handler: (r: IncomingReaction) => void): void {
    // Our own status icons come back as reactions (in Note to Self they look exactly like the owner's own): they are not delivered.
    this.#client.onReaction((r) => (this.#client.isOwnReaction(r) ? undefined : handler(r)));
  }
  onDeletion(handler: (d: IncomingDeletion) => void): void {
    this.#client.onDelete(handler);
  }

  send(target: Target, m: OutgoingMessage): Promise<number> {
    const files = m.attachments?.map((a) => a.file) ?? [];
    return this.#client.send(m.text, {
      style: toSignalStyles(m.styles ?? []),
      quote: m.quote,
      ...(files.length ? { attachments: files } : {}),
      ...(m.attachments?.some((a) => a.kind === "voice") ? { voiceNote: true } : {}),
      ...(target ? { groupId: addressOf(target) } : {}),
    });
  }
  react(target: Target, message: MessageRef, emoji: string): Promise<void> {
    return this.#client.react(emoji, message, addressOf(target));
  }
  typing(target: Target, on: boolean): Promise<void> {
    return this.#client.typing(!on, addressOf(target));
  }
  markRead(_target: Target, message: { timestamp: number; author?: string }): Promise<void> {
    return this.#client.markRead(message.timestamp, message.author);
  }
  groups(): Promise<GroupInfo[]> {
    return this.#client.groups();
  }
  async attachmentFile(ref: { id: string }): Promise<string> {
    return attachmentPath(ref, this.#attachmentsDir);
  }
  async readLongText(ref: { id: string }): Promise<{ text: string; cut: boolean } | undefined> {
    return readLongText(ref, this.#attachmentsDir);
  }
}

/** The Signal messenger. Nothing is started or connected until {@link Messenger.start}. @throws if the options are not usable */
export async function createMessenger(config: MessengerConfig): Promise<Messenger> {
  return new SignalMessenger(config);
}

const run = (cmd: string, args: string[]): string | undefined => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
};

/** What `npm run doctor` says about Signal: the mode, signal-cli installed and linked, the daemon reachable. */
export async function doctor(config: { account?: string; options: MessengerConfig["options"] }): Promise<DoctorLine[]> {
  const host = text(config.options, "host");
  const p = port(config.options);
  const lines: DoctorLine[] = [];
  lines.push({ ok: true, what: "Signal channel", detail: config.account ? "the assistant's own account (its own chat)" : "Note to Self (optional: docs/SIGNAL-ACCOUNT.md gives the assistant its own account and name)" });
  const version = run("signal-cli", ["--version"]);
  lines.push({ ok: !!version, what: "signal-cli installed", detail: version });
  const accounts = await readFile(`${process.env.HOME}/.local/share/signal-cli/data/accounts.json`, "utf8").catch(() => "");
  lines.push({ ok: /"number"/.test(accounts), what: "a Signal account is linked to signal-cli" });
  const up = await new Promise<boolean>((resolve) => {
    const s = net.connect(p, host);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
  lines.push({ ok: up ? true : "warn", what: `Signal daemon reachable on ${host}:${p}`, detail: up ? "" : "only running while the agent is" });
  return lines;
}
