import { parseWhen, type Days, type Preset } from "./preset.ts";
import { clockIn, dayAt, systemZone, timeIn } from "./timezone.ts";

// Routines: what the assistant does on a schedule, as DATA: {name, when (local time + days), skill (a plugin skill), delivery (the chat message, and optionally an email to the owner themself), enabled}.
// This file is the PLANNER, pure: given the clock, the conversation's zone and the record of the last run it says whether a routine is due, running, done or skipped, so the model never
// compares a date or a time (the look hands it the line). The daily brief is a routine like the others (its time is the preset's rhythm, its email BRIEF_EMAIL); routine_runs is the one record
// of started / delivered / failed. At most one run per period: the day for a daily or weekdays routine, the week's occurrence for a weekly one. If the Mac slept
// through the time the routine still runs once when it wakes, within `catchUpHours` of its time; after that the period is skipped and the next brief says so in one line.

export type Name = string;
export interface Routine {
  readonly name: Name;
  readonly time: string; // "18:30", the conversation's local time
  readonly days: Days;
  readonly skill: string; // plain plugin skill name
  readonly email: boolean; // also mailed to the owner themself (the chat message is always sent)
  readonly enabled: boolean;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const whenText = (r: Pick<Routine, "time" | "days">): string => (typeof r.days === "number" ? `${DAYS[r.days]}s ${r.time}` : r.days === "weekdays" ? `${r.time} on weekdays` : `${r.time} daily`);

type Env = Readonly<Record<string, string | undefined>>;

// ROUTINE_<NAME>=off | 18:30 | "18:30 weekdays" | "fri 16:30" (a bare time keeps the preset's days), ROUTINE_<NAME>_EMAIL=on|off. The brief: its time is the preset's rhythm, its email BRIEF_EMAIL.
export function resolveRoutines(env: Env, p: Preset, briefEmail: boolean): Routine[] {
  const brief: Routine = { name: "brief", time: p.rhythm.heartbeat.briefTime, days: "daily", skill: "daily-brief", email: briefEmail, enabled: true };
  const out: Routine[] = [brief];
  for (const [name, d] of Object.entries(p.routines)) {
    const key = `ROUTINE_${name.toUpperCase().replace(/-/g, "_")}`;
    const base = parseWhen(d.when)!;
    let { time, days } = { time: base.time, days: base.days ?? ("daily" as Days) };
    let enabled = d.enabled;
    const raw = env[key]?.trim();
    if (raw) {
      if (raw.toLowerCase() === "off") enabled = false;
      else {
        const w = parseWhen(raw);
        if (!w) throw new Error(`${key} must be off, a time like 18:30, or a time with days like "18:30 weekdays" or "fri 16:30" (got "${raw}")`);
        enabled = true;
        time = w.time;
        days = w.days ?? days;
      }
    }
    const mail = env[`${key}_EMAIL`]?.trim().toLowerCase();
    if (mail && mail !== "on" && mail !== "off") throw new Error(`${key}_EMAIL must be on or off (got "${mail}")`);
    out.push({ name, time, days, skill: d.skill, email: mail ? mail === "on" : d.email, enabled });
  }
  return out;
}

// ---- the clock: when a routine's slot falls, in the conversation's zone (a day is not 24 hours across a clock change) ----

// The instant of `time` on calendar day `date` ("2026-10-25") in `zone`. A time the clock skips (spring forward) lands on the same day next to the gap; one it repeats (fall back) on the first.
export function localInstant(date: string, time: string, zone: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const c = clockIn(new Date(t), zone);
    const got = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute);
    if (got === want) break;
    t -= got - want;
  }
  return new Date(t);
}

const runsOn = (days: Days, weekday: number): boolean => days === "daily" || (days === "weekdays" ? weekday >= 1 && weekday <= 5 : days === weekday);

export interface Slot { readonly date: string; readonly at: Date }

