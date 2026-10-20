// The Messenger interface: everything the assistant needs from a chat platform, and nothing about any one of them.
//
// The app (src/) talks to ONE Messenger. A platform package (packages/signal, later telegram, whatsapp, slack) implements it and maps
// to and from its own protocol; the app never sees an envelope, a phone number format or a platform call. Which one runs is
// MESSENGER=<name> (default signal), loaded by name with loadMessenger.
//
// Four ideas carry the whole interface:
//   conversation  a Target: an opaque string. undefined is the owner's own chat; a group id is a group; directTarget(id) is one other
//                 person's private chat. The app never builds or parses anything else.
//   sender        who wrote something: `from` (the address the platform shows, may be empty) and `fromUuid` (the stable account id, when
//                 the platform gives one). Who the OWNER is stays the app's decision (guards.ts, tenants.ts); the messenger only reports.
//   message       one message, by its timestamp (a number that is unique within the conversation and doubles as the id).
//   capability    what the platform cannot do is declared, never faked, so the app degrades quietly (no reactions: no status icons).

// ---- addressing ----

/** Where a message goes or came from. undefined: the owner's own chat. Otherwise opaque to the app: a group id, or a {@link directTarget}. */
export type Target = string | undefined;

const DIRECT = "to:";

/** The target of one person's private chat (not the owner's), from her stable account id. Platform packages never produce a group id that starts like this. */
export const directTarget = (id: string): string => `${DIRECT}${id}`;
/** The account id a {@link directTarget} names, or undefined for the owner's chat or a group. */
export const directOf = (target: Target): string | undefined => (target?.startsWith(DIRECT) ? target.slice(DIRECT.length) : undefined);

// ---- what comes in ----

/** The message a reply points at. */
export interface Quote {
  /** The quoted text. */
  text: string;
  /** Who wrote the quoted message (as {@link Messenger.self} or {@link IncomingMessage.from} would name them). */
  author: string;
  /** Timestamp of the quoted message. */
  timestamp: number;
}

/** A voice message or audio recording the platform holds: resolve its file with {@link Messenger.attachmentFile}. */
export interface AudioRef {
  id: string;
  size: number;
}
/** A picture, like an {@link AudioRef}. */
export interface ImageRef {
  id: string;
  size: number;
}
/** Any other file (a PDF, a text file, an audio file with a name...). `name` is the sender's file name: untrusted text, shorter than 200 characters, never a path. */
export interface FileRef {
  id: string;
  size: number;
  name?: string;
  /** The platform says it is audio (an MP3, M4A...). Only a hint for deciding whether to open it at all: the bytes decide. */
  audio?: true;
}
/** The attachment that holds the whole text of a long message: read it with {@link Messenger.readLongText}. */
export interface LongTextRef {
  id: string;
  size: number;
}

/** Audio attachments larger than this (bytes) are not surfaced. */
export const MAX_AUDIO_BYTES = 25_000_000;
/** Pictures larger than this (bytes) are not surfaced. */
export const MAX_IMAGE_BYTES = 20_000_000;
/** Other files larger than this (bytes) are not read; the sender is told. Pairs with LIMITS.textFile in src/sanitize.ts. */
export const MAX_FILE_BYTES = 20_000_000;
/** The most of a long message that is read (bytes); the rest is cut. Pairs with LIMITS.message in src/sanitize.ts, which must stay above it. */
export const MAX_LONG_TEXT_BYTES = 64 * 1024;

/**
 * What the messenger reports of a message. Text, quotes and names are untrusted input from whoever wrote them; who may talk to the
 * assistant is for the app to decide.
 */
export interface IncomingMessage {
  /** The sender's address as the platform shows it (Signal: a phone number). Empty when the platform hides it. */
  from: string;
  /** The text, with @mentions written out as `@name`. Empty for an attachment-only message. */
  text: string;
  /** The message's timestamp, which doubles as its id. */
  timestamp: number;
  /** A private one-to-one conversation with the assistant (the owner's own chat); never a group. */
  direct: boolean;
  /** The sender's stable account id, when the platform gives one (also for the owner's own messages). */
  fromUuid?: string;
  /** The sender's own profile name, when the platform gives it (groups, and private messages from someone other than the owner). */
  fromName?: string;
  /** A private one-to-one message from someone OTHER than the owner (not a group). `from` and `fromUuid` name them. Only on platforms where other people can write to the assistant ({@link MessengerCapabilities.people}). */
  other?: boolean;
  /** Set when the message was written in a group. */
  group?: { id: string };
  /** Group messages: it @mentions the assistant or replies to one of its messages. */
  addressedToMe?: boolean;
  /** Set when the message is a reply to an earlier one. */
  quote?: Quote;
  /** The message replies to a voice note: that voice note's timestamp. */
  quotedAudio?: number;
  /** A voice message or audio file (the first one). */
  audio?: AudioRef;
  /** A picture (the first one; `text` is its caption, possibly empty). */
  image?: ImageRef;
  /** Any other file (the first one that is neither a picture nor audio). */
  file?: FileRef;
  /**
   * The full text of a LONG message that arrived as a cut body plus an attachment holding all of it. Never a {@link file}; read it with
   * {@link Messenger.readLongText} and use it in place of `text`. Platforms that deliver long text whole never set it.
   */
  longText?: LongTextRef;
  /**
   * Set when this is an EDIT: `text` is the new text, `timestamp` the edit's own timestamp, and `targetTimestamp` the timestamp of the
   * message it replaces. An edit is untrusted like any message: compare the sender with the original's author before applying it.
   */
  edited?: { targetTimestamp: number };
}

