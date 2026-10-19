import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The pure half of the Signal client: the small types of our own and the functions that turn what signal-cli reports into them
// (testable without any network). client.ts is the connection.
//   interpretEnvelope  a "receive" notification -> a message (also an edited one), a reaction or a remote delete
// Two modes, picked by the constructor options of the client (see README): Note to Self, or the bot's own account.

/** The message a reply points at (Signal's "reply" / quote). */
export interface Quote {
  /** The quoted text. */
  text: string;
  /** Who wrote the quoted message (number or account id). */
  author: string;
  /** Timestamp of the quoted message. */
  timestamp: number;
}

/**
 * What the client keeps from a signal-cli "receive" notification. Text, quotes and names are untrusted input from
 * whoever wrote them; who may talk to your bot is for you to decide.
 */
export interface IncomingMessage {
  /** Sender's number (the peer's number in own-account mode when the sender is the peer). */
  from: string;
  /** The text, with @mentions written out as `@name`. Empty for an attachment-only message. */
  text: string;
  /** Signal's timestamp, which doubles as the message id. */
  timestamp: number;
  /** A private one-to-one conversation with the bot (Note to Self, or its own chat); never a group. */
  direct: boolean;
  /** The sender's account id, when Signal gives it (also for the peer's own messages and Note to Self). */
  fromUuid?: string;
  /** The sender's own profile name, when Signal gives it (groups, and one-to-one messages from someone other than the peer). */
  fromName?: string;
  /** Own-account mode only: a private one-to-one message from someone OTHER than the peer (not a group). `from` is their number (empty if Signal hides it) and `fromUuid` their account id. Who may talk to your bot is still for you to decide. */
  other?: boolean;
  /** Set when the message was written in a group (own-account mode only). */
  group?: { id: string };
  /** Group messages: it @mentions the bot or replies to one of its messages. */
  addressedToMe?: boolean;
  /** Set when the message is a reply to an earlier one. */
  quote?: Quote;
  /** The message replies to a voice note: that voice note's timestamp (look it up among the voice notes received in this conversation). */
  quotedAudio?: number;
  /** A voice message or audio file (the first one); resolve its file with {@link attachmentPath}. */
  audio?: AudioRef;
  /** A picture (the first one; `text` is its caption, possibly empty); resolve its file with {@link attachmentPath}. */
  image?: ImageRef;
  /** Any other file (the first one that is neither a picture nor audio): a PDF, a text file, a zip... Its type is for the caller to decide from the bytes; resolve its file with {@link attachmentPath}. */
  file?: FileRef;
  /**
   * The full text of a LONG message: Signal apps send text over about 2000 characters as a cut body plus an attachment of type
   * `text/x-signal-plain` that holds all of it. Never a {@link file}; read it with {@link readLongText} and use it in place of `text`.
   */
  longText?: LongTextRef;
  /**
   * Set when this is an EDIT: `text` is the new text, `timestamp` the edit's own timestamp, and `targetTimestamp` the
   * timestamp of the message it replaces (the original's, or an earlier edit's: Signal clients differ). An edit is
   * untrusted like any message and Signal only lets the original author send one, but nothing here checks that: compare
   * the sender with the original's author before you apply it. Audio and pictures are not carried over (edits are text only here).
   */
  edited?: { targetTimestamp: number };
}

/** Somebody deleted a message for everyone ("remote delete"). */
export interface IncomingDeletion {
  /** Who deleted it. Signal only honours the author, but nothing here checks: compare with the original's author. */
  from: string;
  /** Timestamp of the message that was deleted (the original's, or the latest edit's). */
  targetTimestamp: number;
  /** As {@link IncomingMessage.direct}. */
  direct: boolean;
  /** Set when it happened in a group. */
  group?: { id: string };
  fromUuid?: string;
  fromName?: string;
  /** As {@link IncomingMessage.other}. */
  other?: boolean;
}

/** A voice note or audio file signal-cli has downloaded: its id names the file in its attachments folder. */
export interface AudioRef {
  id: string;
  size: number;
}

/** Audio attachments larger than this (bytes) are not surfaced. */
export const MAX_AUDIO_BYTES = 25_000_000;

/** A picture signal-cli has downloaded, named like an audio file. */
export interface ImageRef {
  id: string;
  size: number;
}

/** Pictures larger than this (bytes) are not surfaced. */
export const MAX_IMAGE_BYTES = 20_000_000;

