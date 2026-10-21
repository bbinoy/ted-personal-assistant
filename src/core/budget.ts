import { takeCapNotice } from "./capnotice.ts";
import { localDay } from "./pause.ts";
import { settings } from "./settings.ts";
import { groupConvId, instancePaths } from "./convpaths.ts";
import { readJson, writeJson } from "./state.ts";

// A runaway guard, not an accounting system. Costs are the SDK's own estimates (notional on a
// subscription). Once the day's total passes the ceiling, BACKGROUND work (brief, mail handler)
// stops until tomorrow. Chat stays available: you are in control of that.
// Synchronous on purpose (see state.ts): concurrent recordCost calls can never lose an update.

const FILE = instancePaths().cost;

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

// ---- the two aggregate ceilings ----
// Per group (a group runs on the owner's login, so a noisy one would otherwise spend the owner's whole day and stop her brief) and across all tenants (each has her own ceiling, but
// together they spend one key): a ledger each, written by payer.ts charge(), read by payer.ts mayRun() and by group.ts before a group's run.
const GROUP_FILE = instancePaths().groupCost; // keyed by the group's convId, never its raw id
const KEY_FILE = instancePaths().keyCost;
interface GroupCost {
  day: string;
  usd: Record<string, number>;
}
const groupDay = (): GroupCost => {
  const day = localDay(new Date());
  const c = readJson<GroupCost | undefined>(GROUP_FILE, undefined);
  return c?.day === day ? c : { day, usd: {} };
};
export function recordGroupCost(groupId: string, usd: number): void {
  if (!(usd > 0)) return;
  const c = groupDay();
  const key = groupConvId(groupId);
  c.usd[key] = (c.usd[key] ?? 0) + usd;
  writeJson(GROUP_FILE, c);
}
export const groupSpentToday = (groupId: string): number => groupDay().usd[groupConvId(groupId)] ?? 0;
export const groupOverBudget = (groupId: string): boolean => groupSpentToday(groupId) >= settings.groupDailyBudgetUsd;
export const recordKeyCost = (usd: number): void => recordCost(usd, KEY_FILE);
export const instanceKeyOverBudget = (): boolean => spentToday(KEY_FILE) >= settings.instanceKeyDailyUsd;

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
export const GROUP_BUDGET_TEXT = `I've used up my budget for today, so I can't answer until tomorrow. ${settings.owner} can raise it if it is urgent.`;
// (kept in instance/cap-notices.json like the other once-a-day notices, so a restart does not say it twice)
export const groupBudgetDue = (groupId: string, now: Date = new Date()): boolean => takeCapNotice(`group-budget:${groupConvId(groupId)}`, now.getTime());

// A forgotten group: its day's spend goes from the ledger. True when it had an entry.
export function forgetGroupCost(conv: string): boolean {
  const c = readJson<GroupCost | undefined>(GROUP_FILE, undefined);
  if (!c || !Object.hasOwn(c.usd, conv)) return false;
  delete c.usd[conv];
  writeJson(GROUP_FILE, c);
  return true;
}
