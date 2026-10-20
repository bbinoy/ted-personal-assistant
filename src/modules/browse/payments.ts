import { appendLine, readText } from "../../core/state.ts";
import { localDay } from "../../core/pause.ts";

// The payment ledger: an append-only file (state/payments.jsonl, 0600) with one row per status change of a card payment. It holds NO card
// data: the merchant, the amount, the last four digits, a hash of the cart and the status. It is what makes a payment happen once (a
// second try for the same cart is refused), what the daily cap is summed from, and what is left to read after a crash.
// The audit log gets the same facts (browseguard.ts), but it rotates; the caps need a ledger that does not.

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
const SPENT: ReadonlySet<PayStatus> = new Set(["clicked", "confirmed", "unconfirmed"]);
export const DUPLICATE_HOURS = 24;

export class Ledger {
  readonly file: string;
  constructor(file = "state/payments.jsonl") {
    this.file = file;
  }

  // One entry per payment: its latest row, oldest payment first. A damaged line is skipped.
  rows(): PayRow[] {
    const last = new Map<string, PayRow>();
    for (const line of (readText(this.file) ?? "").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as PayRow;
        if (typeof r?.id === "string" && typeof r.totalMinor === "number") last.set(r.id, r);
      } catch {
        /* skip */
      }
    }
    return [...last.values()];
  }

  add(row: Omit<PayRow, "ts">, now = new Date()): void {
    appendLine(this.file, JSON.stringify({ ...row, ts: now.toISOString() }));
  }

  // A new status for a payment that is in the ledger. False when there is no such payment.
  setStatus(id: string, status: PayStatus, now = new Date()): boolean {
    const r = this.rows().find((x) => x.id === id);
    if (!r) return false;
    this.add({ ...r, status }, now);
    return true;
  }

  // A payment whose click has no result (the run ended or the process died) is unconfirmed. Called at start-up and before a run.
  recover(now = new Date()): number {
    let n = 0;
    for (const r of this.rows()) if (r.status === "clicked") (this.setStatus(r.id, "unconfirmed", now), n++);
    return n;
  }

  // The amount paid in this currency on the local day of `now`, in minor units.
  spentToday(currency: string, now = new Date()): number {
    return this.rows().filter((r) => SPENT.has(r.status) && r.currency === currency && localDay(new Date(r.ts)) === localDay(now)).reduce((a, r) => a + r.totalMinor, 0);
  }

  // The payment for the same cart at the same merchant in the last day that may have gone through, if any.
  duplicate(merchant: string, cartHash: string, now = new Date()): PayRow | undefined {
    return this.rows().find((r) => SPENT.has(r.status) && r.merchant === merchant && r.cartHash === cartHash && now.getTime() - new Date(r.ts).getTime() < DUPLICATE_HOURS * 3_600_000);
  }
}

// Pure. Why this amount may not be paid under the caps (in minor units of the card's currency), or undefined. A cap of 0 forbids payments.
export function capProblem(totalMinor: number, caps: { purchaseMinor: number; dayMinor: number }, spentTodayMinor: number): string | undefined {
  if (caps.purchaseMinor <= 0 || caps.dayMinor <= 0) return "card payments are switched off by their caps (CARD_CAP_PURCHASE, CARD_CAP_DAY)";
  if (totalMinor > caps.purchaseMinor) return `the total is above the cap for one payment (${(caps.purchaseMinor / 100).toFixed(2)})`;
  if (spentTodayMinor + totalMinor > caps.dayMinor) return `the total would take today's card payments (${(spentTodayMinor / 100).toFixed(2)} so far) above the daily cap (${(caps.dayMinor / 100).toFixed(2)})`;
  return undefined;
}
