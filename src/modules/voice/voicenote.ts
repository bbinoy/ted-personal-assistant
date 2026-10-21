import { readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "../../core/state.ts";
import { convIdOfKey, convPaths, type ConvId } from "../../core/convpaths.ts";

// The voice notes received in each conversation (the owner's chat, each friend and each group on its own: voices/sources.json in the conversation's folder), so the voice tool can build a cloned voice from
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

// One file per conversation, so nothing is shared across conversations: a lookup cannot cross them because it never reads another one's file.
export interface Store {
  notes: VoiceNote[];
  quotes: Record<string, number>; // a message's timestamp -> the voice note it replies to
}

const fileOf = (conv: ConvId): string => convPaths(conv).voiceSources;
const cache = new Map<ConvId, Store>(); // (a handful of conversations; each file is small)
const load = (key: string): Store => {
  const conv = convIdOfKey(key);
  const hit = cache.get(conv);
  if (hit) return hit;
  let s: Store = { notes: [], quotes: {} };
  try {
    const raw = JSON.parse(readFileSync(fileOf(conv), "utf8")) as Partial<Store>;
    s = { notes: Array.isArray(raw.notes) ? raw.notes : [], quotes: raw.quotes && typeof raw.quotes === "object" ? raw.quotes : {} };
  } catch {
    // none yet, or damaged: start empty
  }
  cache.set(conv, s);
  return s;
};
const save = (key: string): void => {
  try {
    const conv = convIdOfKey(key);
    writeFileAtomic(fileOf(conv), JSON.stringify(cache.get(conv)));
  } catch {
    // a note not remembered across a restart is only a note to send again
  }
};

/** Tests: forget everything held in memory (the files are read again). */
export const resetVoiceNotes = (): void => void cache.clear();

/** A voice note arrived in conversation `key`. */
export function holdVoiceNote(key: string, n: VoiceNote, now = Date.now()): void {
  const s = load(key);
  s.notes = [...s.notes.filter((x) => x.ts !== n.ts && now - x.ts < MAX_AGE_MS), n].slice(-NOTES_PER_CONVERSATION);
  save(key);
}

/** A message in conversation `key` replies to a voice note. */
export function holdQuote(key: string, messageTs: number, quotedTs: number): void {
  const q = load(key).quotes;
  q[String(messageTs)] = quotedTs;
  const keys = Object.keys(q);
  if (keys.length > NOTES_PER_CONVERSATION * 2) for (const k of keys.slice(0, keys.length - NOTES_PER_CONVERSATION * 2)) delete q[k];
  save(key);
}

/** The voice notes of a conversation that are still in the look-back, newest first. */
export function voiceNotes(key: string, now = Date.now()): VoiceNote[] {
  return load(key).notes.filter((x) => now - x.ts < MAX_AGE_MS).sort((a, b) => b.ts - a.ts);
}

/** One voice note of THIS conversation by its id (timestamp), if it is in the look-back. */
export const voiceNote = (key: string, ts: number, now = Date.now()): VoiceNote | undefined => voiceNotes(key, now).find((x) => x.ts === ts);

/** The voice note a message replies to, if it is one received in this conversation. */
export function quotedVoiceNote(key: string, messageTs: number, now = Date.now()): VoiceNote | undefined {
  const q = load(key).quotes[String(messageTs)];
  return q === undefined ? undefined : voiceNote(key, q, now);
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
  let ids: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(fileOf(conv), "utf8")) as Partial<Store>;
    ids = (Array.isArray(raw.notes) ? raw.notes : []).map((n) => n.id).filter((i): i is string => typeof i === "string");
  } catch { /* none, or damaged: nothing to name */ }
  cache.delete(conv);
  rmSync(fileOf(conv), { force: true });
  return ids;
}
