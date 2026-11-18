import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "@ted-assistant/messenger";
import { safeName } from "../../conversation/document.ts";
import { convIdOfKey, convPaths, instancePaths } from "../../core/convpaths.ts";

// Pictures of a turn, kept so the model can send one with the `send` tool (send.ts): screenshots of a browse run and drawings (drawtool.ts). The worker
// keeps each screenshot as a small jpeg in a private folder (instance/browse/shots); the browse result lists them by short id (shot1, shot2...). A drawing is
// a PNG that code rendered from the model's sanitised SVG, kept in the same turn folder (img1, img2...). The model names an id; code looks it up in THIS
// conversation's turn only (never a path) and checks the file again (a plain file in that folder, jpeg or png bytes, size).
// A screenshot is page content: untrusted, only ever sent to the conversation that asked for it, never fed back as an instruction. The files are
// removed when the turn ends (or after SHOT_TTL_MS if the process died first).
// FILES are another matter: a file belongs to the conversation, not to the turn (work spans turns: a newer message, an approval minutes later, "send" in the next message). Whatever
// Ted holds (a mail attachment opened with open_file, a PDF a browse run kept, a workbench output, a document or picture the person sent) is adopted ONCE into the conversation's own
// folder (convpaths.ts: <conversation>/files/file<N>/<name>), under an id that stays valid across turns and restarts until the retention rule (retentionrules.ts) sweeps it by age
// (HELD_FILE_DAYS). A conversation reads only its own folder, so a friend's files sit where the rest of her private data is. The stored file is itself the stable path a mail draft
// attaches (permissions.ts). Pictures above stay per turn: they are only looked at or sent once, never attached, and a screenshot is page content that should not outlive its turn.
// A file's content is data from a third party, untrusted. The one temp copy is for signal-cli while it sends (withTempFile), deleted right after.

export const MAX_PICTURE_BYTES = 3_000_000;
export const SHOT_TTL_MS = 60 * 60_000;
export const HELD_FILE_DAYS = 30; // a mail draft can sit that long before it is sent
export const MAX_DRAWINGS = 20; // per turn
const ID = /^(shot|img)[1-9]\d{0,2}$/;
export const MAX_FILES = 10; // NEW files per turn, the one cap for every file (open_file, PDFs a browse run kept, what the person sent); each at most MAX_FILE_BYTES (20 MB); the browse run's own runaway guard uses it too
const shotsRoot = () => join(instancePaths().browse, "shots");

export const isJpeg = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
export const isPng = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

// A folder for one browse run's screenshots (the guard writes into it). Old ones are swept first.
export function newShotsDir(now = Date.now()): string {
  mkdirSync(shotsRoot(), { recursive: true, mode: 0o700 });
  sweepShots(now);
  return mkdtempSync(join(shotsRoot(), "run-"));
}

// Folders older than the TTL (a turn that never ended, a crash) go.
export function sweepShots(now = Date.now()): void {
  try {
    for (const n of readdirSync(shotsRoot())) {
      const p = join(shotsRoot(), n);
      try {
        if (now - statSync(p).mtimeMs > SHOT_TTL_MS) rmSync(p, { recursive: true, force: true });
      } catch {
        // gone already
      }
    }
  } catch {
    // no folder yet
  }
}

export interface Shot {
  id: string;
  file: string;
  size: number;
  caption: string;
}
export interface HeldFile {
  id: string;
  name: string; // a plain label (safeName), also the name it is sent under
  bytes: Buffer;
}
interface TurnShots {
  dir: string;
  shots: Map<string, Shot>;
}
const turns = new Map<string, TurnShots>(); // by conversation key (OWNER_KEY or the group id)

function turnOf(key: string): TurnShots {
  let t = turns.get(key);
  if (!t) {
    mkdirSync(shotsRoot(), { recursive: true, mode: 0o700 });
    turns.set(key, (t = { dir: mkdtempSync(join(shotsRoot(), "turn-")), shots: new Map() }));
  }
  return t;
}
const countOf = (t: TurnShots, prefix: string) => [...t.shots.keys()].filter((k) => k.startsWith(prefix)).length;

// Keeps a PNG that code rendered (drawtool.ts) in the conversation's turn under a new id (img1, img2...); undefined at the per-turn limit.
export function adoptDrawing(key: string, png: Buffer, caption = ""): Shot | undefined {
  if (png.length > MAX_PICTURE_BYTES || !isPng(png)) return undefined;
  const t = turnOf(key);
  if (countOf(t, "img") >= MAX_DRAWINGS) return undefined;
  const id = `img${countOf(t, "img") + 1}`;
  const file = join(t.dir, `${id}.png`);
  writeFileSync(file, png, { mode: 0o600 });
  const shot = { id, file, size: png.length, caption };
  t.shots.set(id, shot);
  return shot;
}

// Takes the files of one browse run (a folder from newShotsDir) into the conversation's turn under new ids; returns them for the result.
export function adoptShots(key: string, from: { id: string; file: string; size: number }[], captions: Record<string, string>): Shot[] {
  if (!from.length) return [];
  const t = turnOf(key);
  const out: Shot[] = [];
  for (const s of from) {
    const id = `shot${countOf(t, "shot") + 1}`;
    const file = join(t.dir, `${id}.jpg`);
    try {
      renameSync(s.file, file);
    } catch {
      continue;
    }
    const shot = { id, file, size: s.size, caption: captions[s.id] ?? "" };
    t.shots.set(id, shot);
    out.push(shot);
  }
  return out;
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
  mkdirSync(shotsRoot(), { recursive: true, mode: 0o700 });
  sweepShots();
  const dir = mkdtempSync(join(shotsRoot(), "send-")); // (swept after SHOT_TTL_MS if the process dies in between)
  try {
    const path = join(dir, safeName(f.name));
    writeFileSync(path, f.bytes, { mode: 0o600 });
    return await use(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The turn is over: its pictures go (its files stay: they belong to the conversation).
export function dropShots(key: string): void {
  newThisTurn.delete(key);
  const t = turns.get(key);
  if (!t) return;
  turns.delete(key);
  rmSync(t.dir, { recursive: true, force: true });
}

// The file of an id of this turn, after checking it again: a plain file (no symlink) inside the turn's folder, jpeg or png bytes, size.
export function loadShot(key: string, id: string): { shot: Shot } | { problem: string } {
  const t = turns.get(key);
  if (!t) return { problem: "No screenshot available: none was taken in this conversation." };
  const shot = ID.test(id) ? t.shots.get(id) : undefined;
  if (!shot) return { problem: `No screenshot "${id}" in this conversation. The ids are the ones listed in the browse result or returned by the draw tool.` };
  let fd: number | undefined;
  try {
    if (!shot.file.startsWith(t.dir + "/") || lstatSync(shot.file).isSymbolicLink()) return { problem: "That screenshot cannot be used." };
    fd = openSync(shot.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_PICTURE_BYTES || st.size < 5) return { problem: "That screenshot cannot be used (size)." };
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4 || !(isJpeg(head) || isPng(head))) return { problem: "That screenshot is not a jpeg or png picture." };
    return { shot: { ...shot, size: st.size } };
  } catch {
    return { problem: "That screenshot is gone." };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