/** Somebody deleted a message for everyone. */
export interface IncomingDeletion {
  /** Who deleted it. Compare with the original's author. */
  from: string;
  /** Timestamp of the message that was deleted (the original's, or the latest edit's). */
  targetTimestamp: number;
  /** As {@link IncomingMessage.direct}. */
  direct: boolean;
  group?: { id: string };
  fromUuid?: string;
  fromName?: string;
  /** As {@link IncomingMessage.other}. */
  other?: boolean;
}

/** An emoji reaction somebody added to (or removed from) a message. Reactions the messenger itself sent are never delivered. */
export interface IncomingReaction {
  from: string;
  emoji: string;
  /** Timestamp of the message that was reacted to. */
  targetTimestamp: number;
  /** True when the reaction was taken away again. */
  isRemove: boolean;
  /** As {@link IncomingMessage.direct}. */
  direct: boolean;
  /** Who wrote the message that was reacted to. */
  targetAuthor?: string;
  group?: { id: string };
  fromUuid?: string;
  fromName?: string;
  /** As {@link IncomingMessage.other}. */
  other?: boolean;
}

// ---- what goes out ----

/** A styled range of a text, in UTF-16 code units (JavaScript string indices). */
export interface TextStyle {
  start: number;
  length: number;
  style: "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE";
}

/** A file to send: a voice message (shown as one where the platform has them), a picture, or any other file. `file` is an absolute local path. */
export interface OutgoingAttachment {
  file: string;
  kind: "voice" | "picture" | "file";
}

export interface OutgoingMessage {
  /** The text; may be empty when there is an attachment. */
  text: string;
  /** Styled ranges of `text`. */
  styles?: TextStyle[];
  /** Thread the message under an earlier one. Ignored where {@link MessengerCapabilities.quotes} is false. */
  quote?: Quote;
  attachments?: OutgoingAttachment[];
}

/** A message in a conversation, as a reaction names it. */
export interface MessageRef {
  /** Who wrote it (as {@link IncomingMessage.from} names them, or {@link Messenger.self}). */
  author: string;
  timestamp: number;
}

/** A group the assistant is a member of. */
export interface GroupInfo {
  id: string;
  name: string;
  /** Members by address (`number`) and/or stable account id (`uuid`), whichever the platform gives. */
  members: { number?: string; uuid?: string }[];
}

// ---- capabilities ----

/** The audio a voice message is sent as. The app asks its speech engine for this format; the engine's last step (ffmpeg) is chosen from it. */
export type VoiceFormat = "m4a" | "ogg-opus";

/** What the platform can do. Declared honestly; the app leaves out what is not there instead of failing. */
export interface MessengerCapabilities {
  /** Emoji reactions can be sent. Without them: no status icons, no reaction answers. */
  reactions: boolean;
  /** "typing…" is shown to the other side. Without it, working / done icons (reactions) stand in. */
  typing: boolean;
  /** Read receipts can be sent. */
  readReceipts: boolean;
  /** The assistant can take part in group conversations. */
  groups: boolean;
  /** Other people than the owner can write to the assistant privately (needed for friends / tenants). */
  people: boolean;
  /** Voice messages can be sent without confusing the conversation (on Signal's Note to Self a voice message of ours would come back as the owner's own). */
  voice: boolean;
  /** A message can be threaded under an earlier one. */
  quotes: boolean;
  /** The longest text the platform takes as ONE message, in UTF-8 bytes; longer text is sent as several. Unset: no limit the app needs to care about (the platform handles long text itself). */
  maxMessageBytes?: number;
  /** The audio format voice messages are sent in. */
  voiceFormat: VoiceFormat;
}

// ---- the messenger ----

/** Why the connection ended; the app exits and lets its supervisor restart it. */
export interface CloseInfo {
  reason: string;
}

/**
 * What the assistant needs from a chat platform. Implementations never exit the process, install no process handlers and write nothing to
 * the console except through the logger they were given. One handler slot per kind: registering again replaces the previous one.
 */
