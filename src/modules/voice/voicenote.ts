import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { settings } from "../../core/settings.ts";

// The voice notes received in each conversation (the owner's chat, and each group on its own), so the voice tool can build a cloned voice from
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

interface Store {
  notes: Record<string, VoiceNote[]>; // by conversation key (OWNER_KEY or a group id)
  quotes: Record<string, Record<string, number>>; // by conversation: a message's timestamp -> the voice note it replies to
}

const fileOf = () => join(settings.stateDir, "voice", "sources.json");
let cache: Store | undefined;
const load = (): Store => {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(fileOf(), "utf8")) as Store;
    cache.notes ??= {};
    cache.quotes ??= {};
  } catch {
    cache = { notes: {}, quotes: {} };
  }
  return cache;
};
const save = (): void => {
  try {
    const f = fileOf();
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, f);
  } catch {
    // a note not remembered across a restart is only a note to send again
  }
};

/** Tests: forget everything held in memory (the file is read again). */
export const resetVoiceNotes = (): void => void (cache = undefined);

/** A voice note arrived in conversation `key`. */
export function holdVoiceNote(key: string, n: VoiceNote, now = Date.now()): void {
  const s = load();
  const list = (s.notes[key] ??= []).filter((x) => x.ts !== n.ts && now - x.ts < MAX_AGE_MS);
  list.push(n);
  s.notes[key] = list.slice(-NOTES_PER_CONVERSATION);
  save();
}

/** A message in conversation `key` replies to a voice note. */
export function holdQuote(key: string, messageTs: number, quotedTs: number): void {
  const q = ((load().quotes[key] ??= {}));
  q[String(messageTs)] = quotedTs;
  const keys = Object.keys(q);
  if (keys.length > NOTES_PER_CONVERSATION * 2) for (const k of keys.slice(0, keys.length - NOTES_PER_CONVERSATION * 2)) delete q[k];
  save();
}

/** The voice notes of a conversation that are still in the look-back, newest first. */
export function voiceNotes(key: string, now = Date.now()): VoiceNote[] {
  return (load().notes[key] ?? []).filter((x) => now - x.ts < MAX_AGE_MS).sort((a, b) => b.ts - a.ts);
}

/** One voice note of THIS conversation by its id (timestamp), if it is in the look-back. */
export const voiceNote = (key: string, ts: number, now = Date.now()): VoiceNote | undefined => voiceNotes(key, now).find((x) => x.ts === ts);

/** The voice note a message replies to, if it is one received in this conversation. */
export function quotedVoiceNote(key: string, messageTs: number, now = Date.now()): VoiceNote | undefined {
  const q = load().quotes[key]?.[String(messageTs)];
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
