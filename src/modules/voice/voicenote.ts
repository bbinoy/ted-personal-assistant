import { convDb, hasConvDb } from "../../core/convdb.ts";
import { convIdOfKey, type ConvId } from "../../core/convpaths.ts";
import type { Db } from "../../core/db.ts";

// The voice notes received in each conversation (the owner's chat, each friend and each group on its own: in the conversation's own assistant.db), so the voice tool can build a cloned voice from
// one of them. Audio FILES that contain speech (an MP3 someone sent) are kept in the same list, marked kind "file". Only the attachment id is kept (signal-cli's file name; the file is found by joining it to the attachments folder, voice.ts
// does the same for transcription), the sender, the time and a short snippet of the transcript for the model to recognise it by.
// The audio itself is not copied. Bounded: the last NOTES_PER_CONVERSATION notes of a conversation, none older than MAX_AGE_MS (a note
// outside that is not offered and not used). A note belongs to the conversation it arrived in: a lookup never crosses conversations.

export const NOTES_PER_CONVERSATION = 50;
export const MAX_AGE_MS = 7 * 24 * 3_600_000;

export interface VoiceNote {
  ts: number; // the voice message's timestamp: its id in the conversation
  id: string; // attachment id (a plain file name; resolved to its file by the messenger)
  size: number;
  by: string; // sender's Signal id
  byName?: string;
  snippet: string; // the start of the transcript: data from the sender
  kind?: "voice" | "file"; // a recorded voice message (default) or an audio file the sender attached
  name?: string; // file: its (sanitised) name
  seconds?: number; // file: its length
}

// The tables `voice_notes` and `voice_quotes` of the conversation's own assistant.db (core/convdb.ts), so nothing is shared across conversations: a lookup cannot cross them because it has no connection to another one's rows.
interface NoteRow {
  ts: number;
  id: string;
  size: number;
  by: string;
  by_name: string | null;
  snippet: string;
  kind: string | null;
  name: string | null;
  seconds: number | null;
}
const COLS = "ts, id, size, by, by_name, snippet, kind, name, seconds";
const noteOf = (r: NoteRow): VoiceNote => ({
  ts: r.ts,
  id: r.id,
  size: r.size,
  by: r.by,
  ...(r.by_name !== null ? { byName: r.by_name } : {}),
  snippet: r.snippet,
  ...(r.kind === "voice" || r.kind === "file" ? { kind: r.kind } : {}),
  ...(r.name !== null ? { name: r.name } : {}),
  ...(r.seconds !== null ? { seconds: r.seconds } : {}),
});
const db = (key: string) => convDb(convIdOfKey(key));

/** Tests: the state used to be cached in memory and read again from its file; it is always read from the database now, so there is nothing to forget. */
export const resetVoiceNotes = (): void => undefined;

