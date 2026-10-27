import { clockIn, isZone, pad } from "../core/timezone.ts";

// Local calendar and clock arithmetic for tasks, pure and DST-safe. A task's due date is a LOCAL wall time ("2026-10-24" or "2026-10-24T14:30") in the conversation's zone; only a reminder
// (remind_at) is an instant. So dates here are plain "YYYY-MM-DD" strings moved by calendar arithmetic (a day is not 24 hours across a clock change), and the one place a wall time becomes an
// instant is wallToUtc, which says what happens on the two clock-change days a year (a time that does not exist moves forward, a time that happens twice is the first).

const DAY_MS = 86_400_000;

export interface Ymd {
  year: number;
  month: number; // 1..12
  day: number;
}

/** "2026-10-24" as its parts, or undefined when it is not a real calendar date (2026-02-30 is not). */
export function parseDate(s: unknown): Ymd | undefined {
  const m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) ? { year, month, day } : undefined;
}
export const formatDate = (d: Ymd): string => `${String(d.year).padStart(4, "0")}-${pad(d.month)}-${pad(d.day)}`;
export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Days since 1970-01-01 of a date (a whole number: no clock, no zone). */
export const epochDay = (date: string): number => {
  const d = parseDate(date)!;
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / DAY_MS);
};
export function fromEpochDay(n: number): string {
  const d = new Date(n * DAY_MS);
  return formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}
export const addDays = (date: string, n: number): string => fromEpochDay(epochDay(date) + n);
export const daysBetween = (a: string, b: string): number => epochDay(b) - epochDay(a); // b - a
/** 0 = Sunday. */
export const weekdayOf = (date: string): number => (((epochDay(date) + 4) % 7) + 7) % 7; // (1970-01-01 was a Thursday)
/** Weeks counted from Monday: two dates in the same Monday-to-Sunday week have the same index. */
export const weekIndex = (date: string): number => Math.floor((epochDay(date) + 3) / 7);
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** A local "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" as its date and time; undefined for anything else (no seconds, no zone suffix, no space: the model writes exactly this). */
export function parseLocal(s: unknown): { date: string; time?: string } | undefined {
  const m = typeof s === "string" ? /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s) : null;
  if (!m || !parseDate(m[1])) return undefined;
  if (m[2] === undefined) return { date: m[1]! };
  const [h, mi] = [Number(m[2]), Number(m[3])];
  return h <= 23 && mi <= 59 ? { date: m[1]!, time: `${m[2]}:${m[3]}` } : undefined;
}

/** The zone's offset from UTC at this instant, in ms (positive east of Greenwich). */
export function offsetMs(zone: string, ms: number): number {
  const c = clockIn(new Date(ms), zone);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute) - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant of a local wall time in a zone. On the day the clocks go forward a time that does not exist (02:30) is the instant it would have been on the old offset (03:30 on the new
 * clock); on the day they go back a time that happens twice (02:30) is its FIRST occurrence. Elsewhere it is plain.
 */
export function wallToUtc(zone: string, date: string, time = "00:00"): number {
  const d = parseDate(date)!;
  const [h, m] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(d.year, d.month - 1, d.day, h, m);
  const before = offsetMs(zone, guess - DAY_MS);
  const after = offsetMs(zone, guess + DAY_MS);
  const valid = [...new Set([guess - before, guess - after])].filter((t) => {
    const c = clockIn(new Date(t), zone);
    return c.year === d.year && c.month === d.month && c.day === d.day && c.hour === h && c.minute === m;
  });
  return valid.length ? Math.min(...valid) : guess - before;
}

/** An instant as the zone's local date and time. */
export function localOf(ms: number, zone: string): { date: string; time: string } {
  const c = clockIn(new Date(ms), zone);
  return { date: formatDate(c), time: `${pad(c.hour)}:${pad(c.minute)}` };
}

export const todayIn = (now: number, zone: string): string => localOf(now, zone).date;

export { isZone };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const weekdayName = (n: number): string => WEEKDAYS[n]!;
export const monthName = (n: number): string => MONTHS[n - 1]!;

/** "Fri 24 Oct" (the year only when it is not the current one), with " 14:30" for a date-time. For what is told to the person and the model: always the conversation's local time. */
export function showLocal(local: string, today: string): string {
  const p = parseLocal(local);
  if (!p) return local;
  const d = parseDate(p.date)!;
  const year = d.year !== parseDate(today)!.year ? ` ${d.year}` : "";
  return `${weekdayName(weekdayOf(p.date))} ${d.day} ${monthName(d.month)}${year}${p.time ? ` ${p.time}` : ""}`;
}

/** An instant as "Fri 24 Oct 09:00" in the zone. */
export function showInstant(ms: number, zone: string, now: number): string {
  const l = localOf(ms, zone);
  return showLocal(`${l.date}T${l.time}`, todayIn(now, zone));
}
