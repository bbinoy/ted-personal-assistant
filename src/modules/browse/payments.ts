import { instanceDb } from "../../core/instancedb.ts";
import type { Db } from "../../core/db.ts";
import { localDay } from "../../core/pause.ts";

// The payment ledger: the `payments` table of instance.db with one row per status change of a card payment, append-only. It holds NO card
// data: the merchant, the amount, the last four digits, a hash of the cart and the status. It is what makes a payment happen once (a
// second try for the same cart is refused), what the daily cap is summed from, and what is left to read after a crash.
// The audit log gets the same facts (browseguard.ts), but it rotates; the caps need a ledger that does not.
// It is a financial record and is NEVER deleted by the assistant: every row ever written is here (layout 2's payments.jsonl and its yearly archives were imported whole). The only way rows leave
// is prunePayments, an explicit policy for payments older than two years that is OFF unless PAYMENTS_KEEP_YEARS is set (core/settings.ts). Each row is committed durably (synchronous=FULL):
// a payment that was clicked is on disk before the page is told to go on.

export type PayStatus = "approved" | "clicked" | "confirmed" | "failed" | "unconfirmed" | "cleared";
export interface PayRow {
  id: string; // the approval id (8 hex characters)
  ts: string;
  merchant: string;
  totalMinor: number;
  currency: string;
  last4: string;
  cartHash: string;
  status: PayStatus;
}
// A payment that was clicked may have taken money, whatever the page said afterwards.
export const DUPLICATE_HOURS = 24;
const KEEP_MS = 2 * 24 * 3_600_000; // (rows() looks back this far: the local day of the cap and the 24 hours of the duplicate window, with a day to spare for the time zone)
const SPENT_SQL = "('clicked','confirmed','unconfirmed')";

interface DbPayRow {
  id: string; ts: string; merchant: string; total_minor: number; currency: string; last4: string; cart_hash: string; status: PayStatus;
}
const toRow = (r: DbPayRow): PayRow => ({ id: r.id, ts: r.ts, merchant: r.merchant, totalMinor: r.total_minor, currency: r.currency, last4: r.last4, cartHash: r.cart_hash, status: r.status });
const LATEST = "SELECT id, ts, merchant, total_minor, currency, last4, cart_hash, status FROM payments_latest";

export class Ledger {
  readonly db: () => Db;
  /** `db`: the database whose payments table this is (default: instance.db of the data folder; a test gives its own). */
  constructor(db?: Db) {
    this.db = db ? () => db : instanceDb;
  }

  // One entry per payment: its latest row, oldest payment first. What the file used to hold after its rotations, and what the callers (the duplicate listing, `npm run card -- payments`, the doctor's
  // count of unconfirmed ones) were written against: payments whose latest row is from the last two days, and every payment still open or unconfirmed. `allRows()` is the whole ledger.
  rows(now = new Date()): PayRow[] {
    const since = new Date(now.getTime() - KEEP_MS).toISOString();
    return this.db().all<DbPayRow>(`${LATEST} WHERE status IN ('approved','clicked','unconfirmed') OR ts >= ? ORDER BY first_ts, first_seq`, since).map(toRow);
  }
  allRows(): PayRow[] {
    return this.db().all<DbPayRow>(`${LATEST} ORDER BY first_ts, first_seq`).map(toRow);
  }

  add(row: Omit<PayRow, "ts">, now = new Date()): void {
    const db = this.db();
    db.tx(() => db.run(
      "INSERT INTO payments (id, ts, merchant, total_minor, currency, last4, cart_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      row.id, now.toISOString(), row.merchant, row.totalMinor, row.currency, row.last4, row.cartHash, row.status,
    ), { durable: true });
  }

  // A new status for a payment that is in the ledger. False when there is no such payment.
  setStatus(id: string, status: PayStatus, now = new Date()): boolean {
    const db = this.db();
    return db.tx(() => {
      const r = db.get<DbPayRow>(`${LATEST} WHERE id = ?`, id);
      if (!r) return false;
      this.add({ ...toRow(r), status }, now);
      return true;
    }, { durable: true });
  }