export interface Messenger {
  /** The platform's name, as MESSENGER= names it. */
  readonly name: string;
  /** One phrase for the start-up log, e.g. "own account" or "Note to Self". */
  readonly summary: string;
  /** Who the assistant is as an author: what a quote or a reaction names when it points at the assistant's own message. */
  readonly self: string;
  readonly capabilities: MessengerCapabilities;

  /** Brings the platform up (starts what must run, connects). Register the handlers first. @throws if it cannot */
  start(): Promise<void>;
  /** Takes down what {@link start} started. Safe to call twice and from an exit handler. */
  stop(): void;
  /** Called once when the connection ends, on purpose or not. There is no reconnect: the app decides. */
  onClose(handler: (info: CloseInfo) => void): void;

  onMessage(handler: (m: IncomingMessage) => void): void;
  /** Reactions of other people (and the owner's own); never the ones this messenger sent. */
  onReaction(handler: (r: IncomingReaction) => void): void;
  onDeletion(handler: (d: IncomingDeletion) => void): void;

  /**
   * Sends one message to a conversation.
   * @returns the sent message's timestamp (to recognise its echo and to match reactions)
   * @throws if the platform refuses
   */
  send(target: Target, message: OutgoingMessage): Promise<number>;
  /** Reacts to a message with an emoji; a new reaction of ours on the same message replaces the earlier one. Best effort: never throws. */
  react(target: Target, message: MessageRef, emoji: string): Promise<void>;
  /** Shows or clears "typing…". Best effort: never throws. */
  typing(target: Target, on: boolean): Promise<void>;
  /** Tells the author of a message that it was read. `message.author` is unset in the owner's chat. Best effort: never throws. */
  markRead(target: Target, message: { timestamp: number; author?: string }): Promise<void>;
  /** The groups the assistant is a member of, with their members. @throws if the platform does not answer */
  groups(): Promise<GroupInfo[]>;

  /** The local file of an attachment (a picture, voice message, file). The file is the messenger's: read it, never delete it. @throws if the reference is not a plain one */
  attachmentFile(ref: { id: string }): Promise<string>;
  /** The text of a long message's attachment: at most {@link MAX_LONG_TEXT_BYTES} bytes, `cut` when it was longer. Undefined when it cannot be read. Never throws. */
  readLongText(ref: { id: string }): Promise<{ text: string; cut: boolean } | undefined>;
}

// ---- loading a platform ----

/** One line of `npm run doctor`. */
export interface DoctorLine {
  ok: boolean | "warn";
  what: string;
  detail?: string;
}

/** Where a platform's helper programs write their output: opens a log file (by file name) for appending and returns its file descriptor. */
export type OpenLog = (file: string) => number;

/** What the app gives a platform package. Platform-specific values travel in `options`. */
export interface MessengerConfig {
  /** The owner on this platform: how she is addressed (Signal: her phone number) and her stable account id if known. */
  owner: { address: string; id?: string };
  /** The account the assistant runs as. Equal to the owner's address: the assistant is a linked device in her own chat; otherwise its own account. */
  account: string;
  /**
   * Platform settings read from the environment by the app (host, port, folders). The interface does not know their shape: each platform package exports the type of its own
   * (Signal: `SignalOptions`) and checks what it is given when the messenger is made, throwing a sentence that names the option.
   */
  options: unknown;
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  openLog?: OpenLog;
}

/** What a platform package exports as `@ted-personal-assistant/<name>/messenger`. */
export interface MessengerModule {
  createMessenger(config: MessengerConfig): Promise<Messenger>;
  /** The platform's lines for the doctor: what must be installed and reachable. Needs no running app; `account` is unset when the owner's own account is used. */
  doctor(config: { account?: string; options: unknown }): Promise<DoctorLine[]>;
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * Loads the platform package of that name (`@ted-personal-assistant/<name>/messenger`) with a dynamic import, so only the chosen
 * platform is ever loaded.
 * @throws a sentence the owner can act on if the name is not a valid one or the package is not installed
 */
export async function loadMessengerModule(name: string): Promise<MessengerModule> {
  if (!NAME.test(name)) throw new Error(`MESSENGER must be a platform name such as signal (got "${name.slice(0, 40)}")`);
  const specifier = `@ted-personal-assistant/${name}/messenger`;
  let mod: Partial<MessengerModule>;
  try {
    mod = (await import(specifier)) as Partial<MessengerModule>;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") throw new Error(`MESSENGER=${name}: the package is not installed (npm install -w packages/${name})`);
    throw e;
  }
  if (typeof mod.createMessenger !== "function" || typeof mod.doctor !== "function") throw new Error(`MESSENGER=${name}: ${specifier} does not export createMessenger and doctor`);
  return { createMessenger: mod.createMessenger, doctor: mod.doctor };
}

/** {@link loadMessengerModule}, then creates the messenger. */
export async function loadMessenger(name: string, config: MessengerConfig): Promise<Messenger> {
  return (await loadMessengerModule(name)).createMessenger(config);
}
