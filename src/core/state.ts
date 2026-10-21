import { rotateIfOver } from "./rotate.ts";
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isInside } from "./contain.ts";
import { settings } from "./settings.ts";

// Everything the agent keeps lives in small files under the data root, in three owner-only
// folders. Paths are always "<folder>/<name>", so the folder is explicit at every call site:
//   state/   bookkeeping the model never reads (seen.json, cost.json, session.json, paused...)
//   logs/    agent.log, audit.jsonl, signal-daemon.log, launchd-stderr.log
//   memory/  what the model reads: notes/ (semantic memory, the SDK auto-memory; status-* notes are the assistant's own records)
//
// All access is synchronous on purpose. The files are tiny, and a synchronous
// read-modify-write cannot be interleaved with anything else in Node's event loop, so
// two callers can never lose each other's update. Writes go to a temporary file, are fsynced, and are
// renamed into place (then the folder is fsynced), so a crash or power cut leaves the old version or the new one, never a torn or empty file.
// A file that does not parse is never silently replaced by defaults: it is moved aside as <name>.corrupt-<time> (readJson) or, for the tenant registry, left alone and saving refused.

// A typo or a ".." must fail loudly, not write outside the three folders.
const REL = /^(state|logs|memory)\/(?!\.)[\w.-]+$/;

// A group keeps its session pointer in its own folder (memory/groups/<key>/session.json): an absolute path is
// accepted when it is strictly inside the data root (".." and symlinks resolved), nowhere else.
export function dataPath(rel: string): string {
  if (isAbsolute(rel) && isInside(rel, settings.dataDir)) return rel;
  if (!REL.test(rel)) throw new Error(`state: "${rel}" is not a path like "state/seen.json"`);
  return join(settings.dataDir, rel);
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
  const to = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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

// Run at every start: create the three folders and tighten them (700) and their files (600).
// Files made by others (launchd's stderr file, an older version of the agent) may have been
// created with looser permissions.
export function secureDataDirs(): void {
  for (const dir of [settings.stateDir, settings.logsDir, settings.memoryDir, join(settings.memoryDir, "notes")]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      for (const f of readdirSync(dir, { withFileTypes: true })) if (f.isFile()) chmodSync(join(dir, f.name), 0o600);
    } catch { /* best effort */ }
  }
}
