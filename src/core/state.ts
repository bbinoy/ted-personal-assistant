import { appendFileSync, chmodSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
// two callers can never lose each other's update. Writes go to a temporary file and are
// renamed into place, so a crash mid-write leaves the old version, never a torn file.

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

export function writeText(rel: string, text: string): void {
  const path = dataPath(rel);
  ensureDir(path);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson<T>(rel: string, fallback: T): T {
  const raw = readText(rel);
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.error(`state: ${rel} is unreadable, starting from defaults`);
    return fallback;
  }
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
export function openLog(rel: string): number {
  const path = dataPath(rel);
  ensureDir(path);
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
