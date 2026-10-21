import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./state.ts";
import { clockIn } from "./timezone.ts";

// The retention job: one registry of "remove what has outlived its window" rules and the scheduler that runs the due ones once a day at a quiet time. A rule is a small synchronous function
// (cheap, chunked by being one folder at a time) that returns what it removed; heartbeat/retentionrules.ts has the file-based ones, and a store that lives somewhere else (a ledger, a table) registers
// its own pruning with registerRetention. The job never runs during a chat turn (the trigger is given a `busy` check), takes no model run, and a rule that throws is recorded and does not stop the others.
// `--dry-run` runs every rule in a mode where it only lists what it WOULD remove (npm run retention). RETENTION=off disables the scheduler (the CLI still works, by hand).

export interface RetentionResult {
  removed: number; // files (or lines, or rows) taken away
  freedBytes: number;
  notes?: string; // one short phrase: what was removed, or why the rule did nothing
}

export interface RetentionRule {
  name: string; // short and stable: it is the key of the state file and the word in the log line
  everyHours: number; // how often it is due (the scheduler offers it once a day; a weekly rule says 168)
  /** `dryRun`: remove NOTHING, only count and say what would go. */
  run(now: Date, o: { dryRun: boolean }): RetentionResult;
}

const rules = new Map<string, RetentionRule>();

/** Add a rule (or replace the one of the same name: registering twice is harmless). */
export const registerRetention = (rule: RetentionRule): void => void rules.set(rule.name, rule);
export const retentionRules = (): RetentionRule[] => [...rules.values()];
/** Tests: forget every rule. */
export const clearRetention = (): void => rules.clear();

// ---- the state: when each rule last ran and what it freed ----

export interface RuleState {
  at: string; // ISO time of its last run
  removed: number;
  freedBytes: number;
  notes?: string;
  error?: string;
}
export interface RetentionState {
  lastRunAt?: string;
  lastFreedBytes?: number;
  lastRemoved?: number;
  rules: Record<string, RuleState>;
}

export function readRetentionState(file: string): RetentionState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RetentionState>;
    return { ...raw, rules: raw.rules && typeof raw.rules === "object" ? raw.rules : {} };
  } catch {
    return { rules: {} }; // none yet, or damaged: every rule is due, which is harmless (they only remove what is past its window)
  }
}

/** Pure: is the rule due? 10 % slack, so a daily rule that ran at 03:30:12 yesterday is due at 03:30:05 today. */
export function isDue(rule: RetentionRule, last: RuleState | undefined, now: Date): boolean {
  if (!last) return true;
  const at = Date.parse(last.at);
  return !Number.isFinite(at) || now.getTime() - at >= rule.everyHours * 3_600_000 * 0.9;
}