  // A payment whose click has no result (the run ended or the process died) is unconfirmed. Called at start-up and before a run.
  recover(now = new Date()): number {
    const db = this.db();
    return db.tx(() => {
      let n = 0;
      for (const r of db.all<DbPayRow>(`${LATEST} WHERE status = 'clicked'`)) (this.setStatus(r.id, "unconfirmed", now), n++);
      return n;
    }, { durable: true });
  }

  // The amount paid in this currency on the local day of `now`, in minor units. (Rows of the last three days are looked at, then the local day decides: a time zone moves the day by hours.)
  spentToday(currency: string, now = new Date()): number {
    const since = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    return this.db()
      .all<DbPayRow>(`${LATEST} WHERE status IN ${SPENT_SQL} AND currency = ? AND ts >= ?`, currency, since)
      .filter((r) => localDay(new Date(r.ts)) === localDay(now))
      .reduce((a, r) => a + r.total_minor, 0);
  }

  // The payment for the same cart at the same merchant in the last day that may have gone through, if any.
  duplicate(merchant: string, cartHash: string, now = new Date()): PayRow | undefined {
    const since = new Date(now.getTime() - DUPLICATE_HOURS * 3_600_000).toISOString();
    const r = this.db().get<DbPayRow>(`${LATEST} WHERE status IN ${SPENT_SQL} AND merchant = ? AND cart_hash = ? AND ts > ? ORDER BY first_ts, first_seq LIMIT 1`, merchant, cartHash, since);
    return r ? toRow(r) : undefined;
  }

  /** Every row of every status change, oldest first (the audit trail behind `rows()`'s latest-only view). */
  history(id?: string): PayRow[] {
    return (id === undefined ? this.db().all<DbPayRow>("SELECT * FROM payments ORDER BY ts, seq") : this.db().all<DbPayRow>("SELECT * FROM payments WHERE id = ? ORDER BY ts, seq", id)).map(toRow);
  }
}

// The one policy that ever deletes payment rows, and only when the owner asks for it with PAYMENTS_KEEP_YEARS (default: keep everything): whole payments whose LATEST status is settled
// (confirmed, failed or cleared) and whose every row is older than `years` (never fewer than two). Open or unconfirmed payments are never touched. Returns how many rows went.
export function prunePayments(years: number, now = new Date()): number {
  if (!Number.isFinite(years) || years <= 0) return 0;
  const cutoff = new Date(now.getTime() - Math.max(2, years) * 365 * 86_400_000).toISOString();
  return instanceDb().tx(
    () =>
      instanceDb().run(
        `DELETE FROM payments WHERE id IN (SELECT id FROM payments_latest WHERE status IN ('confirmed','failed','cleared') AND ts < ?)
         AND id NOT IN (SELECT id FROM payments WHERE ts >= ?)`,
        cutoff, cutoff,
      ).changes,
    { durable: true },
  );
}

// Pure. Why this amount may not be paid under the caps (in minor units of the card's currency), or undefined. A cap of 0 forbids payments.
export function capProblem(totalMinor: number, caps: { purchaseMinor: number; dayMinor: number }, spentTodayMinor: number): string | undefined {
  if (caps.purchaseMinor <= 0 || caps.dayMinor <= 0) return "card payments are switched off by their caps (CARD_CAP_PURCHASE, CARD_CAP_DAY)";
  if (totalMinor > caps.purchaseMinor) return `the total is above the cap for one payment (${(caps.purchaseMinor / 100).toFixed(2)})`;
  if (spentTodayMinor + totalMinor > caps.dayMinor) return `the total would take today's card payments (${(spentTodayMinor / 100).toFixed(2)} so far) above the daily cap (${(caps.dayMinor / 100).toFixed(2)})`;
  return undefined;
}
