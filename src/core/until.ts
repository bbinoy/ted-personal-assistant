import { clockIn, timeIn } from "./timezone.ts";

// ONE "until" value for the two switches the owner holds with a message: /pause (unattended work stops everywhere: core/pause.ts, a row of instance.db) and /quiet (one conversation holds its
// unprompted posts: conversation/quiet.ts, a row of its assistant.db). A stored value is "" (on until the owner switches it off) or an ISO time (on until then). One parse, one test, one format.

const MAX_MS = 365 * 86_400_000;
const UNITS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

export interface Parsed {
  until: string; // what is stored: "" or an ISO time
  when: string; // how it is said back: "" (until switched off), "16:30", "18:00 tomorrow"
}

// Pure: the rest of "/pause ..." or "/quiet ...". `arg` undefined: the bare command (until switched off). "2h", "30m", "1d" or "until 18:00" is the moment it names; "usage" for a malformed one
// (also anything else after the command).
export function parseUntil(arg: string | undefined, now: Date, zone: string): Parsed | "usage" {
  if (arg === undefined) return { until: "", when: "" };
  const span = /^(\d{1,4})\s?(m|min|h|d)$/.exec(arg);
  if (span) {
    const ms = Number(span[1]) * UNITS[span[2]!]!;
    if (ms <= 0 || ms > MAX_MS) return "usage";
    const at = new Date(now.getTime() + ms);
    return { until: at.toISOString(), when: `${timeIn(at, zone)}${ms >= 86_400_000 ? ` on ${at.toISOString().slice(0, 10)}` : ""}` };
  }
  const clock = /^until (\d{1,2})(?::(\d{2}))?$/.exec(arg);
  if (!clock) return "usage";
  const h = Number(clock[1]);
  const m = Number(clock[2] ?? 0);
  if (h > 23 || m > 59) return "usage";
  const c = clockIn(now, zone);
  const nowMin = c.hour * 60 + c.minute;
  const tomorrow = h * 60 + m <= nowMin; // the next time it is h:m is tomorrow's when it has passed
  const ahead = (h * 60 + m - nowMin + 1440) % 1440 || 1440;
  const at = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + ahead * 60_000);
  return { until: at.toISOString(), when: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${tomorrow ? " tomorrow" : ""}` };
}

// Pure: is the stored switch on at `now`? No value: off. A value nobody can read is `ifUnreadable`: the pause is a kill switch and stays ON (fail safe), /quiet fails open (a missed post is
// worse than a dropped switch, and nothing but a post is held).
export function untilOn(stored: unknown, now: Date, ifUnreadable: boolean): boolean {
  if (stored === undefined || stored === null) return false;
  if (typeof stored !== "string") return ifUnreadable;
  const until = stored.trim();
  if (until === "") return true;
  const t = Date.parse(until);
  return Number.isFinite(t) ? t > now.getTime() : ifUnreadable;
}

// Pure: a stored switch as words for "/status": "until you switch it off" or "until 16:30" (in the zone given, the Mac's by default).
export function untilWords(stored: string, zone?: string): string {
  const t = Date.parse(stored.trim());
  return stored.trim() === "" ? "until you switch it off" : Number.isFinite(t) ? `until ${timeIn(new Date(t), zone)}` : "(its time cannot be read)";
}
