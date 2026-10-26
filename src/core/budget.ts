import { takeCapNotice } from "./capnotice.ts";
import { localDay } from "./pause.ts";
import { settings } from "./settings.ts";
import { groupConvId, isConvId, OWNER_CONV, type ConvId } from "./convpaths.ts";
import { instanceDb } from "./instancedb.ts";

// A runaway guard, not an accounting system. Costs are the SDK's own estimates (notional on a
// subscription). Once the day's total passes the ceiling, BACKGROUND work (brief, mail handler)
// stops until tomorrow. Chat stays available: you are in control of that.
// Synchronous on purpose (see state.ts): concurrent recordCost calls can never lose an update (one INSERT each, in instance.db).
//
// ONE ledger, the `spend` table of instance.db (core/instancedb.ts): a row per charged run, with the payer, the conversation, the kind of run and the local day. Every ceiling is an
// indexed sum of it, so the four that used to be four files (the owner's day, the instance key's day, a group's day, a friend's day) cannot drift apart:
//   owner today        payer 'login', every conversation (the owner's chat, her background work and the groups, which run on her login)   -> DAILY_BUDGET_USD
//   a group today      payer 'login', that group's convId                                                                                    -> GROUP_DAILY_BUDGET_USD
//   the key today      payer 'key', every friend                                                                                             -> INSTANCE_KEY_DAILY_USD
//   a friend today     payer 'key', her convId                                                                                               -> her own ceiling
// (a group's run counts toward both the group's day and the owner's, as before; a friend's toward both her day and the key's)

// FAIL CLOSED: when the ledger cannot be read (the degraded mode of a damaged instance.db, a database that stays busy or a full disk) every day's sum is "infinite", so background work, browse and a
// friend's runs are refused as if the budget were spent, and nothing throws into a run. A charge that cannot be written is logged (once per kind of failure per minute), not raised: the run it paid for is done.
let lastLogged = 0;
const logFailure = (what: string, e: unknown): void => {
  if (Date.now() - lastLogged < 60_000) return;
  lastLogged = Date.now();
  console.error(`budget: ${what} failed (${(e as Error).message}); background work and payments stay refused until the ledger works`);
};
const closed = <T>(f: () => T, fallback: T): T => {
  try {
    return f();
  } catch (e) {
    logFailure("reading the spend ledger", e);
    return fallback;
  }
};

// (a sum of many small float charges is rounded to a millionth of a dollar: 0.30000000000000004 is never shown or compared)
const cents = (x: number): number => Math.round(x * 1e6) / 1e6;

export type Payer = "login" | "key";
export interface SpendRow {
  usd: number;
  conv?: ConvId; // default: the owner's
  payer?: Payer; // default: a friend's conversation is paid by the key, anything else by the login
  kind?: string; // chat, look, dream, gate, helper, mail ... (default "run")
  now?: Date;
}
const payerOf = (conv: ConvId): Payer => (conv.startsWith("friend-") ? "key" : "login");

export function recordSpend(r: SpendRow): void {
  if (!(r.usd > 0)) return;
  const conv = r.conv ?? OWNER_CONV;
  const now = r.now ?? new Date();
  try {
    instanceDb().run("INSERT INTO spend (at, day, conv, payer, kind, usd) VALUES (?, ?, ?, ?, ?, ?)", now.getTime(), localDay(now), conv, r.payer ?? payerOf(conv), r.kind ?? "run", r.usd);
  } catch (e) {
    logFailure(`recording $${r.usd.toFixed(4)} for ${conv}`, e);
  }
}

/** `ledger`: a friend's convId (her own day on the key) or a group's (its day on the login); none or "owner": the owner's day, which includes every group's. */
export function recordCost(usd: number, ledger?: ConvId, kind?: string): void {
  recordSpend({ usd, ...(ledger ? { conv: ledger } : {}), ...(kind ? { kind } : {}) });
}