/** Other files larger than this (bytes) are not read; the sender is told. Pairs with LIMITS.textFile in src/sanitize.ts (the part of a text file shown to the model). */
export const MAX_FILE_BYTES = 20_000_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

/** Any other file signal-cli has downloaded. `name` is the file name the sender gave: untrusted text, shorter than 200 characters, never a path. */
export interface FileRef {
  id: string;
  size: number;
  name?: string;
  /** The sender's client said it is audio (an MP3, M4A...). Only a hint, for deciding whether to open it at all: the bytes decide. */
  audio?: true;
}

/** The attachment that holds the whole text of a long message (the sender's file name is ignored). */
export interface LongTextRef {
  id: string;
  size: number;
}

/** Signal's content type for the full text of a long message. */
export const LONG_TEXT_TYPE = "text/x-signal-plain";
/** The most of a long message that is read (bytes); the rest is cut. Pairs with LIMITS.message in src/sanitize.ts (70,000 characters: this plus the note), which must stay above it. */
export const MAX_LONG_TEXT_BYTES = 64 * 1024;
const isLongTextType = (a: any) => String(a?.contentType ?? "").split(";")[0]!.trim().toLowerCase() === LONG_TEXT_TYPE;

const MAX_FILE_NAME = 200; // a file name is a label; pairs with LIMITS.preview in src/sanitize.ts

// An attachment id becomes a file name, so only plain names pass (no path separators, nothing hidden).
const safeId = (id: string) => /^[\w.-]{1,100}$/.test(id) && !id.startsWith(".");

/** signal-cli's folder of downloaded attachments: `$XDG_DATA_HOME` or `~/.local/share`, plus `signal-cli/attachments`. */
export function defaultAttachmentsDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "signal-cli/attachments");
}

/**
 * The file signal-cli saved for an attachment: `dir` joined with the id, after checking the id is a plain file name.
 * The content type came from the sender and the bytes are not checked here; do not follow symlinks out of `dir`.
 * @param ref an `m.audio` or `m.image`
 * @param dir signal-cli's attachments folder (default: {@link defaultAttachmentsDir})
 * @throws if the id is anything but a plain name (a path, hidden, too long)
 */
export function attachmentPath(ref: { id: string }, dir: string = defaultAttachmentsDir()): string {
  if (!safeId(ref.id)) throw new Error("not a plain attachment id");
  return join(dir, ref.id);
}

/**
 * Pure: the first usable picture among signal-cli's attachments, with the same rules as {@link parseAudio}. Videos
 * and other files are skipped; whether the bytes really are a picture is for the caller to check when it reads them.
 */
export function parseImage(attachments: unknown): ImageRef | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    const id = typeof a?.id === "string" ? a.id : "";
    const size = Number(a?.size ?? 0);
    if (!IMAGE_TYPES.includes(String(a?.contentType ?? "").toLowerCase()) || !safeId(id)) continue;
    if (size > 0 && size <= MAX_IMAGE_BYTES) return { id, size };
  }
  return undefined;
}

/** Pure: the long-message attachment (`text/x-signal-plain`) among signal-cli's attachments, with a plain id and a size. */
export function parseLongText(attachments: unknown): LongTextRef | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    const id = typeof a?.id === "string" ? a.id : "";
    const size = Number(a?.size ?? 0);
    if (isLongTextType(a) && safeId(id) && size > 0) return { id, size };
  }
  return undefined;
}

/**
 * The text of a long-message attachment, read from signal-cli's folder: only a plain file there (no symlink), at most
 * {@link MAX_LONG_TEXT_BYTES} bytes, strict UTF-8 without NUL. `cut` says the file was longer. Undefined when it is missing or
 * is not text (the content type came from the sender, the bytes decide). Never throws; the text is untrusted like any message.
 */
