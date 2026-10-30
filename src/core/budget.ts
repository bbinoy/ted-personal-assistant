import { takeCapNotice } from "./capnotice.ts";
import { holdFact } from "./ownerfact.ts";
import { told } from "./told.ts";
import { dayIn } from "./timezone.ts";
import { settings } from "./settings.ts";
import { isConvId, OWNER_CONV, type ConvId } from "./convpaths.ts";
import { instanceDb } from "./instancedb.ts";

// A runaway guard, not an accounting system. Costs are the SDK's own estimates (notional on a
// subscription). No ceiling pauses anything: crossing a level only warns the owner (warnSpend below).
// Synchronous on purpose (see state.ts): concurrent recordCost calls can never lose an update (one INSERT each, in instance.db).
//
// ONE ledger, the `spend` table of instance.db (core/instancedb.ts): a row per charged run, with the payer, the conversation, the kind of run and the local day. Every ceiling is an
// indexed sum of it, so the two cannot drift apart:
//   the login today    payer 'login', every conversation (the owner's chat, her background work and the groups, which run on her login)   -> DAILY_BUDGET_USD (first warning level)
//   the key today      payer 'key', every friend                                                                                       -> INSTANCE_KEY_DAILY_USD (first warning level)
// There are no ceilings; spentToday(convId) still says what it spent (the reports, `npm run doctor`).

