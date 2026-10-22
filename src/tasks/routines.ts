import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import type { ConvRef } from "../core/convpaths.ts";
import { planRoutine, whenText, nextText, type Plan, type Routine, type RoutineRecord, type RunStatus } from "../core/routines.ts";
import { dayAt, timeIn } from "../core/timezone.ts";
import { PLUGIN } from "../core/preset.ts";

// The scheduling of the routines besides the brief (core/routines.ts plans, this file remembers and words it). The record is one row per routine in the conversation's assistant.db
// (routine_runs): code writes it, never the model. A look asks `routineFacts` for its instruction; the run that delegates a due routine's expert is marked started at that moment
// (`started`), and when the look ends it is marked delivered or failed. So a routine runs once per period whatever the model does, a dead run is retried (twice), and a Mac that slept
// through the time runs it on waking (within the catch-up window) or skips it and says so once.

interface Row {
  name: string;
  since: number;
  period: string | null;
  status: RunStatus | null;
  at: number | null;
  attempts: number;
  told: number;
  last_delivered: number | null;
}

const recordOf = (r: Row): RoutineRecord => ({ since: r.since, ...(r.period ? { period: r.period } : {}), ...(r.status ? { status: r.status } : {}), ...(r.at != null ? { at: r.at } : {}), attempts: r.attempts, told: r.told !== 0, ...(r.last_delivered != null ? { lastDelivered: r.last_delivered } : {}) });

export function readRecord(conv: ConvRef, name: string): RoutineRecord | undefined {
  const row = peekConvDb(conv)?.get<Row>("SELECT * FROM routine_runs WHERE name = ?", name);
  return row ? recordOf(row) : undefined;
}

// The first time the planner sees a routine: its record starts now, so a routine switched on late in the day owes nothing for the slot it missed.
function ensure(conv: ConvRef, name: string, now: number): RoutineRecord | undefined {
  const db = liveConvDb(conv);
  if (!db) return undefined;
  db.run("INSERT OR IGNORE INTO routine_runs (name, since) VALUES (?, ?)", name, now);
  return recordOf(db.get<Row>("SELECT * FROM routine_runs WHERE name = ?", name)!);
}

export interface Planned { readonly routine: Routine; readonly plan: Plan }

// The plan of every enabled, planned routine at `now`. A skip is noted in the record (once), so it can be told once.
export function planAll(conv: ConvRef, routines: readonly Routine[], now: Date, zone: string, catchUpHours: number): Planned[] {
  const out: Planned[] = [];
  for (const routine of routines) {
    if (!routine.planned || !routine.enabled) continue;
    const rec = ensure(conv, routine.name, now.getTime());
    const plan = planRoutine(routine, now, zone, rec, catchUpHours);
    if (plan.state === "skipped" && (rec?.status !== "skipped" || rec.period !== plan.slot.date)) liveConvDb(conv)?.run("UPDATE routine_runs SET period = ?, status = 'skipped', at = ?, told = 0 WHERE name = ?", plan.slot.date, now.getTime(), routine.name);
    out.push({ routine, plan });
  }
  return out;
}

// The run was handed to its expert: one more attempt in this period.
export function markStarted(conv: ConvRef, name: string, period: string, now: number): void {
  const db = liveConvDb(conv);
  const rec = readRecord(conv, name);
  if (!db || !rec) return;
  const attempts = rec.period === period ? rec.attempts + 1 : 1;
  db.run("UPDATE routine_runs SET period = ?, status = 'started', at = ?, attempts = ?, told = 1 WHERE name = ?", period, now, attempts, name);
}

// The look ended: the routine it started is delivered, or failed (`refund`: the look was only called off by a message, which is no attempt of the routine's).
export function markFinished(conv: ConvRef, name: string, ok: boolean, now: number, refund = false): void {
  const db = liveConvDb(conv);
  if (!db) return;
  if (ok) db.run("UPDATE routine_runs SET status = 'delivered', at = ?, last_delivered = ? WHERE name = ? AND status = 'started'", now, now, name);
  else db.run(`UPDATE routine_runs SET status = 'failed', at = ?, attempts = MAX(0, attempts - ?) WHERE name = ? AND status = 'started'`, now, refund ? 1 : 0, name);
}

// The end of a look that handed routines to their experts. Delivered only for those whose expert's result came back (`finished`); the others are failed, and their attempt is
// given back only when the look was called off (a message, the Mac sleeping) AND nothing of it reached the owner: once the expert finished, or a send or the self-email went out, the next look must not send it again.
export function settleRoutines(conv: ConvRef, started: ReadonlySet<string>, finished: ReadonlySet<string>, o: { calledOff: boolean; sends: number }, now: number): void {
  for (const name of started) markFinished(conv, name, finished.has(name), now, o.calledOff && o.sends === 0);
}

