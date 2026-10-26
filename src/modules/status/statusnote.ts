import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "../../core/state.ts";
import { join } from "node:path";
import { z } from "zod";
import { emitRecord } from "../../core/events.ts";
import { MAX_STATUS_CHARS, NOTES_DIR, STATUS_PREFIX } from "../../memory/notes.ts";
import { localDay } from "../../core/pause.ts";
import { dayAt, systemZone, timeIn } from "../../core/timezone.ts";
import { convOfPath, OWNER_CONV } from "../../core/convpaths.ts";
import { briefDelivered } from "../../memory/learned.ts";

// The assistant's own state, as memory: status-<name>.md in the notes folder (category `status`, assistant-written records such as status-brief: whether today's daily
// brief went out). The heartbeat run and its experts have NO note tools (their notes are injected as data); this one tool is the only note write they have, and it is
// narrow by construction: a name from a short pattern, so the file is always status-<name>.md in the owner's notes folder, at most one note's worth of text, and an
// `expires:` of tomorrow so a record never outlives the day after. The dream never touches the category (preset notes.dream) and a write raises no memory notice.

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

// The code, not the model, stamps a note: `written:` (when this file was written, an instant) and `attempts:` (how many times today a run STARTED, counted by the tool when the text says
// `status: started`) are front matter that the model cannot write and the notes' readers ignore. Times and dates INSIDE the text are the model's words and not authoritative (an
// expert once wrote 07:35 in a note written at 06:36); the fact line the heartbeat instruction carries (statusFact) is computed from the stamp.
export const STALE_STARTED_MINUTES = 45; // a note still `started` after this long means the run died: it counts as a failed attempt

export type BriefState = "started" | "delivered" | "failed";
export interface StatusRead {
  status?: BriefState; // as the text says (`status: started|delivered|failed`)
  writtenAt: Date;
  attempts: number;
}

const statusOf = (text: string): BriefState | undefined => /\bstatus:\s*(started|delivered|failed)\b/i.exec(text)?.[1]?.toLowerCase() as BriefState | undefined;

// Pure but for the file: the stamp and the status of status-<name>.md, or undefined when there is none. A note without a stamp (written by hand) is read at the file's mtime.
export function readStatusNote(name: string, dir: string = NOTES_DIR): StatusRead | undefined {
  const file = join(dir, `${STATUS_PREFIX}${name}.md`);
  try {
    const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    const front = m?.[1] ?? "";
    const stamp = /^\s*written:\s*(\S+)\s*$/m.exec(front)?.[1];
    const at = stamp ? new Date(stamp) : new Date(statSync(file).mtimeMs);
    const attempts = Number(/^\s*attempts:\s*(\d+)\s*$/m.exec(front)?.[1] ?? 0);
    return Number.isFinite(at.getTime()) ? { status: statusOf(raw.slice(m?.[0].length ?? 0)), writtenAt: at, attempts } : undefined;
  } catch {
    return undefined;
  }
}

// The fact line of the heartbeat instruction: where the note stands NOW, computed from the stamp and the clock in the conversation's zone, so the model does no date arithmetic.
export function statusFact(name: string, now: Date, zone: string = systemZone(), dir: string = NOTES_DIR): string {
  const label = `${STATUS_PREFIX}${name}`;
  const r = readStatusNote(name, dir);
  if (!r || dayAt(r.writtenAt, 0, zone).date !== dayAt(now, 0, zone).date) return `${label}: none today`;
  const at = timeIn(r.writtenAt, zone);
  const attempts = `attempts today: ${r.attempts}`;
  const minutes = Math.max(0, Math.round((now.getTime() - r.writtenAt.getTime()) / 60_000));
  if (r.status === "delivered") return `${label}: delivered at ${at}`;
  if (r.status === "started") return minutes > STALE_STARTED_MINUTES ? `${label}: started ${minutes} min ago, stale (over ${STALE_STARTED_MINUTES} min: the run died, this counts as failed); ${attempts}` : `${label}: started ${minutes} min ago`;
  if (r.status === "failed") return `${label}: failed at ${at}; ${attempts}`;
  return `${label}: written at ${at} without a clear status; ${attempts}`;
}

// For /status and the doctor: when a status note was last written and how it ended ("10-22 07:41 (delivered)"), or "not yet".
export function lastStatusText(name: string, zone: string = systemZone(), dir: string = NOTES_DIR): string {
  const n = readStatusNote(name, dir);
  return n ? `${dayAt(n.writtenAt, 0, zone).date.slice(5)} ${timeIn(n.writtenAt, zone)} (${n.status ?? "no status"})` : "not yet";
}

