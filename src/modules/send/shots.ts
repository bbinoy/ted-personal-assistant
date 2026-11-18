import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "@ted-assistant/messenger";
import { safeName } from "../../conversation/document.ts";
import { convIdOfKey, convPaths, instancePaths } from "../../core/convpaths.ts";

// FILES: a file belongs to the conversation, not to the turn (work spans turns: a newer message, an approval minutes later, "send" in the next message). Whatever
// Ted holds (a mail attachment opened with open_file, a PDF or screenshot a browse run listed, a drawing from the draw tool, a workbench output, a document or picture the person sent) is adopted ONCE
// into the conversation's own folder (convpaths.ts: <conversation>/files/file<N>/<name>), under an id that stays valid across turns and restarts until the retention rule (retentionrules.ts) sweeps it
// by age (HELD_FILE_DAYS). A conversation reads only its own folder, so a friend's files sit where the rest of her private data is. The stored file is itself the stable path a mail draft
// attaches (permissions.ts). A picture is a file like the others (the send tool sends a jpeg or png as a picture). A browse worker's screenshots stay in memory in its guard; only those it lists
// in its result are adopted, the rest go with the run.
// A file's content is data from a third party, untrusted. The one temp copy is for signal-cli while it sends (withTempFile), deleted right after.

export const MAX_PICTURE_BYTES = 3_000_000;
export const HELD_FILE_DAYS = 30; // a mail draft can sit that long before it is sent
export const MAX_FILES = 10; // NEW files per turn, the one cap for every file (open_file, PDFs a browse run kept, what the person sent); each at most MAX_FILE_BYTES (20 MB); the browse run's own runaway guard uses it too

export const isJpeg = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
export const isPng = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

export interface HeldFile {
  id: string;
  name: string; // a plain label (safeName), also the name it is sent under
  bytes: Buffer;
}
// ---- the conversation's files ----

const FILE_ID = /^file[1-9]\d{0,5}$/;
const filesOf = (key: string) => convPaths(convIdOfKey(key)).files;
const newThisTurn = new Map<string, Set<string>>(); // ids adopted since the conversation's turn began (the per-turn cap, and what the workbench puts in /work/in)
export const adoptedThisTurn = (key: string): ReadonlySet<string> => newThisTurn.get(key) ?? new Set();

export interface HeldInfo {
  id: string;
  name: string;
  path: string; // the stored file itself: stable until swept
  size: number;
  at: number; // when it was kept (ms)
}
// What the conversation holds, in id order.
export function listHeld(key: string): HeldInfo[] {
  const root = filesOf(key);
  const out: HeldInfo[] = [];
  try {
    for (const id of readdirSync(root).filter((n) => FILE_ID.test(n))) {
      try {
        const name = readdirSync(join(root, id))[0]!;
        const st = statSync(join(root, id, name));
        out.push({ id, name, path: join(root, id, name), size: st.size, at: st.mtimeMs });
      } catch {
        // swept meanwhile, or empty
      }
    }
  } catch {
    // none yet
  }
  return out.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
}

// Keeps a file in the conversation's folder under a new id (file1, file2...); undefined at the per-turn limit or over the size a message can carry. Bytes it already holds under the same
// name are not stored twice (a turn run again gets the same id). Two files never share a name: a.pdf, a-2.pdf.
export function adoptFile(key: string, bytes: Buffer, name: string): HeldFile | undefined {
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return undefined;
  const base = safeName(name);
  const held = listHeld(key);
  const same = held.find((f) => f.name === base && f.size === bytes.length && readFileSync(f.path).equals(bytes));
  if (same) return { id: same.id, name: same.name, bytes };
  const turn = newThisTurn.get(key) ?? newThisTurn.set(key, new Set()).get(key)!;
  if (turn.size >= MAX_FILES) return undefined;
  const taken = new Set(held.map((f) => f.name));
  let unique = base;
  for (let n = 2; taken.has(unique); n++) unique = base.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
  const id = `file${Math.max(0, ...held.map((f) => Number(f.id.slice(4)))) + 1}`;
  const dir = join(filesOf(key), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, unique), bytes, { mode: 0o600 });
  turn.add(id);
  return { id, name: unique, bytes };
}

// The file of an id of THIS conversation (never a path).
export function loadFile(key: string, id: string): { file: HeldFile } | { problem: string } {
  const f = FILE_ID.test(id) ? listHeld(key).find((h) => h.id === id) : undefined;
  return f ? { file: { id, name: f.name, bytes: readFileSync(f.path) } } : { problem: `No file "${id}" in this conversation. The ids are the ones in its list of held files, or the ones open_file returned.` };
}

// The stored path of a held file, for a mail draft's attachment (permissions.ts swaps "file1" for it, after the checks; the model never names a path). Undefined for an id this conversation does not hold.
export const heldPath = (key: string, id: string): string | undefined => (FILE_ID.test(id) ? listHeld(key).find((h) => h.id === id)?.path : undefined);

// The bytes as a short-lived file in a private folder, for the one call that needs a path (signal-cli attaching it); gone when `use` ends, however it ends.
export async function withTempFile<T>(f: Pick<HeldFile, "name" | "bytes">, use: (path: string) => Promise<T>): Promise<T> {
  mkdirSync(instancePaths().browse, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(instancePaths().browse, "run-")); // (swept at start-up with the browse runs' folders if the process dies in between)
  try {
    const path = join(dir, safeName(f.name));
    writeFileSync(path, f.bytes, { mode: 0o600 });
    return await use(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The turn is over: the next one may adopt new files again (the files themselves stay: they belong to the conversation).
export const endTurn = (key: string): void => void newThisTurn.delete(key);
