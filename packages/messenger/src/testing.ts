import type { CloseInfo, GroupInfo, IncomingDeletion, IncomingMessage, IncomingReaction, MessageRef, Messenger, MessengerCapabilities, OutgoingMessage, Target } from "./index.ts";

// Entry point "./testing": a Messenger that talks to nothing. It records what the app does (sends, reactions, typing, read receipts) and
// lets a test push what a platform would deliver. The app's tests run on it, and so does every platform package's contract test.

/** Capabilities of a platform that can do everything the app uses (what Signal's own-account mode offers). */
export const FULL_CAPABILITIES: MessengerCapabilities = { reactions: true, typing: true, readReceipts: true, groups: true, people: true, voice: true, quotes: true, voiceFormat: "m4a" };

export class FakeMessenger implements Messenger {
  readonly name = "fake";
  readonly summary = "fake";
  self = "+10000000001";
  capabilities: MessengerCapabilities;

  readonly sent: { target: Target; message: OutgoingMessage; timestamp: number }[] = [];
  readonly reactions: { target: Target; message: MessageRef; emoji: string }[] = [];
  readonly typings: { target: Target; on: boolean }[] = [];
  readonly reads: { target: Target; timestamp: number; author?: string }[] = [];
  groupList: GroupInfo[] = [];
  started = false;
  stopped = false;
  /** Set to make {@link send} fail with this error. */
  sendError: Error | undefined;
  /** Files by attachment id, for {@link attachmentFile} and {@link readLongText}. */
  files = new Map<string, string>();
  longTexts = new Map<string, { text: string; cut: boolean }>();

  private nextTimestamp = 1000;
  private message: ((m: IncomingMessage) => void) | undefined;
  private reaction: ((r: IncomingReaction) => void) | undefined;
  private deletion: ((d: IncomingDeletion) => void) | undefined;
  private close: ((info: CloseInfo) => void) | undefined;

  constructor(capabilities: Partial<MessengerCapabilities> = {}) {
    this.capabilities = { ...FULL_CAPABILITIES, ...capabilities };
  }

  async start(): Promise<void> {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  onClose(handler: (info: CloseInfo) => void): void {
    this.close = handler;
  }
  onMessage(handler: (m: IncomingMessage) => void): void {
    this.message = handler;
  }
  onReaction(handler: (r: IncomingReaction) => void): void {
    this.reaction = handler;
  }
  onDeletion(handler: (d: IncomingDeletion) => void): void {
    this.deletion = handler;
  }

  async send(target: Target, message: OutgoingMessage): Promise<number> {
    if (this.sendError) throw this.sendError;
    const timestamp = ++this.nextTimestamp;
    this.sent.push({ target, message, timestamp });
    return timestamp;
  }
  async react(target: Target, message: MessageRef, emoji: string): Promise<void> {
    this.reactions.push({ target, message, emoji });
  }
  async typing(target: Target, on: boolean): Promise<void> {
    this.typings.push({ target, on });
  }
  async markRead(target: Target, message: { timestamp: number; author?: string }): Promise<void> {
    this.reads.push({ target, ...message });
  }
  async groups(): Promise<GroupInfo[]> {
    return this.groupList;
  }
  async attachmentFile(ref: { id: string }): Promise<string> {
    const file = this.files.get(ref.id);
    if (!file) throw new Error("not a plain attachment id");
    return file;
  }
  async readLongText(ref: { id: string }): Promise<{ text: string; cut: boolean } | undefined> {
    return this.longTexts.get(ref.id);
  }

  /** What a platform would deliver. Each throws if no handler is registered, so a test cannot push into the void. */
  pushMessage(m: IncomingMessage): void {
    if (!this.message) throw new Error("no onMessage handler");
    this.message(m);
  }
  pushReaction(r: IncomingReaction): void {
    if (!this.reaction) throw new Error("no onReaction handler");
    this.reaction(r);
  }
  pushDeletion(d: IncomingDeletion): void {
    if (!this.deletion) throw new Error("no onDeletion handler");
    this.deletion(d);
  }
  /** The connection ends. */
  pushClose(reason = "closed"): void {
    this.close?.({ reason });
  }
}