// The latest slot at or before `now` (looking back a week), and the first one after it.
export function slotsAround(r: Pick<Routine, "time" | "days">, now: Date, zone: string): { last?: Slot; next?: Slot } {
  let last: Slot | undefined, next: Slot | undefined;
  for (let k = 0; k >= -8 && !last; k--) {
    const d = dayAt(now, k, zone);
    if (!runsOn(r.days, d.weekday)) continue;
    const at = localInstant(d.date, r.time, zone);
    if (at.getTime() <= now.getTime()) last = { date: d.date, at };
  }
  for (let k = 0; k <= 8 && !next; k++) {
    const d = dayAt(now, k, zone);
    if (!runsOn(r.days, d.weekday)) continue;
    const at = localInstant(d.date, r.time, zone);
    if (at.getTime() > now.getTime()) next = { date: d.date, at };
  }
  return { ...(last ? { last } : {}), ...(next ? { next } : {}) };
}

// ---- the record of a routine's last period (assistant.db routine_runs; tasks/routines.ts) ----

export type RunStatus = "started" | "delivered" | "failed" | "skipped";
export interface RoutineRecord {
  since: number; // UTC ms: when the planner first saw the routine; slots before it are nobody's miss (a routine switched on at 20:00 does not owe the 18:30 one)
  period?: string; // the slot's date the status below is for
  status?: RunStatus;
  at?: number; // UTC ms of the last status change
  attempts: number; // starts in this period
  told: boolean; // a skip has been mentioned to the owner
  lastDelivered?: number; // UTC ms of the last successful run, any period (the doctor)
}

export const STALE_MINUTES = 45; // a run still `started` after this long died (the same rule as the brief's note)
export const MAX_ATTEMPTS = 2; // starts in one period, the brief's rule too

export type Plan =
  | { state: "off" }
  | { state: "waiting"; next?: Slot }
  | { state: "due"; slot: Slot; retry: boolean }
  | { state: "running"; since: Date }
  | { state: "done"; at: Date }
  | { state: "skipped"; slot: Slot; why: "asleep" | "failed" }; // asleep: past the catch-up window without a run; failed: gave up after MAX_ATTEMPTS

export function planRoutine(r: Routine, now: Date, zone: string = systemZone(), rec: RoutineRecord | undefined, catchUpHours: number): Plan {
  if (!r.enabled) return { state: "off" };
  const { last, next } = slotsAround(r, now, zone);
  if (!last || !rec || last.at.getTime() < rec.since) return { state: "waiting", ...(next ? { next } : {}) };
  const mine = rec.period === last.date ? rec : undefined;
  const late = now.getTime() - last.at.getTime() > catchUpHours * 3_600_000;
  if (mine?.status === "delivered") return { state: "done", at: new Date(mine.at ?? last.at.getTime()) };
  if (mine?.status === "skipped") return { state: "skipped", slot: last, why: mine.attempts >= MAX_ATTEMPTS ? "failed" : "asleep" };
  const stale = mine?.status === "started" && now.getTime() - (mine.at ?? 0) > STALE_MINUTES * 60_000;
  if (mine?.status === "started" && !stale) return { state: "running", since: new Date(mine.at!) };
  const attempts = mine?.attempts ?? 0;
  if (attempts >= MAX_ATTEMPTS) return { state: "skipped", slot: last, why: "failed" };
  if (late) return { state: "skipped", slot: last, why: "asleep" };
  return { state: "due", slot: last, retry: attempts > 0 };
}

// What the owner sees in /status and the doctor: "evening: 18:30 on weekdays, next Thursday 22 Oct 18:30, last ran Wed 18:31".
export function nextText(r: Routine, now: Date, zone: string): string {
  if (!r.enabled) return "off";
  const n = slotsAround(r, now, zone).next;
  if (!n) return whenText(r);
  const d = dayAt(n.at, 0, zone);
  const today = dayAt(now, 0, zone).date;
  const tomorrow = dayAt(now, 1, zone).date;
  return `${whenText(r)}, next ${n.date === today ? "today" : n.date === tomorrow ? "tomorrow" : `${DAYS[d.weekday]!.slice(0, 3)} ${n.date.slice(5)}`} ${timeIn(n.at, zone)}`;
}
