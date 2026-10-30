import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import type { ConvRef } from "../core/convpaths.ts";
import { formatRepeat, nextInstant, type Rule } from "./repeat.ts";
import { addDays, localOf, showInstant } from "./when.ts";

// ONE schedule mechanism: a routine is something the assistant does at set times, declared as DATA by a repeat rule (repeat.ts, the grammar tasks use): a `when:` line in a `routine-` note of a conversation (a person asked "every morning at 8 send
// Anna a pep talk", or set up the daily brief, which is a note that says to run that skill: the look hands what the note says to an expert). This file is the PLANNER and the record. Code computes "is it due" and "was it done" from the clock in the conversation's zone and the
// record (assistant.db routine_runs, one row per routine, keyed by the note's file name); the model only does the work. At most one run per occurrence (the slot's date); a run that
// died is retried once; if the Mac slept through the time the routine still runs once when it wakes, within `catchUpHours` of its time, else that occurrence is skipped (no chat message: the log and the doctor show it) and the next brief says so in one line, once.
// An edited `when:` changes nothing already done: the new rule is read from the next occurrence on (the record is per date, so what ran today does not run again today).

export interface Routine {
  readonly name: string; // the note's file name without .md (routine-pep-talk): the record's key
  readonly rule: Rule;
  readonly instruction: string; // what to do (the note's body)
}

export interface Slot { readonly date: string; readonly at: Date }

const DAY_MS = 86_400_000;
const DEFAULT_TIME = "09:00"; // (a rule without a time, like a task reminder's)
const INSTRUCTION_CHARS = 1500;
const clean = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, INSTRUCTION_CHARS);

// The clock a routine runs on: its rule's zone when it names one, else the conversation's.
const zoneFor = (r: Pick<Routine, "rule">, zone: string): string => r.rule.zone ?? zone;

const whenText = (r: Pick<Routine, "rule">): string => formatRepeat(r.rule.time ? r.rule : { ...r.rule, time: DEFAULT_TIME });

// An interval ("every 2 weeks") counts from the day the planner first saw the routine.
const anchorOf = (rec: { since: number } | undefined, now: Date, zone: string): string => localOf(rec?.since ?? now.getTime(), zone).date;

// The latest slot at or before `now` (looking back eight days) and the first one after it, from `nextInstant` (DST-safe: 18:30 is 18:30 on the wall clock all year).
export function slotsAround(r: Pick<Routine, "rule">, now: Date, conversationZone: string, anchor: string): { last?: Slot; next?: Slot } {
  const zone = zoneFor(r, conversationZone);
  const t = now.getTime();
  const slot = (ms: number): Slot => ({ date: localOf(ms, zone).date, at: new Date(ms) });
  let last: Slot | undefined;
  let after = t - 8 * DAY_MS;
  try {
    for (let i = 0; i < 400; i++) {
      const n = nextInstant(r.rule, after, zone, anchor, DEFAULT_TIME);
      if (n > t) return { ...(last ? { last } : {}), next: slot(n) };
      last = slot(n);
      after = n;
    }
  } catch { /* a rule with no occurrence in reach (repeat.ts nextDate): nothing is due */ }
  return last ? { last } : {};
}

// ---- the record of a routine's last period (assistant.db routine_runs) ----

type RunStatus = "started" | "delivered" | "failed" | "skipped";
export interface RoutineRecord {
  since: number; // UTC ms: when the planner first saw the routine; slots before it are nobody's miss (a note made at 20:00 for 18:30 daily does not owe today's)
  period?: string; // the slot's date the status below is for
  status?: RunStatus;
  at?: number; // UTC ms of the last status change
  attempts: number; // starts in this period
  told: boolean; // a skip has been mentioned to the owner
  lastDelivered?: number; // UTC ms of the last successful run, any period (the doctor)
  owes?: string; // the channel the last run of this period was meant to deliver and did not ("email"): the retry owes only that, and the doctor says so
  chatSent?: true; // that run did tell the chat, so the retry must not
}

export const STALE_MINUTES = 45; // a run still `started` after this long died
const MAX_ATTEMPTS = 2; // starts in one period