export function markTold(conv: ConvRef, names: readonly string[]): void {
  const db = liveConvDb(conv);
  for (const n of names) db?.run("UPDATE routine_runs SET told = 1 WHERE name = ? AND status = 'skipped'", n);
}

// The expert a delegation names -> the routine it runs, if any (variantOf: "expert-<skill>").
export const routineOfAgent = (routines: readonly Routine[], agent: string, agentOf: (skill: string) => string): Routine | undefined => routines.find((r) => r.planned && agentOf(r.skill) === agent);

const label = (r: Routine): string => `${r.name} (${whenText(r)})`;

export interface RoutineFacts {
  text: string; // for the heartbeat instruction; "" when there is nothing to say
  due?: Planned & { plan: Extract<Plan, { state: "due" }> }; // the one to delegate now
  told: string[]; // skipped routines the text mentions
}

// The routines section of one look's instruction: only what needs the run's attention (a routine that is waiting, done or off is not mentioned). `deliver`: how the full version reaches the owner by email, when it should.
export function routineFacts(conv: ConvRef, routines: readonly Routine[], now: Date, zone: string, o: { catchUpHours: number; who: string; agentOf: (skill: string) => string; approvals?: number; emailHow?: () => string }): RoutineFacts {
  const planned = planAll(conv, routines, now, zone, o.catchUpHours);
  const lines: string[] = [];
  let due: RoutineFacts["due"];
  const told: string[] = [];
  for (const p of planned) {
    const { routine: r, plan } = p;
    if (plan.state === "running") lines.push(`${r.name}: started ${Math.round((now.getTime() - plan.since.getTime()) / 60_000)} min ago, the expert is still working; wait.`);
    else if (plan.state === "due" && !due) {
      due = p as NonNullable<typeof due>;
      const mail = r.email && o.emailHow ? ` Also email the full version to ${o.who} themself: ${o.emailHow()}` : "";
      lines.push(`${r.name}: due now (${whenText(r)}${plan.retry ? ", the earlier attempt died" : ""}). Delegate it now: call the Agent tool with subagent_type "${o.agentOf(r.skill)}" and a self-contained brief that names the skill ${PLUGIN}:${r.skill}, today's date, and that this routine only reads and tells ${o.who}: it changes nothing and sends nothing but its result to ${o.who}. Its final answer is the short chat message for ${o.who} (or [[silent]]); pass it on unchanged.${o.approvals !== undefined ? ` Code counted ${o.approvals} open approval${o.approvals === 1 ? "" : "s"} waiting for ${o.who}.` : ""}${mail}`);
    } else if (plan.state === "due") lines.push(`${r.name}: also due, but one routine per look: leave it for the next look.`);
    else if (plan.state === "skipped") {
      const row = readRecord(conv, r.name);
      if (row && !row.told) {
        told.push(r.name);
        lines.push(`${r.name}: did not run on ${plan.slot.date} (${plan.why === "asleep" ? "the Mac was asleep past its time" : "two attempts failed"}); it will not be redone. Tell ${o.who} in one line, in the brief you delegate or in your own message if no brief is due today.`);
      }
    }
  }
  return { text: lines.join(" "), ...(due ? { due } : {}), told };
}

// "/status" and the doctor: one line per routine with its schedule, next run and last run.
export function routineLines(conv: ConvRef, routines: readonly Routine[], now: Date, zone: string, briefLast: string): string[] {
  return routines.map((r) => {
    const last = r.planned ? lastRun(conv, r, zone) : briefLast;
    return `${r.name}: ${nextText(r, now, zone)}${r.enabled ? `; last ${last}` : ""}${r.email && r.enabled ? "; also by email" : ""}`;
  });
}

// "10-22 18:31", "failed (2026-10-22)", "not yet": the last run of a planned routine, from the record (the brief's is its status note's: statusnote.ts lastStatusText).
export function lastRun(conv: ConvRef, r: Routine, zone: string): string {
  const rec = readRecord(conv, r.name);
  if (rec?.lastDelivered) return `${dayAt(new Date(rec.lastDelivered), 0, zone).date.slice(5)} ${timeIn(new Date(rec.lastDelivered), zone)}${rec.status === "failed" || rec.status === "skipped" ? `, then ${rec.status} (${rec.period})` : ""}`;
  return rec?.status ? `${rec.status} (${rec.period})` : "not yet";
}