// FAIL CLOSED: when the ledger cannot be read (the degraded mode of a damaged instance.db, a database that stays busy or a full disk) every day's sum is "infinite", so nothing is warned about and nothing throws into a run. A charge that cannot be written is logged (once per kind of failure per minute), not raised: the run it paid for is done.
let lastLogged = 0;
const logFailure = (what: string, e: unknown): void => {
  if (Date.now() - lastLogged < 60_000) return;
  lastLogged = Date.now();
  console.error(`budget: ${what} failed (${(e as Error).message}); warnings and payments stay off until the ledger works`);
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

type Payer = "login" | "key";
export interface SpendRow {
  usd: number;
  conv: ConvId; // whose day it counts toward
  payer?: Payer; // default: a friend's conversation is paid by the key, anything else by the login
  kind?: string; // chat, look, dream, gate, helper, mail ... (default "run")
  now?: Date;
}
const payerOf = (conv: ConvId): Payer => (conv.startsWith("friend-") ? "key" : "login");

export function recordSpend(r: SpendRow): void {
  if (!(r.usd > 0)) return;
  const { conv } = r;
  const now = r.now ?? new Date();
  try {
    instanceDb().run("INSERT INTO spend (at, day, conv, payer, kind, usd) VALUES (?, ?, ?, ?, ?, ?)", now.getTime(), dayIn(now), conv, r.payer ?? payerOf(conv), r.kind ?? "run", r.usd);
  } catch (e) {
    logFailure(`recording $${r.usd.toFixed(4)} for ${conv}`, e);
    return;
  }
  closed(() => warnSpend(now), undefined);
}

/** `ledger`: a friend's convId (her own day on the key) or a group's (its day on the login); the default is the login's own day (the owner's, which includes every group's). */
export function recordCost(usd: number, ledger: ConvId = OWNER_CONV, kind?: string): void {
  recordSpend({ usd, conv: ledger, ...(kind ? { kind } : {}) });
}

export function spentToday(ledger?: ConvId, now: Date = new Date()): number {
  const day = dayIn(now);
  return closed(() => {
    const db = instanceDb();
    if (ledger === undefined || ledger === OWNER_CONV) return cents(db.num("SELECT SUM(usd) FROM spend WHERE payer = 'login' AND day = ?", day));
    return cents(db.num("SELECT SUM(usd) FROM spend WHERE conv = ? AND payer = ? AND day = ?", ledger, payerOf(ledger), day));
  }, Number.POSITIVE_INFINITY);
}

// ---- warnings, not ceilings ----
// Nothing is ever paused for money. The owner pays both payers, so she hears of a big day as a FACT for her next run (ownerfact.ts), which says it in its own words, once per threshold per day
// (told.ts, through takeCapNotice): the login's day past DAILY_BUDGET_USD and every WARN_STEP_USD more, the instance key's day (all friends together) past INSTANCE_KEY_DAILY_USD and every
// step more, and one friend's own day past that same first level and every step more. The fact names a friend by id and gives the amount only, never anything she said. Checked on every charge
// (recordSpend), so the ledger is the only trigger. The first check after a deploy records what is already crossed without telling (WARN_SEEDED), so an old, inflated day does not fire at once.
const WARN_STEP_USD = 5;
const WARN_SEEDED = "budget:warn-seeded";
export const keySpentToday = (now: Date = new Date()): number => closed(() => cents(instanceDb().num("SELECT SUM(usd) FROM spend WHERE payer = 'key' AND day = ?", dayIn(now))), Number.POSITIVE_INFINITY);
/** The next warning level above `usd`, for a subject whose first level is `first` (`npm run doctor`). */
export const nextWarning = (usd: number, first: number): number => first + (usd < first ? 0 : (Math.floor((usd - first) / WARN_STEP_USD) + 1) * WARN_STEP_USD);
const crossed = (usd: number, first: number): number | undefined => (Number.isFinite(usd) && usd >= first ? first + Math.floor((usd - first) / WARN_STEP_USD) * WARN_STEP_USD : undefined); // the highest level passed

function warn(subject: string, usd: number, first: number, what: (level: number) => string, seed: boolean, now: Date): void {
  const level = crossed(usd, first);
  if (level === undefined || !takeCapNotice(`budget:warn:${level}:${subject}`, now.getTime())) return;
  if (!seed) holdFact(`She asked to be told when spend passes each warning level, so say it in one friendly line. ${what(level)} Nothing is paused; the next warning comes at $${level + WARN_STEP_USD}.`, now);
}
function warnSpend(now: Date): void {
  const day = dayIn(now);
  const seed = closed(() => told(instanceDb(), WARN_SEEDED, { once: true }, now.getTime()), false); // true once, ever: the first check after a deploy
  warn("login", spentToday(OWNER_CONV, now), settings.dailyBudgetUsd, (l) => `Today's spend on your login has passed $${l} (notional).`, seed, now);
  warn("key", keySpentToday(now), settings.instanceKeyDailyUsd, (l) => `The friends' shared key has spent over $${l} today, all friends together.`, seed, now);
  for (const r of instanceDb().all<{ conv: string; usd: number }>("SELECT conv, SUM(usd) AS usd FROM spend WHERE payer = 'key' AND day = ? AND conv LIKE 'friend-%' GROUP BY conv", day)) {
    warn(r.conv, cents(r.usd), settings.instanceKeyDailyUsd, (l) => `One friend (${r.conv}) has spent over $${l} today on the shared key.`, seed, now);
  }
}

// A forgotten conversation (a group, a removed friend): its rows no longer name it. They stay in the ledger, unnamed (conv ''), so the owner's and the key's day do not shrink
// when somebody is forgotten; her own day and a group's are gone because nothing names them. True when it had a row today.
export function forgetSpend(conv: ConvId, now: Date = new Date()): boolean {
  if (!isConvId(conv)) return false;
  const db = instanceDb();
  return db.tx(() => {
    const had = db.num("SELECT COUNT(*) FROM spend WHERE conv = ? AND day = ?", conv, dayIn(now)) > 0;
    db.run("UPDATE spend SET conv = '' WHERE conv = ?", conv);
    return had;
  });
}

/** Retention: the rows of days before today minus `days` (the budgets look at today only; older rows are history for `npm run report`). Returns how many went. */
export function pruneSpend(days: number, now: Date = new Date()): number {
  const cutoff = dayIn(new Date(now.getTime() - Math.max(1, Math.floor(days)) * 86_400_000));
  return instanceDb().run("DELETE FROM spend WHERE day < ?", cutoff).changes;
}
