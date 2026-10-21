// Import this FIRST (for its side effects).
//  - owner-only files: everything the harness creates is mode 600/700 (the audit log holds senders and subjects)
//  - logs go to logs/agent.log; startup secures state/, logs/, memory/
//  - every console line gets a local timestamp, is redacted, and is appended to a rotating file
//  - crashes and unhandled rejections are written to that same file before the process exits
process.umask(0o077);

import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import { trimLogInPlace } from "./logtrim.ts";
import { redact } from "./redact.ts";
import { dataPath, secureDataDirs } from "./state.ts";

const FILE = dataPath("logs/agent.log");
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

// Before anything reads a file: create and tighten state/, logs/ and memory/ (owner-only, whatever made the files).
secureDataDirs();

let writes = 0;
function rotateIfNeeded() {
  try {
    if (statSync(FILE).size < MAX_BYTES) return;
    rmSync(`${FILE}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      try { renameSync(`${FILE}.${i}`, `${FILE}.${i + 1}`); } catch { /* missing is fine */ }
    }
    renameSync(FILE, `${FILE}.1`);
  } catch { /* no file yet */ }
}
rotateIfNeeded();
// launchd's raw stderr files (the agent's, and the intake page's: scripts/intake.ts imports this file first too) are never rotated by anyone else: over 5 MB at start, keep the last 1 MB.
const trimmedStderr = ["launchd-stderr.log", "intake-launchd-stderr.log"].map((f) => trimLogInPlace(dataPath(`logs/${f}`), MAX_BYTES, 1024 * 1024)).reduce((a, b) => a + b, 0);

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function stamp(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// One argument as text; a circular object or a BigInt must not make a log call throw.
function show(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

// warn, info and debug too: the Signal client's warnings (read receipt failed: <error text>) go through console.warn, and
// unwrapped they reached stderr (launchd-stderr.log, never rotated) unredacted, and info was lost under launchd.
for (const level of ["log", "error", "warn", "info", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = redact(args.map(show).join(" "));
    const line = `${stamp()} ${level === "error" ? "ERR " : level === "warn" ? "WARN " : ""}${text}`;
    if (process.stdout.isTTY) original(line); // under launchd the file below is the log
    try {
      appendFileSync(FILE, line + "\n");
      if (++writes % 200 === 0) rotateIfNeeded();
    } catch { /* logging must never crash the agent */ }
  };
}

if (trimmedStderr) console.log(`launchd's stderr log was over ${MAX_BYTES / 1024 / 1024} MB: dropped the oldest ${Math.round(trimmedStderr / 1024)} KB`);

// Let launchd restart us, but leave a trace of why.
process.on("uncaughtException", (e) => {
  console.error("FATAL uncaught exception:", e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("FATAL unhandled rejection:", e);
  process.exit(1);
});