export type Plan =
  | { state: "waiting"; next?: Slot }
  | { state: "due"; slot: Slot; retry: boolean }
  | { state: "running"; since: Date }
  | { state: "done"; at: Date }
  | { state: "skipped"; slot: Slot; why: "asleep" | "failed" }; // asleep: past the catch-up window without a run; failed: gave up after MAX_ATTEMPTS

export function planRoutine(r: Routine, now: Date, conversationZone: string, rec: RoutineRecord | undefined, catchUpHours: number): Plan {
  const zone = zoneFor(r, conversationZone);
  const { last, next } = slotsAround(r, now, zone, anchorOf(rec, now, zone));
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

// What the owner sees in /status and the doctor: "every weekday at 18:30, next Tue 27 Oct 18:30".
export function nextText(r: Routine, now: Date, conversationZone: string, rec?: RoutineRecord): string {
  const zone = zoneFor(r, conversationZone);
  const n = slotsAround(r, now, zone, anchorOf(rec, now, zone)).next;
  if (!n) return whenText(r);
  const today = localOf(now.getTime(), zone).date;
  const when = n.date === today ? `today ${localOf(n.at.getTime(), zone).time}` : n.date === addDays(today, 1) ? `tomorrow ${localOf(n.at.getTime(), zone).time}` : showInstant(n.at.getTime(), zone, now.getTime());
  return `${whenText(r)}, next ${when}`;
}

interface Row {
  name: string;
  since: number;
  period: string | null;
  owes: string | null;
  chat_sent: number;
  status: RunStatus | null;
  at: number | null;
  attempts: number;
  told: number;
  last_delivered: number | null;
}

const recordOf = (r: Row): RoutineRecord => ({ since: r.since, ...(r.period ? { period: r.period } : {}), ...(r.status ? { status: r.status } : {}), ...(r.at != null ? { at: r.at } : {}), attempts: r.attempts, told: r.told !== 0, ...(r.owes ? { owes: r.owes } : {}), ...(r.chat_sent ? { chatSent: true as const } : {}), ...(r.last_delivered != null ? { lastDelivered: r.last_delivered } : {}) });

export function readRecord(conv: ConvRef, name: string): RoutineRecord | undefined {
  const row = peekConvDb(conv)?.get<Row>("SELECT * FROM routine_runs WHERE name = ?", name);
  return row ? recordOf(row) : undefined;
}

// The first time the planner sees a routine: its record starts now, so a routine made late in the day owes nothing for the slot it missed.
function ensure(conv: ConvRef, name: string, now: number): RoutineRecord | undefined {
  const db = liveConvDb(conv);
  if (!db) return undefined;
  db.run("INSERT OR IGNORE INTO routine_runs (name, since) VALUES (?, ?)", name, now);
  return recordOf(db.get<Row>("SELECT * FROM routine_runs WHERE name = ?", name)!);
}

interface Planned { readonly routine: Routine; readonly plan: Plan }

// The plan of every routine at `now`. A skip is noted in the record (once), so it can be told once.
function planAll(conv: ConvRef, routines: readonly Routine[], now: Date, zone: string, catchUpHours: number): Planned[] {
  return routines.map((routine) => {
    const rec = ensure(conv, routine.name, now.getTime());
    const plan = planRoutine(routine, now, zone, rec, catchUpHours);
    if (plan.state === "skipped" && (rec?.status !== "skipped" || rec.period !== plan.slot.date)) liveConvDb(conv)?.run("UPDATE routine_runs SET period = ?, status = 'skipped', at = ?, told = 0 WHERE name = ?", plan.slot.date, now.getTime(), routine.name);
    return { routine, plan };
  });
}

// The run was handed over (a note to its expert): one more attempt in this period.
export function markStarted(conv: ConvRef, name: string, period: string, now: number): void {
  const db = liveConvDb(conv);
  const rec = readRecord(conv, name);
  if (!db || !rec) return;
  const attempts = rec.period === period ? rec.attempts + 1 : 1;
  db.run(`UPDATE routine_runs SET period = ?, status = 'started', at = ?, attempts = ?, told = 1${rec.period === period ? "" : ", owes = NULL, chat_sent = 0"} WHERE name = ?`, period, now, attempts, name);
}

// The look ended: the routine it started is delivered, or failed (`refund`: the look was only called off by a message, which is no attempt of the routine's).
export function markFinished(conv: ConvRef, name: string, ok: boolean, now: number, refund = false): void {
  const db = liveConvDb(conv);
  if (!db) return;
  if (ok) db.run("UPDATE routine_runs SET status = 'delivered', owes = NULL, chat_sent = 0, at = ?, last_delivered = ? WHERE name = ? AND status = 'started'", now, now, name);
  else db.run(`UPDATE routine_runs SET status = 'failed', at = ?, attempts = MAX(0, attempts - ?) WHERE name = ? AND status = 'started'`, now, refund ? 1 : 0, name);
}

// A routine that must deliver by a channel (the brief's email) ended without it: it is not complete (the caller marks it failed, so the retry path runs it again), and the record keeps what is owed
// and whether the chat was already told, so the retry is given only the missing channel as a fact and does not send the rest twice.
export function markOwed(conv: ConvRef, name: string, channel: string, chatSent: boolean): void {
  liveConvDb(conv)?.run("UPDATE routine_runs SET owes = ?, chat_sent = ? WHERE name = ? AND status = 'started'", channel, chatSent ? 1 : 0, name);
}

// The end of a look that started routines. Delivered only for those that `finished` (the expert came back with a result); the others are failed, and their
// attempt is given back only when the look was called off (a message, the Mac sleeping) AND nothing of it reached the person: once something went out, the next look must not send it again.
export function settleRoutines(conv: ConvRef, started: ReadonlySet<string>, finished: ReadonlySet<string>, o: { calledOff: boolean; sends: number }, now: number): void {
  for (const name of started) markFinished(conv, name, finished.has(name), now, o.calledOff && o.sends === 0);
}

export function markTold(conv: ConvRef, names: readonly string[]): void {
  const db = liveConvDb(conv);
  for (const n of names) db?.run("UPDATE routine_runs SET told = 1 WHERE name = ? AND status = 'skipped'", n);
}

export interface RoutineFacts {
  text: string; // for the heartbeat instruction; "" when there is nothing to say
  due?: Planned & { plan: Extract<Plan, { state: "due" }> }; // the one to start now
  told: string[]; // skipped routines the text mentions
}

// The routines section of one look's instruction: only what needs the run's attention (a routine that is waiting or done is not mentioned). One routine per look.
export function routineFacts(conv: ConvRef, routines: readonly Routine[], now: Date, zone: string, o: { catchUpHours: number; who: string; approvals?: number }): RoutineFacts {
  const planned = planAll(conv, routines, now, zone, o.catchUpHours);
  const lines: string[] = [];
  let due: RoutineFacts["due"];
  const told: string[] = [];
  const missed: { name: string; line: string }[] = [];
  for (const p of planned) {
    const { routine: r, plan } = p;
    if (plan.state === "running") lines.push(`${r.name}: started ${Math.round((now.getTime() - plan.since.getTime()) / 60_000)} min ago, the expert is still working; wait.`);
    else if (plan.state === "due" && !due) {
      due = p as NonNullable<typeof due>;
      const rec = plan.retry ? readRecord(conv, r.name) : undefined;
      const when = `${whenText(r)}${plan.retry ? (rec?.owes ? `, the earlier attempt finished without its ${rec.owes}` : ", the earlier attempt died") : ""}`;
      const owed = rec?.owes ? ` Code saw no ${rec.owes} sent by the earlier attempt, and the ${rec.owes} is a required part of this routine, not an option: ${rec.chatSent ? `the chat message has already gone to ${o.who}, so ONLY the ${rec.owes} is owed: deliver it as your brief says and send nothing else; the final answer is [[silent]]` : `deliver the ${rec.owes} as your brief says; it is not complete without it`}.` : "";
      const what = `holds the note's instruction word for word (${clean(r.instruction)}), who it is for and the voice or format it asks for`;
      lines.push(`${r.name}: due now (${when}). Delegate it now: call the Agent tool with subagent_type "expert" (or the expert named for a heavy skill the note runs) and a self-contained brief that ${what}, today's date and that every time it writes is exactly as the clock line gives it (that zone, no conversion). Its final answer is the message for ${o.who} (or [[silent]]); pass it on unchanged.${owed}${o.approvals ? ` Code counted ${o.approvals} open approval${o.approvals === 1 ? "" : "s"} waiting for ${o.who}.` : ""}`);
    } else if (plan.state === "due") lines.push(`${r.name}: also due, but one routine per look: leave it for the next look (code makes it due again by itself).`);
    else if (plan.state === "skipped") {
      const row = readRecord(conv, r.name);
      if (row && !row.told) missed.push({ name: r.name, line: `${r.name} did not run on ${plan.slot.date} (${plan.why === "asleep" ? "the Mac was asleep past its time" : "two attempts failed"}) and will not be redone` });
    }
  }
  // A missed routine is system status: the person has nothing to do, so it is no message of its own (the log and the doctor show it, routineStatus). It rides along, as ONE line, with the next routine message
  // a look delegates; it is counted as told then, and waits for that look while no routine is due.
  if (due && missed.length) {
    told.push(...missed.map((m) => m.name));
    lines.push(`Missed, nothing for ${o.who} to do: ${missed.map((m) => m.line).join("; ")}. Put it as one short line in the message the expert writes now, if that message is a brief (daily brief, evening wrap, weekly review); for any other routine say nothing about it.`);
  }
  return { text: lines.join(" "), ...(due ? { due } : {}), told };
}

// The routines as STATUS for any run (a chat turn, a look, an expert): due, running, delivered at, skipped, or when next. Read-only: only the look starts, records and settles a routine.
export function routineStatus(conv: ConvRef, routines: readonly Routine[], now: Date, zone: string, catchUpHours: number): string {
  const lines = routines.map((r) => {
    const z = zoneFor(r, zone); // (times in the rule's own zone are named: "today 08:05 Europe/Zurich")
    const at = (d: Date): string => {
      const l = localOf(d.getTime(), z);
      return `${l.date === localOf(now.getTime(), z).date ? "today" : l.date} ${l.time}${r.rule.zone ? ` ${z}` : ""}`;
    };
    const rec = readRecord(conv, r.name);
    const plan = planRoutine(r, now, zone, rec, catchUpHours);
    const what = plan.state === "due" ? `due now${plan.retry ? (rec?.owes ? ` (the earlier attempt sent no ${rec.owes})` : " (the earlier attempt died)") : ""}` : plan.state === "running" ? `a look started it at ${at(plan.since)} and it is being produced` : plan.state === "done" ? `delivered ${at(plan.at)}` : plan.state === "skipped" ? `did not run on ${plan.slot.date} (${plan.why === "asleep" ? "the Mac was asleep past its time" : `two attempts failed${rec?.owes ? `, the ${rec.owes} was never sent` : ""}`})` : `next: ${nextText(r, now, zone, rec)}`;
    return `${r.name}: ${what}`;
  });
  return lines.length ? `Routines, status only (code schedules them; use this to answer "did my brief go out?" or to avoid repeating what one is about to say):\n${lines.join("\n")}` : "";
}

// "/status" and the doctor: one line per routine with its schedule, next run and last run.
export function routineLines(conv: ConvRef, routines: readonly Routine[], now: Date, zone: string): string[] {
  return routines.map((r) => `${r.name}: ${nextText(r, now, zone, readRecord(conv, r.name))}; last ${lastRun(conv, r, zone)}`);
}

// "10-22 18:31", "failed (2026-10-22)", "not yet": the last run of a routine, from the record.
function lastRun(conv: ConvRef, r: Routine, conversationZone: string): string {
  const zone = zoneFor(r, conversationZone);
  const rec = readRecord(conv, r.name);
  if (rec?.lastDelivered) return `${localOf(rec.lastDelivered, zone).date.slice(5)} ${localOf(rec.lastDelivered, zone).time}${rec.status === "failed" || rec.status === "skipped" ? `, then ${rec.status} (${rec.period}${rec.owes ? `, ${rec.owes} not sent` : ""})` : ""}`;
  return rec?.status ? `${rec.status} (${rec.period}${rec.owes ? `, ${rec.owes} not sent` : ""})` : "not yet";
}
