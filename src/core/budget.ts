import { localDay } from "./pause.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";

// A runaway guard, not an accounting system. Costs are the SDK's own estimates (notional on a
// subscription). Once the day's total passes the ceiling, BACKGROUND work (brief, mail handler)
// stops until tomorrow. Chat stays available: you are in control of that.
// Synchronous on purpose (see state.ts): concurrent recordCost calls can never lose an update.

const FILE = "state/cost.json";

interface Cost {
  day: string;
  usd: number;
  notifiedDay?: string;
}

// `file`: another ledger of the same shape. A tenant has her own (tenants.ts), so what she spends on the instance key never counts against the
// instance's guard, and the instance's never against hers.
function today(file: string = FILE): Cost {
  const day = localDay(new Date());
  const c = readJson<Cost | undefined>(file, undefined);
  return c?.day === day ? c : { day, usd: 0 };
}

export function recordCost(usd: number, file: string = FILE): void {
  if (!(usd > 0)) return;
  const c = today(file);
  c.usd += usd;
  writeJson(file, c);
}

export function spentToday(file: string = FILE): number {
  return today(file).usd;
}

// A tenant's day: spent so far against her own ceiling (0: no spending allowed at all).
export const tenantOverBudget = (file: string, limitUsd: number): boolean => today(file).usd >= limitUsd;

// `firstTime` is true once per day, so the caller can tell the owner exactly once.
export function overBudget(): { over: boolean; firstTime: boolean; usd: number } {
  const c = today();
  const over = c.usd >= settings.dailyBudgetUsd;
  const firstTime = over && c.notifiedDay !== c.day;
  if (firstTime) writeJson(FILE, { ...c, notifiedDay: c.day });
  return { over, firstTime, usd: c.usd };
}

// Just the question, without the once-a-day "tell the owner" side effect of overBudget (only the code that
// can tell the owner should use that one, or a group message could use up the notice).
export const budgetSpent = (): boolean => today().usd >= settings.dailyBudgetUsd;

// A group: one short line per group per day, when someone addressed it and the budget turned the answer away (group.ts). Returns whether to say it now.
const groupTold = new Map<string, string>();
export const GROUP_BUDGET_TEXT = `I've used up my budget for today, so I can't answer until tomorrow. ${settings.owner} can raise it if it is urgent.`;
export function groupBudgetDue(groupId: string, now: Date = new Date()): boolean {
  const day = localDay(now);
  if (groupTold.get(groupId) === day) return false;
  groupTold.set(groupId, day);
  return true;
}
