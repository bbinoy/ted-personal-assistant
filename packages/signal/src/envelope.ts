import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_AUDIO_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_LONG_TEXT_BYTES, type AudioRef, type FileRef, type ImageRef, type IncomingDeletion, type IncomingMessage, type IncomingReaction, type LongTextRef, type Quote } from "@ted-assistant/messenger";

// The types of what comes in (IncomingMessage, Quote, ...) and the size limits are the Messenger interface's (packages/messenger): the same
// objects reach the app as signal-cli reports them here. Re-exported so this package's own API is unchanged.
export { MAX_AUDIO_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_LONG_TEXT_BYTES };
export type { AudioRef, FileRef, ImageRef, IncomingDeletion, IncomingMessage, IncomingReaction, LongTextRef, Quote };

// The pure half of the Signal client: the small types of our own and the functions that turn what signal-cli reports into them
// (testable without any network). client.ts is the connection.
//   interpretEnvelope  a "receive" notification -> a message (also an edited one), a reaction or a remote delete
// Two modes, picked by the constructor options of the client (see README): Note to Self, or the bot's own account.

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

/** Signal's content type for the full text of a long message. */
export const LONG_TEXT_TYPE = "text/x-signal-plain";
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
