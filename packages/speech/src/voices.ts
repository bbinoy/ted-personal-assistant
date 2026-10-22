import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The voice library of the cloned voice (Qwen). One library per conversation, but this package does not know what a conversation is: the host hands it a ROOT folder and a SCOPE
// (a folder name it chose and made safe: the app passes conversations/ and the conversation's id), and the library is <root>/<scope>/voices/. Layout of a library:
//   active.json            {"name": ...}   absent or invalid: the default voice (the clip from TTS_REF_AUDIO / TTS_REF_TEXT, not stored here)
//   <name>/ref.wav         mono 24 kHz reference clip     ref.txt  what is said in it     meta.json  created, source, seconds, who asked
// (the host may keep its own files in the same folder, like the voice notes it received: a name is [a-z0-9-] so no file of theirs is ever a voice.)
// The scope and the names are the only things that ever become part of a path, and they are checked against SCOPE and NAME first, so nothing can climb out of
// the folder. The clips are private data: they are only read by the local speech server and never logged.

export const OWNER_SCOPE = "owner";
export const DEFAULT_VOICE = "default";
export const MAX_VOICES = { owner: 10, group: 5 } as const;
export const NAME = /^[a-z0-9-]{1,32}$/;
export const SCOPE = /^[a-z][a-z0-9_-]{0,63}$/; // what the host may call a conversation here (it is a folder name)

/** Pure: a name the model or a person gave, made into a library name ([a-z0-9-], at most 32 characters). Empty when nothing is left. */
export function sanitizeVoiceName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/** The library folder of a conversation (its scope) under the host's root. Throws for a scope that is not a plain folder name. */
export function scopeRoot(voiceRoot: string, scope: string): string {
  if (!SCOPE.test(scope)) throw new Error("bad voice scope");
  return join(voiceRoot, scope, "voices");
}
export const maxVoices = (scope: string): number => (scope === OWNER_SCOPE ? MAX_VOICES.owner : MAX_VOICES.group);

export interface VoiceMeta {
  created: string;
  source: string; // "voice note"
  seconds: number;
  by?: string; // who asked for it (their Signal id; in a group that lets them delete it later)
  byName?: string;
  from?: string; // whose voice it is: the sender of the voice note it was made from (differs from `by` when the requester used someone else's note)
  fromName?: string;
}
export interface VoiceInfo {
  name: string;
  meta?: VoiceMeta;
}

const dirOf = (root: string, name: string): string => {
  if (!NAME.test(name) || name === DEFAULT_VOICE) throw new Error("bad voice name");
  return join(root, name);
};

/** The clip and text of a saved voice, or undefined when it is not (completely) there. Never the default. */
export function voiceFiles(root: string, name: string): { audio: string; text: string } | undefined {
  if (!NAME.test(name) || name === DEFAULT_VOICE) return undefined;
  const d = join(root, name);
  const audio = join(d, "ref.wav");
  const textFile = join(d, "ref.txt");
  if (!existsSync(audio) || !existsSync(textFile)) return undefined;
  return { audio, text: readFileSync(textFile, "utf8").trim() };
}

function readMeta(root: string, name: string): VoiceMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(root, name, "meta.json"), "utf8")) as VoiceMeta;
  } catch {
    return undefined;
  }
}

export const getMeta = (root: string, name: string): VoiceMeta | undefined => (NAME.test(name) ? readMeta(root, name) : undefined);

/** The saved voices (without the default), oldest first. */
export function listVoices(root: string): VoiceInfo[] {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => NAME.test(n) && n !== DEFAULT_VOICE && voiceFiles(root, n))
    .map((name) => ({ name, meta: readMeta(root, name) }))
    .sort((a, b) => (a.meta?.created ?? "").localeCompare(b.meta?.created ?? "") || a.name.localeCompare(b.name));
}

/** The active voice of a library: a saved one that is still complete, else the default. */
export function activeVoice(root: string): string {
  try {
    const n = (JSON.parse(readFileSync(join(root, "active.json"), "utf8")) as { name?: unknown }).name;
    if (typeof n === "string" && voiceFiles(root, n)) return n;
  } catch {
    // none yet
  }
  return DEFAULT_VOICE;
}

/** Makes `name` the active voice (the default, or a saved one). Throws a sentence for an unknown name. */
export function setActiveVoice(root: string, name: string): void {
  if (name !== DEFAULT_VOICE && !voiceFiles(root, name)) throw new Error(`There is no voice called "${name}".`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `active.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ name }), { mode: 0o600 });
  renameSync(tmp, join(root, "active.json"));
}

/** Saves a voice (does not activate it). Throws a sentence when the name is taken or reserved, or the library is full. */
export function saveVoice(root: string, name: string, v: { wav: Uint8Array; text: string; meta: VoiceMeta }, cap: number): void {
  if (name === DEFAULT_VOICE) throw new Error('"default" is the built-in voice; pick another name.');
  const d = dirOf(root, name);
  if (voiceFiles(root, name)) throw new Error(`A voice called "${name}" exists already; pick another name or delete it first.`);
  if (listVoices(root).length >= cap) throw new Error(`The library holds ${cap} voices already; delete one first.`);
  const tmp = `${d}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  writeFileSync(join(tmp, "ref.wav"), v.wav, { mode: 0o600 });
  writeFileSync(join(tmp, "ref.txt"), v.text, { mode: 0o600 });
  writeFileSync(join(tmp, "meta.json"), JSON.stringify(v.meta), { mode: 0o600 });
  rmSync(d, { recursive: true, force: true }); // an incomplete leftover
  renameSync(tmp, d);
}

/** Deletes a saved voice; if it was active, the default is active again. The default cannot be deleted. */
export function deleteVoice(root: string, name: string): void {
  if (name === DEFAULT_VOICE) throw new Error("The default voice cannot be deleted.");
  if (!NAME.test(name) || !existsSync(join(root, name))) throw new Error(`There is no voice called "${name}".`);
  const wasActive = activeVoice(root) === name;
  rmSync(dirOf(root, name), { recursive: true, force: true });
  if (wasActive) setActiveVoice(root, DEFAULT_VOICE);
}

/** Removes a conversation's whole library (the owner's is never removed this way). */
export function removeScope(voiceRoot: string, scope: string): void {
  if (scope === OWNER_SCOPE) return;
  rmSync(scopeRoot(voiceRoot, scope), { recursive: true, force: true });
}

/**
 * What the speech server is asked to use for a conversation: the library path of the active voice, relative to the voice folder
 * (the server joins it itself), or undefined for the default voice.
 */
export function activeVoiceRel(voiceRoot: string, scope: string): string | undefined {
  const root = scopeRoot(voiceRoot, scope);
  const name = activeVoice(root);
  if (name === DEFAULT_VOICE) return undefined;
  return `${scope}/voices/${name}`;
}