export const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 2 : 1)} MB`;

export interface RunOptions {
  stateFile: string;
  dryRun?: boolean;
  force?: boolean; // run every rule whether due or not (--now, --dry-run)
  log?: (line: string) => void;
}
export interface RunReport {
  ran: { name: string; result: RetentionResult; error?: string }[];
  skipped: string[]; // not due
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** Runs the due rules (all, when forced), one at a time with the event loop free in between; records each; logs one summary line. Never throws. */
export async function runRetention(now: Date, o: RunOptions): Promise<RunReport> {
  const log = o.log ?? ((l: string) => console.log(l));
  const state = readRetentionState(o.stateFile);
  const report: RunReport = { ran: [], skipped: [] };
  for (const rule of retentionRules()) {
    if (!o.force && !isDue(rule, state.rules[rule.name], now)) {
      report.skipped.push(rule.name);
      continue;
    }
    await yieldToLoop();
    let result: RetentionResult = { removed: 0, freedBytes: 0 };
    let error: string | undefined;
    try {
      result = rule.run(now, { dryRun: !!o.dryRun });
    } catch (e) {
      error = (e as Error).message.slice(0, 200);
    }
    report.ran.push({ name: rule.name, result, ...(error ? { error } : {}) });
    if (!o.dryRun) state.rules[rule.name] = { at: now.toISOString(), removed: result.removed, freedBytes: result.freedBytes, ...(result.notes ? { notes: result.notes } : {}), ...(error ? { error } : {}) };
  }
  const removed = report.ran.reduce((n, r) => n + r.result.removed, 0);
  const freed = report.ran.reduce((n, r) => n + r.result.freedBytes, 0);
  if (!o.dryRun && report.ran.length) {
    state.lastRunAt = now.toISOString();
    state.lastRemoved = removed;
    state.lastFreedBytes = freed;
    try {
      writeFileAtomic(o.stateFile, JSON.stringify(state));
    } catch (e) {
      log(`retention: could not record the run: ${(e as Error).message}`);
    }
  }
  const parts = report.ran.map((r) => `${r.name} ${r.error ? `FAILED (${r.error})` : r.result.removed}`);
  log(`retention${o.dryRun ? " (dry run: nothing removed)" : ""}: ${o.dryRun ? "would remove" : "removed"} ${removed} item(s), ${o.dryRun ? "would free" : "freed"} ${megabytes(freed)}${parts.length ? ` [${parts.join(", ")}]` : " (no rule was due)"}`);
  return report;
}

// ---- the scheduler ----

export const RETENTION_AT_MINUTES = 3 * 60 + 30; // 03:30 on the owner's clock: after the quiet hours begin, before the dream (DREAM_HOUR, 4) and the morning

/**
 * A tick job like the dream's (conversation/dream.ts dreamTrigger): the first tick at or after 03:30 local runs it, once per local day (the day of the last run is in the state file, so a restart does not
 * repeat it). `busy`: true while a chat turn is in progress, then the tick waits for the next one. `enabled`: RETENTION. Everything is injectable for tests.
 */
export function retentionTrigger(run: (now: Date) => unknown, o: { stateFile: string; enabled?: () => boolean; busy?: () => boolean; atMinutes?: number; zone?: string }) {
  let tried: string | undefined; // the day this process already started a run on
  return (now: Date = new Date()): unknown => {
    if (o.enabled && !o.enabled()) return undefined;
    const c = clockIn(now, o.zone);
    if (c.hour * 60 + c.minute < (o.atMinutes ?? RETENTION_AT_MINUTES)) return undefined;
    const day = `${c.year}-${c.month}-${c.day}`;
    if (tried === day) return undefined;
    const last = readRetentionState(o.stateFile).lastRunAt;
    if (last) {
      const l = clockIn(new Date(last), o.zone);
      if (`${l.year}-${l.month}-${l.day}` === day && l.hour * 60 + l.minute >= (o.atMinutes ?? RETENTION_AT_MINUTES)) return undefined; // already ran today, after the hour
    }
    if (o.busy?.()) return undefined; // a chat turn is running: the next tick
    tried = day;
    return run(now);
  };
}

// ---- for the doctor ----

/** Pure: the doctor's one line. `ok`: false only for a rule that failed in its last run. */
export function retentionSummary(state: RetentionState, enabled: boolean, localTime: (iso: string) => string): { ok: boolean | "warn"; detail: string } {
  const failed = Object.entries(state.rules).filter(([, r]) => r.error).map(([n]) => n);
  const last = state.lastRunAt ? `last run ${localTime(state.lastRunAt)}, removed ${state.lastRemoved ?? 0} item(s), freed ${megabytes(state.lastFreedBytes ?? 0)}` : "not run yet (first run at 03:30)";
  if (!enabled) return { ok: "warn", detail: `off (RETENTION=off): logs, attachments and backups grow without limit; ${last}` };
  if (failed.length) return { ok: "warn", detail: `${last}; failed: ${failed.join(", ")}` };
  return { ok: true, detail: `daily at 03:30; ${last}` };
}
