import { prunePayments } from "../modules/browse/payments.ts";
import { pruneLooks } from "../core/looks.ts";
import { pruneNotices } from "../core/capnotice.ts";
import { pruneSpend } from "../core/budget.ts";
import { instanceDb } from "../core/instancedb.ts";
import { dayIn } from "../core/timezone.ts";
import { registerRetention, type RetentionResult } from "../core/retention.ts";
import { settings } from "../core/settings.ts";

// The retention rules for the tables of instance.db (core/retention.ts says how they run; retentionrules.ts has the file-based ones, registerFileRules calls this too).
//   looks     heartbeat rows older than LOOKS_KEEP_DAYS (the report reads at most a year)
//   spend     spend rows of days older than SPEND_KEEP_DAYS (the budgets look at today only)
//   told      per-day and interval marks older than two days (they mean nothing any more); a `once` mark stays (core/told.ts)
//   payments  NEVER, unless PAYMENTS_KEEP_YEARS is set (>= 2): settled payments older than that. The default keeps every row for ever.
// A dry run counts and removes nothing. Rows have no byte size here: freedBytes is 0 (the file does not shrink until a VACUUM; SQLite reuses the pages).

const none = (notes: string): RetentionResult => ({ removed: 0, freedBytes: 0, notes });

const LOOKS_KEEP_DAYS = 400; // heartbeat look rows older than this are pruned
const SPEND_KEEP_DAYS = 400; // spend ledger rows of days older than this are pruned (the budgets look at today only)
export function registerDbRules(): void {
  registerRetention({
    name: "db-looks",
    everyHours: 24,
    run(now, o) {
      const days = LOOKS_KEEP_DAYS;
      if (o.dryRun) return { removed: instanceDb().num("SELECT COUNT(*) FROM looks WHERE at_ms < ?", now.getTime() - days * 86_400_000), freedBytes: 0, notes: `heartbeat looks older than ${days} days` };
      return { removed: pruneLooks(days, now.getTime()), freedBytes: 0, notes: `heartbeat looks older than ${days} days` };
    },
  });
  registerRetention({
    name: "db-spend",
    everyHours: 24,
    run(now, o) {
      const days = SPEND_KEEP_DAYS;
      const cutoff = dayIn(new Date(now.getTime() - days * 86_400_000));
      if (o.dryRun) return { removed: instanceDb().num("SELECT COUNT(*) FROM spend WHERE day < ?", cutoff), freedBytes: 0, notes: `spend rows older than ${days} days` };
      return { removed: pruneSpend(days, now), freedBytes: 0, notes: `spend rows older than ${days} days` };
    },
  });
  registerRetention({
    name: "db-told",
    everyHours: 24,
    run(now, o) {
      if (o.dryRun) return { removed: instanceDb().num("SELECT COUNT(*) FROM told WHERE once = 0 AND at < ?", now.getTime() - 2 * 86_400_000), freedBytes: 0, notes: "notice marks of past days" };
      return { removed: pruneNotices(now.getTime()), freedBytes: 0, notes: "notice marks of past days" };
    },
  });
  registerRetention({
    name: "db-payments",
    everyHours: 24 * 7,
    run(now, o) {
      const years = settings.paymentsKeepYears;
      if (years <= 0) return none("kept for ever (PAYMENTS_KEEP_YEARS=0): a financial record");
      const cutoff = new Date(now.getTime() - Math.max(2, years) * 365 * 86_400_000).toISOString();
      if (o.dryRun) return { removed: instanceDb().num("SELECT COUNT(*) FROM payments WHERE id IN (SELECT id FROM payments_latest WHERE status IN ('confirmed','failed','cleared') AND ts < ?) AND id NOT IN (SELECT id FROM payments WHERE ts >= ?)", cutoff, cutoff), freedBytes: 0, notes: `settled payments older than ${Math.max(2, years)} years` };
      return { removed: prunePayments(years, now), freedBytes: 0, notes: `settled payments older than ${Math.max(2, years)} years` };
    },
  });
}