export type StatusResult = { ok: true; file: string } | { ok: false; error: string };

// Pure but for the file: writes status-<name>.md. `dir`: tests.
// `days`: how long it lives (1 = until tomorrow, the default; at most MAX_STATUS_DAYS, for a record that must outlast a day, like "the clean-up was offered").
export const MAX_STATUS_DAYS = 30;
export function writeStatusNote(name: string, text: string, now: Date = new Date(), dir: string = NOTES_DIR, days = 1): StatusResult {
  if (!Number.isInteger(days) || days < 1 || days > MAX_STATUS_DAYS) return { ok: false, error: `days is a whole number from 1 to ${MAX_STATUS_DAYS}` };
  if (!NAME.test(name)) return { ok: false, error: "the name is lower-case words with dashes, like brief (the file becomes status-brief.md)" };
  const body = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/g, "").trim();
  if (!body) return { ok: false, error: "the note is empty" };
  if (body.length > MAX_STATUS_CHARS) return { ok: false, error: `too long (${body.length} characters, the most is ${MAX_STATUS_CHARS}): keep the date, the status and the headlines only` };
  const before = readStatusNote(name, dir);
  const carried = before && localDay(before.writtenAt) === localDay(now) ? before.attempts : 0; // the count is the day's
  const r = put(name, body, now, dir, carried + (statusOf(body) === "started" ? 1 : 0), days);
  if (r.ok && name === "brief" && statusOf(body) === "delivered") {
    const conv = dir === NOTES_DIR ? OWNER_CONV : convOfPath(dir);
    if (conv) briefDelivered(conv); // the "learned overnight" list the brief carried is told now, not when the tool handed it out (memory/learned.ts)
  }
  return r;
}

function put(name: string, body: string, now: Date, dir: string, attempts: number, days = 1): StatusResult {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + days);
  const file = `${STATUS_PREFIX}${name}.md`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, file), `---\nexpires: ${localDay(tomorrow)}\nwritten: ${now.toISOString()}\nattempts: ${attempts}\n---\n${body}\n`);
  return { ok: true, file };
}

// A run that was meant to finish a note was stopped (its ceiling, the Mac sleeping, a failure): a note still `started` from today is rewritten as `failed` with the time and the
// reason, so the next look sees it at once instead of waiting out the stale time. Returns whether it changed the note. The attempts are kept.
export function failStartedNote(name: string, why: string, now: Date = new Date(), dir: string = NOTES_DIR, zone: string = systemZone()): boolean {
  const r = readStatusNote(name, dir);
  if (!r || r.status !== "started" || dayAt(r.writtenAt, 0, zone).date !== dayAt(now, 0, zone).date) return false;
  const body = `${dayAt(now, 0, zone).date}\nstatus: failed\nattempts today: ${r.attempts}, failed: ${why} (it started at ${timeIn(r.writtenAt, zone)}, the code stopped it at ${timeIn(now, zone)}).`;
  return put(name, body, now, dir, r.attempts).ok;
}

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

// The in-process server of a heartbeat run (modules/status.ts says who has it).
export function createStatusServer(dir: string = NOTES_DIR) {
  return createSdkMcpServer({
    name: "status",
    version: "1.0.0",
    tools: [
      tool(
        "write_status_note",
        "Write your own record of what you did, as a status note that your later looks read in their notes (for example name 'brief' to record the daily brief: today's date, started/delivered/failed, the headlines). It replaces the note of that name. Write the status as `status: started`, `status: delivered` or `status: failed`, and any time exactly as the clock line gives it (that zone, no conversion; the code stamps the real time itself and its own record is the authority). Keep it short (1200 characters at most); it expires after tomorrow, unless you pass days (1 to 30) for a record that must last longer.",
        { name: z.string().describe("Lower-case words with dashes, like brief; the note is saved as status-<name>.md"), text: z.string().describe("The note: the date, the status and the few facts a later look needs"), days: z.number().optional().describe("Days the note lives, 1 to 30 (default 1: until tomorrow)") },
        async ({ name, text, days }) => {
          const r = writeStatusNote(name, text, new Date(), dir, days);
          emitRecord("status_note", r.ok ? "written" : "refused", "background", { name: String(name).slice(0, 40) });
          return r.ok ? reply(`Saved ${r.file}.`) : reply(r.error, true);
        },
      ),
    ],
  });
}