export function readLongText(ref: { id: string }, dir: string = defaultAttachmentsDir()): { text: string; cut: boolean } | undefined {
  let fd: number | undefined;
  try {
    const file = attachmentPath(ref, dir);
    if (!lstatSync(file).isFile()) return undefined;
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, MAX_LONG_TEXT_BYTES + 3));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const cut = size > MAX_LONG_TEXT_BYTES;
    const bytes = buf.subarray(0, Math.min(n, MAX_LONG_TEXT_BYTES));
    if (!bytes.length || bytes.includes(0)) return undefined;
    for (let drop = 0; drop <= (cut ? 3 : 0); drop++) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - drop)).replace(/^﻿/, "");
        return text.trim() ? { text, cut } : undefined;
      } catch {
        // a character split at the cut: try again without it
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Pure: the first attachment that is not a picture or audio (those have their own parsers), with a plain id and a size. The
 * content type is not consulted beyond that: the caller decides what the bytes are. Any size is surfaced, so the caller can
 * tell the sender when a file is too large; it must check the size again when it reads the file.
 */
export function parseFile(attachments: unknown): FileRef | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    const id = typeof a?.id === "string" ? a.id : "";
    const size = Number(a?.size ?? 0);
    const type = String(a?.contentType ?? "").toLowerCase();
    const name = typeof a?.filename === "string" && a.filename ? a.filename.slice(0, MAX_FILE_NAME) : undefined;
    if (isLongTextType(a)) continue; // the body of a long message, never a file
    // Audio WITH a file name is an audio file someone sent (an MP3...), which goes the way of other files; audio without one is a recorded voice message.
    if (IMAGE_TYPES.includes(type) || (type.startsWith("audio/") && !name) || !safeId(id) || !(size > 0)) continue;
    return { id, size, ...(name ? { name } : {}), ...(type.startsWith("audio/") ? { audio: true as const } : {}) };
  }
  return undefined;
}

/**
 * Pure: the first usable audio attachment among signal-cli's attachments. The id becomes a file name, so only plain
 * names pass (no path separators), and files over {@link MAX_AUDIO_BYTES} are refused.
 */
export function parseAudio(attachments: unknown): AudioRef | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    const id = typeof a?.id === "string" ? a.id : "";
    const size = Number(a?.size ?? 0);
    if (!String(a?.contentType ?? "").startsWith("audio/") || !safeId(id) || (typeof a?.filename === "string" && a.filename)) continue; // a named one is an audio file: parseFile
    if (size > 0 && size <= MAX_AUDIO_BYTES) return { id, size };
  }
  return undefined;
}

/** Pure: signal-cli's `quote` object -> ours. Undefined when there is nothing to show (a quote of an attachment-only message has no text). */
export function parseQuote(raw: any): Quote | undefined {
  const text = typeof raw?.text === "string" ? raw.text.trim() : "";
  if (!text) return undefined;
  return { text, author: String(raw.authorNumber ?? raw.author ?? ""), timestamp: Number(raw.id ?? 0) };
}

/** Pure: the timestamp of the voice note a reply quotes (signal-cli lists the quoted message's attachments), else undefined. */
export function quotedAudio(raw: any): number | undefined {
  const id = Number(raw?.id);
  const has = Array.isArray(raw?.attachments) && raw.attachments.some((a: any) => String(a?.contentType ?? "").startsWith("audio/"));
  return has && Number.isFinite(id) && id > 0 ? id : undefined;
}

/** An emoji reaction somebody added to (or removed from) a message. */
export interface IncomingReaction {
  /** Who reacted. */
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
  /** Set when the reaction was made in a group. */
  group?: { id: string };
  fromUuid?: string;
  fromName?: string;
  /** As {@link IncomingMessage.other}. */
  other?: boolean;
}



/** Pure: a message's text with each mention (Signal puts a placeholder character there) written as `@name`. */
export function withMentions(text: string, mentions: unknown, fallback = "someone"): string {
  const list = (Array.isArray(mentions) ? mentions : []).filter((m) => Number.isInteger(m?.start)).sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of list) if (out[m.start] === "\uFFFC") out = `${out.slice(0, m.start)}@${String(m.name ?? fallback)}${out.slice(m.start + 1)}`;
  return out;
}

/** Which conversation an envelope is read for. */
export interface Channel {
  /** The signal-cli account we run as. */
  account: string;
  /** Set: the bot has its OWN account and talks to this person (peer mode). Unset: Note to Self (self mode). */
  peer?: string;
  /** The peer's account id, for when Signal hides their number from us. */
  peerAci?: string;
}

/**
 * Pure: what a signal-cli "receive" envelope means for us. In self mode we are the owner's linked device, and the
 * owner's messages in Note to Self arrive as something THEY sent from another device. In peer mode we are our own
 * account, and the owner's messages arrive as ordinary incoming ones; a sender is the peer only if their number (or
 * account id) matches, and groups are never direct. Nothing here authenticates anybody beyond that.
 */
