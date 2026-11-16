import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "@ted-assistant/messenger";
import { safeName } from "../../conversation/document.ts";
import { instancePaths } from "../../core/convpaths.ts";

// Pictures of a turn, kept so the model can send one with the `send` tool (send.ts): screenshots of a browse run and drawings (drawtool.ts). The worker
// keeps each screenshot as a small jpeg in a private folder (instance/browse/shots); the browse result lists them by short id (shot1, shot2...). A drawing is
// a PNG that code rendered from the model's sanitised SVG, kept in the same turn folder (img1, img2...). The model names an id; code looks it up in THIS
// conversation's turn only (never a path) and checks the file again (a plain file in that folder, jpeg or png bytes, size).
// A screenshot is page content: untrusted, only ever sent to the conversation that asked for it, never fed back as an instruction. The files are
// removed when the turn ends (or after SHOT_TTL_MS if the process died first).
// FILES opened with open_file (a mail attachment: modules/files) are kept the same way under file1, file2... but only in memory, as bytes of this turn; the one
// file that exists on disk is a temp copy while signal-cli sends it (withTempFile), deleted right after. Their content is data from a third party, untrusted.

export const MAX_PICTURE_BYTES = 3_000_000;
export const SHOT_TTL_MS = 60 * 60_000;
// A file attached to a mail draft is read by the mail client later (when it syncs or sends the draft), long after the turn ended, so its copy lives in
// its own folder that dropShots leaves alone; it is swept by age. 30 days: a draft can sit that long before it is sent.
export const HELD_TTL_MS = 30 * 24 * 60 * 60_000;
const heldRoot = () => join(instancePaths().browse, "held");
export const MAX_DRAWINGS = 20; // per turn
const ID = /^(shot|img)[1-9]\d{0,2}$/;
export const MAX_FILES = 10; // per turn, the one cap for every file (open_file, PDFs a browse run kept); each at most MAX_FILE_BYTES (20 MB); the browse run's own runaway guard uses it too
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
  for (const [root, ttl] of [[shotsRoot(), SHOT_TTL_MS], [heldRoot(), HELD_TTL_MS]] as const) {
    try {
      for (const n of readdirSync(root)) {
        const p = join(root, n);
        try {
          if (now - statSync(p).mtimeMs > ttl) rmSync(p, { recursive: true, force: true });
        } catch {
          // gone already
        }
      }
    } catch {
      // no folder yet
    }
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
  files: Map<string, HeldFile>;
}
const turns = new Map<string, TurnShots>(); // by conversation key (OWNER_KEY or the group id)

function turnOf(key: string): TurnShots {
  let t = turns.get(key);
  if (!t) {
    mkdirSync(shotsRoot(), { recursive: true, mode: 0o700 });
    turns.set(key, (t = { dir: mkdtempSync(join(shotsRoot(), "turn-")), shots: new Map(), files: new Map() }));
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

// Keeps the bytes of a file opened in this turn under a new id (file1, file2...); undefined at the per-turn limit or over the size a message can carry.
export function adoptFile(key: string, bytes: Buffer, name: string): HeldFile | undefined {
  const t = turnOf(key);
  if (t.files.size >= MAX_FILES || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return undefined;
  const taken = new Set([...t.files.values()].map((f) => f.name));
  const base = safeName(name);
  let unique = base;
  for (let n = 2; taken.has(unique); n++) unique = base.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`); // two files of a turn never share a name: a.pdf, a-2.pdf
  const file = { id: `file${t.files.size + 1}`, name: unique, bytes };
  t.files.set(file.id, file);
  return file;
}

// The file of an id of THIS conversation's turn (never a path).
export function loadFile(key: string, id: string): { file: HeldFile } | { problem: string } {
  const file = turns.get(key)?.files.get(id);
  return file ? { file } : { problem: `No file "${id}" in this conversation. The ids are the ones open_file returned in this turn.` };
}

// A held file as a real file, for the one case a path is needed: a mail draft's attachment (permissions.ts swaps "file1" for it, after the checks; the model never
// names a path). It goes in a fresh unguessable folder outside the turn's (see HELD_TTL_MS), so it outlives the turn. Undefined for an id that is not this turn's.
export function heldPath(key: string, id: string): string | undefined {
  const f = turns.get(key)?.files.get(id);
  if (!f) return undefined;
  mkdirSync(heldRoot(), { recursive: true, mode: 0o700 });
  sweepShots();
  const dir = mkdtempSync(join(heldRoot(), "held-"));
  const path = join(dir, safeName(f.name));
  writeFileSync(path, f.bytes, { mode: 0o600 });
  return path;
}

// Every file this turn holds (file1, file2...), in id order: what the workbench puts in its /work/in.
export const heldFiles = (key: string): HeldFile[] => [...(turns.get(key)?.files.values() ?? [])];

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

// The turn is over: its pictures and files go.
export function dropShots(key: string): void {
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
