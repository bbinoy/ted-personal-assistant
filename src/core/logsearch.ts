import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Search the logs folder for the chat agent (the search_logs tool). Read-only, plain text match.
// Reading a 20 MB audit log with a file reader is slow and token-hungry; this returns only the
// matching lines, newest last, each cut to a sane length.

const MAX_LINES = 100;
const MAX_LINE_CHARS = 500;
const MAX_FILE_BYTES = 40 * 1024 * 1024;

interface Search {
  file?: string; // a log's name, like "audit.jsonl" or "voice"; empty = all logs
  query?: string; // every word must appear (case-insensitive)
  sinceHours?: number; // only lines stamped within this many hours (lines without a date stamp are kept)
  limit?: number;
}

// Log files, newest generation last: "audit.jsonl.1" (the rotated one) comes before "audit.jsonl".
export function logFiles(dir: string, file?: string): string[] {
  if (!existsSync(dir)) return [];
  const want = (file ?? "").trim().toLowerCase().replace(/\.\d+$/, "");
  return readdirSync(dir)
    .filter((f) => !f.startsWith(".") && statSync(join(dir, f)).isFile())
    .filter((f) => !want || f.toLowerCase().replace(/\.\d+$/, "").startsWith(want))
    .sort((a, b) => (a.replace(/\.1$/, "") === b.replace(/\.1$/, "") ? (a.endsWith(".1") ? -1 : 1) : a.localeCompare(b)));
}

const STAMP = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/;

// Pure: the lines of `text` that match.
export function matchLines(text: string, s: Search, now = Date.now()): string[] {
  const words = (s.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const since = s.sinceHours && s.sinceHours > 0 ? now - s.sinceHours * 3600_000 : 0;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (since) {
      const at = STAMP.exec(line.slice(0, 80))?.[1];
      if (at && Date.parse(at.endsWith("Z") ? at : `${at}Z`) < since) continue;
    }
    const lower = line.toLowerCase();
    if (words.every((w) => lower.includes(w))) out.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
  }
  return out;
}

export function searchLogs(dir: string, s: Search): string {
  const limit = Math.max(1, Math.min(MAX_LINES, Math.floor(s.limit ?? 40)));
  const files = logFiles(dir, s.file);
  if (files.length === 0) return `No log file matches “${s.file ?? ""}”. Available: ${logFiles(dir).join(", ") || "none"}.`;
  const hits: string[] = [];
  for (const f of files) {
    const path = join(dir, f);
    if (statSync(path).size > MAX_FILE_BYTES) continue;
    for (const line of matchLines(readFileSync(path, "utf8"), s)) hits.push(files.length > 1 ? `[${f}] ${line}` : line);
  }
  if (hits.length === 0) return "No matching lines.";
  const shown = hits.slice(-limit);
  return `${hits.length > limit ? `Showing the last ${limit} of ${hits.length} matching lines.\n` : ""}${shown.join("\n")}`;
}
