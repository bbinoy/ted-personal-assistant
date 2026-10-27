import { fileStamp } from "./timezone.ts";
import { rotateIfOver } from "./rotate.ts";
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isInside } from "./contain.ts";
import { settings } from "./settings.ts";
import { convPaths, conversationsDir, instancePaths, logPaths, OWNER_CONV } from "./convpaths.ts";

// Everything the agent keeps lives in small files under the data root, in owner-only folders: instance/ (process-wide), conversations/<id>/ (one per conversation), logs/.
// WHERE each file is is core/convpaths.ts and nowhere else: this module reads and writes the absolute path that module gave.
//
// All access is synchronous on purpose. The files are tiny, and a synchronous
// read-modify-write cannot be interleaved with anything else in Node's event loop, so
// two callers can never lose each other's update. Writes go to a temporary file, are fsynced, and are
// renamed into place (then the folder is fsynced), so a crash or power cut leaves the old version or the new one, never a torn or empty file.
// A file that does not parse is never silently replaced by defaults: it is moved aside as <name>.corrupt-<time> (readJson) or, for the tenant registry, left alone and saving refused.

// A typo or a ".." must fail loudly, not write outside the data root: only an absolute path strictly inside it (".." and symlinks resolved) is accepted.
export function dataPath(path: string): string {
  if (isAbsolute(path) && isInside(path, settings.dataDir)) return path;
  throw new Error(`state: "${path}" is not a path inside the data folder (build it with core/convpaths.ts)`);
}

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

export function readText(rel: string): string | undefined {
  try {
    return readFileSync(dataPath(rel), "utf8");
  } catch {
    return undefined;
  }
}

let tmpSeq = 0;

// The one atomic write for any file under the data root (state, logs, notes): temp file with a unique name (pid + counter), written, fsynced, closed, renamed over the target,
// then the folder fsynced (best effort: not every platform lets a folder be opened). `mode`: owner-only by default.
export function writeFileAtomic(path: string, text: string, mode = 0o600): void {
  ensureDir(path);
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    const dfd = openSync(dirname(path), "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* best effort: the rename itself is already atomic */ }
}

export function writeText(rel: string, text: string): void {
  writeFileAtomic(dataPath(rel), text);
}

// Parses a state file: absent -> undefined; unreadable JSON -> `{ corrupt }` (the file is left where it is).
export function parseJson<T>(rel: string): { value: T | undefined } | { corrupt: string } {
  const raw = readText(rel);
  if (raw === undefined) return { value: undefined };
  try {
    return { value: JSON.parse(raw) as T };
  } catch (e) {
    return { corrupt: (e as Error).message };
  }
}

// The bad file is kept for a human (<name>.corrupt-<time>), not overwritten by the next save of defaults.
export function moveAside(path: string): string | undefined {
  const to = `${path}.corrupt-${fileStamp()}`;
  try {
    renameSync(path, to);
    return to;
  } catch {
    return undefined;
  }
}

const setAside = (rel: string) => moveAside(dataPath(rel));

export function readJson<T>(rel: string, fallback: T): T {
  const r = parseJson<T>(rel);
  if ("corrupt" in r) {
    const kept = setAside(rel);
    console.error(`state: ${rel} is unreadable (${r.corrupt}); ${kept ? `moved aside to ${kept}` : "could not be moved aside"}, starting from defaults`);
    return fallback;
  }
  return r.value === undefined ? fallback : r.value;
}

export function writeJson(rel: string, value: unknown): void {
  writeText(rel, JSON.stringify(value));
}

export function appendLine(rel: string, line: string): void {
  const path = dataPath(rel);
  ensureDir(path);
  appendFileSync(path, line + "\n", { mode: 0o600 });
}

// A file descriptor opened for appending, for a child process to write its output to.
// A log already over 5 MB is rotated first (two older generations kept, the rest dropped); the child holds the fd for its whole life, so a log that
// grows meanwhile is cut by copy-truncate (rotate.ts copyTruncateIfOver, run by the caller on a timer). The fd is O_APPEND, which makes that safe.
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export function openLog(rel: string): number {
  const path = dataPath(rel);
  ensureDir(path);
  rotateIfOver(path, LOG_MAX_BYTES, 2);
  return openSync(path, "a", 0o600);
}

// Run at every start: create the folders and tighten them (700) and their files (600).
// Files made by others (launchd's stderr file, an older version of the agent) may have been
// created with looser permissions.
export function secureDataDirs(): void {
  const owner = convPaths(OWNER_CONV);
  for (const dir of [instancePaths().dir, conversationsDir(), logPaths().dir, owner.dir, owner.notes]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      for (const f of readdirSync(dir, { withFileTypes: true })) if (f.isFile()) chmodSync(join(dir, f.name), 0o600);
    } catch { /* best effort */ }
  }
}