/** A voice note arrived in conversation `key`. */
export function holdVoiceNote(key: string, n: VoiceNote, now = Date.now()): void {
  const d = db(key);
  d.tx(() => {
    d.run("DELETE FROM voice_notes WHERE ts = ? OR ? - ts >= ?", n.ts, now, MAX_AGE_MS);
    d.run(`INSERT INTO voice_notes (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, n.ts, n.id, n.size ?? 0, n.by ?? "", n.byName ?? null, n.snippet ?? "", n.kind ?? null, n.name ?? null, n.seconds ?? null);
    d.run("DELETE FROM voice_notes WHERE seq IN (SELECT seq FROM voice_notes ORDER BY seq DESC LIMIT -1 OFFSET ?)", NOTES_PER_CONVERSATION);
  });
}

/** A message in conversation `key` replies to a voice note. */
export function holdQuote(key: string, messageTs: number, quotedTs: number): void {
  const d = db(key);
  d.tx(() => {
    d.run("INSERT INTO voice_quotes (message_ts, quoted_ts) VALUES (?, ?) ON CONFLICT (message_ts) DO UPDATE SET quoted_ts = excluded.quoted_ts", messageTs, quotedTs); // (an update keeps its place)
    d.run("DELETE FROM voice_quotes WHERE seq IN (SELECT seq FROM voice_quotes ORDER BY seq DESC LIMIT -1 OFFSET ?)", NOTES_PER_CONVERSATION * 2);
  });
}

/** The voice notes of a conversation that are still in the look-back, newest first. */
export function voiceNotes(key: string, now = Date.now()): VoiceNote[] {
  return db(key).all<NoteRow>(`SELECT ${COLS} FROM voice_notes WHERE ? - ts < ? ORDER BY ts DESC`, now, MAX_AGE_MS).map(noteOf);
}

/** One voice note of THIS conversation by its id (timestamp), if it is in the look-back. */
export const voiceNote = (key: string, ts: number, now = Date.now()): VoiceNote | undefined => voiceNotes(key, now).find((x) => x.ts === ts);

/** The voice note a message replies to, if it is one received in this conversation. */
export function quotedVoiceNote(key: string, messageTs: number, now = Date.now()): VoiceNote | undefined {
  const q = db(key).get<{ quoted_ts: number }>("SELECT quoted_ts FROM voice_quotes WHERE message_ts = ?", messageTs)?.quoted_ts;
  return q === undefined ? undefined : voiceNote(key, q, now);
}

/** Retention (heartbeat/convretention.ts): notes outside the look-back are neither offered nor used, so they go; and the bounds hold. Returns how many went (`dryRun`: how many would). */
export function pruneVoiceNotes(d: Db, now: number, dryRun = false): number {
  const old = d.num("SELECT COUNT(*) FROM voice_notes WHERE ? - ts >= ?", now, MAX_AGE_MS);
  const overN = Math.max(0, d.num("SELECT COUNT(*) FROM voice_notes WHERE ? - ts < ?", now, MAX_AGE_MS) - NOTES_PER_CONVERSATION);
  const overQ = Math.max(0, d.num("SELECT COUNT(*) FROM voice_quotes") - NOTES_PER_CONVERSATION * 2);
  if (dryRun) return old + overN + overQ;
  d.tx(() => {
    d.run("DELETE FROM voice_notes WHERE ? - ts >= ?", now, MAX_AGE_MS);
    d.run("DELETE FROM voice_notes WHERE seq IN (SELECT seq FROM voice_notes ORDER BY seq DESC LIMIT -1 OFFSET ?)", NOTES_PER_CONVERSATION);
    d.run("DELETE FROM voice_quotes WHERE seq IN (SELECT seq FROM voice_quotes ORDER BY seq DESC LIMIT -1 OFFSET ?)", NOTES_PER_CONVERSATION * 2);
  });
  return old + overN + overQ;
}

// Who is asking in the running turn of a conversation: the message being answered. Set around the turn (withSend), so the tool knows
// whose request it is (to record the requester, to let them delete their voice) and which message to take the default source from.
export interface Asking {
  author?: string;
  authorName?: string;
  timestamp?: number;
  owner: boolean; // the owner is asking (always in the owner's chat)
}
const asking = new Map<string, Asking>();
const names = new Map<string, string>(); // "key|sender" -> display name, memory only
export function rememberSender(key: string, id: string | undefined, name: string | undefined): void {
  if (!id || !name) return;
  names.set(`${key}|${id}`, name);
  if (names.size > 500) names.delete(names.keys().next().value!);
}
export const setAsking = (key: string, a: Asking | undefined): void => void (a ? asking.set(key, { ...a, authorName: a.authorName ?? (a.author ? names.get(`${key}|${a.author}`) : undefined) }) : asking.delete(key));
export const askingIn = (key: string): Asking | undefined => asking.get(key);

/** A removed friend (or group): everything held for conversation `key`. Returns the attachment ids of its notes, so their files can go too. Idempotent (the folder goes with the conversation; this is for the part that is read before it is deleted). */
export const forgetConversation = (key: string): string[] => forgetConvId(convIdOfKey(key));
/** The same by the conversation's folder name (a group's raw id is not known to the one who forgets it). */
export function forgetConvId(conv: ConvId): string[] {
  if (!hasConvDb(conv)) return []; // (nothing to read, and a forgotten conversation must not get a database made for it)
  const d = convDb(conv);
  return d.tx(() => {
    const ids = d.all<{ id: string }>("SELECT id FROM voice_notes").map((r) => r.id);
    d.run("DELETE FROM voice_notes");
    d.run("DELETE FROM voice_quotes");
    return ids;
  });
}