export function spentToday(ledger?: ConvId, now: Date = new Date()): number {
  const day = localDay(now);
  return closed(() => {
    const db = instanceDb();
    if (ledger === undefined || ledger === OWNER_CONV) return cents(db.num("SELECT SUM(usd) FROM spend WHERE payer = 'login' AND day = ?", day));
    return cents(db.num("SELECT SUM(usd) FROM spend WHERE conv = ? AND payer = ? AND day = ?", ledger, payerOf(ledger), day));
  }, Number.POSITIVE_INFINITY);
}

// ---- the two aggregate ceilings ----
// Per group (a group runs on the owner's login, so a noisy one would otherwise spend the owner's whole day and stop her brief) and across all tenants (each has her own ceiling, but
// together they spend one key): written by payer.ts charge(), read by payer.ts mayRun() and by group.ts before a group's run. A group is its convId, never its raw id.
export const groupSpentToday = (groupId: string): number => spentToday(groupConvId(groupId));
export const groupOverBudget = (groupId: string): boolean => groupSpentToday(groupId) >= settings.groupDailyBudgetUsd;
export const keySpentToday = (now: Date = new Date()): number => closed(() => cents(instanceDb().num("SELECT SUM(usd) FROM spend WHERE payer = 'key' AND day = ?", localDay(now))), Number.POSITIVE_INFINITY);
export const instanceKeyOverBudget = (): boolean => keySpentToday() >= settings.instanceKeyDailyUsd;

// A tenant's day: spent so far against her own ceiling (0: no spending allowed at all).
export const tenantOverBudget = (ledger: ConvId, limitUsd: number): boolean => spentToday(ledger) >= limitUsd;

// `firstTime` is true once per day, so the caller can tell the owner exactly once.
export function overBudget(): { over: boolean; firstTime: boolean; usd: number } {
  const usd = spentToday();
  const over = usd >= settings.dailyBudgetUsd;
  return { over, firstTime: over && closed(() => takeCapNotice(OWNER_BUDGET_NOTICE), false), usd };
}
export const OWNER_BUDGET_NOTICE = "budget:owner"; // (the notices row that says the owner was told today)

// Just the question, without the once-a-day "tell the owner" side effect of overBudget (only the code that
// can tell the owner should use that one, or a group message could use up the notice).
export const budgetSpent = (): boolean => spentToday() >= settings.dailyBudgetUsd;

// A group: one short line per group per day, when someone addressed it and the budget turned the answer away (group.ts). Returns whether to say it now.
export const GROUP_BUDGET_TEXT = `I've used up my budget for today, so I can't answer until tomorrow. ${settings.owner} can raise it if it is urgent.`;
// (kept in the notices table like the other once-a-day notices, so a restart does not say it twice)
export const groupBudgetDue = (groupId: string, now: Date = new Date()): boolean => takeCapNotice(`group-budget:${groupConvId(groupId)}`, now.getTime());

// A forgotten conversation (a group, a removed friend): its rows no longer name it. They stay in the ledger, unnamed (conv ''), so the owner's and the key's day do not shrink
// when somebody is forgotten; her own day and a group's are gone because nothing names them. True when it had a row today.
export function forgetSpend(conv: ConvId, now: Date = new Date()): boolean {
  if (!isConvId(conv)) return false;
  const db = instanceDb();
  return db.tx(() => {
    const had = db.num("SELECT COUNT(*) FROM spend WHERE conv = ? AND day = ?", conv, localDay(now)) > 0;
    db.run("UPDATE spend SET conv = '' WHERE conv = ?", conv);
    return had;
  });
}

/** Retention: the rows of days before today minus `days` (the budgets look at today only; older rows are history for `npm run report`). Returns how many went. */
export function pruneSpend(days: number, now: Date = new Date()): number {
  const cutoff = localDay(new Date(now.getTime() - Math.max(1, Math.floor(days)) * 86_400_000));
  return instanceDb().run("DELETE FROM spend WHERE day < ?", cutoff).changes;
}