export function interpretEnvelope(env: any, ch: Channel): { message?: IncomingMessage; reaction?: IncomingReaction; deletion?: IncomingDeletion } {
  if (!env) return {};
  // signal-cli reports an edit as `editMessage: { targetSentTimestamp, dataMessage }` on the envelope, and the owner's own edit
  // on another device as `syncMessage.sentMessage.editMessage` (same shape; the sentMessage's own message fields are then empty).
  const edit = env.editMessage ?? env.syncMessage?.sentMessage?.editMessage;
  const data = env.dataMessage ?? env.editMessage?.dataMessage;
  const sent = env.syncMessage?.sentMessage; // something WE did on another device (self mode: the phone)
  const number = env.sourceNumber ?? env.source ?? "";

  let from = number;
  let direct: boolean;
  let body = data;
  let other = false; // own-account mode: someone other than the peer wrote to us privately
  if (ch.peer !== undefined) {
    const isPeer = !!ch.peer && (number === ch.peer || (!!ch.peerAci && env.sourceUuid === ch.peerAci));
    from = isPeer ? ch.peer : number;
    direct = isPeer && !!data && !data.groupInfo;
    other = !isPeer && !!data && !data.groupInfo;
  } else {
    const toSelf = !!sent && (sent.destinationNumber ?? sent.destination) === ch.account;
    direct = toSelf;
    body = data ?? sent?.editMessage?.dataMessage ?? sent;
    if (data) direct = false; // a message from someone else
  }
  if (!body) return {};
  // A group (own-account mode only; in Note to Self every group message is someone else's and ignored).
  const group = ch.peer !== undefined && data?.groupInfo?.groupId ? { id: String(data.groupInfo.groupId) } : undefined;
  if (data?.groupInfo && !group) return {};
  const who = other ? { other: true as const, fromUuid: env.sourceUuid || undefined, fromName: env.sourceName || undefined } : direct && env.sourceUuid ? { fromUuid: String(env.sourceUuid) } : {}; // a private message from someone else: who she is; from the peer or in Note to Self: her account id, when Signal gives it (the app learns the owner's from it)

  // An edit that does not say what it edits is dropped, not taken for a new message; its body is text only.
  const target = Number(edit?.targetSentTimestamp);
  if (edit && !(target > 0)) return {};
  if (!edit && body.remoteDelete) {
    const d = body.remoteDelete; // `targetTimestamp`; older signal-cli versions called it `timestamp`
    const targetTimestamp = Number(d.targetTimestamp ?? d.timestamp ?? 0);
    if (!(targetTimestamp > 0)) return {};
    return { deletion: { from, targetTimestamp, direct, ...who, ...(group ? { group, fromUuid: env.sourceUuid, fromName: env.sourceName || undefined } : {}) } };
  }
  if (!edit && body.reaction) {
    const r = body.reaction;
    return {
      reaction: {
        from,
        emoji: String(r.emoji ?? ""),
        targetTimestamp: Number(r.targetSentTimestamp ?? 0),
        isRemove: Boolean(r.isRemove),
        direct,
        targetAuthor: r.targetAuthorNumber ?? r.targetAuthor ?? undefined,
        ...who,
        ...(group ? { group, fromUuid: env.sourceUuid, fromName: env.sourceName || undefined } : {}),
      },
    };
  }
  const audio = edit ? undefined : parseAudio(body.attachments);
  const image = edit ? undefined : parseImage(body.attachments);
  const file = edit || audio || image ? undefined : parseFile(body.attachments);
  const longText = parseLongText(body.attachments); // also in an edit: the new text of a long message
  if (!body.message && !audio && !image && !file && !longText) return {};
  const quote = parseQuote(body.quote);
  const mentioned = (Array.isArray(body.mentions) ? body.mentions : []).some((m: any) => m?.uuid === ch.account || m?.number === ch.account);
  return {
    message: {
      from,
      text: withMentions(body.message ?? "", body.mentions),
      timestamp: body.timestamp ?? edit?.dataMessage?.timestamp ?? env.timestamp,
      direct,
      ...who,
      quote,
      ...(quotedAudio(body.quote) ? { quotedAudio: quotedAudio(body.quote) } : {}),
      audio,
      ...(image ? { image } : {}),
      ...(file ? { file } : {}),
      ...(longText ? { longText } : {}),
      ...(edit ? { edited: { targetTimestamp: target } } : {}),
      ...(group ? { group, addressedToMe: mentioned || quote?.author === ch.account, fromUuid: env.sourceUuid, fromName: env.sourceName || undefined } : {}),
    },
  };
}
