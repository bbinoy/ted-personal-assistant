import { copyFileSync, existsSync, statSync } from "node:fs";
import { appendLine, dataPath, readText, writeFileAtomic } from "../../core/state.ts";
import { instancePaths } from "../../core/convpaths.ts";
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

// The ledger is a financial record: it is NEVER deleted. Past MAX_BYTES the file is copied whole to payments-<year>.jsonl (the year of its first row; -2, -3 if that name is
// taken) and the current file is replaced, atomically, by only the rows the caps and the duplicate check can still need: every payment whose latest row is from the last
// two days (the local day of the cap and the 24 hours of the duplicate window, with a day to spare for the time zone) and every payment still open (approved or clicked: its
// status will change, and setStatus must find it). The caps and the duplicate check read the current file only, so across a rotation they see exactly what they saw before.
// The copy comes first: a crash between the two steps leaves a complete current file and an archive, never a gap.
export const MAX_BYTES = 1024 * 1024;
const KEEP_MS = 2 * 24 * 3_600_000;
const OPEN: ReadonlySet<PayStatus> = new Set(["approved", "clicked"]);

export class Ledger {
  readonly file: string;
  constructor(file = instancePaths().payments) {
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
    this.rotate(now);
  }

  // The archive a rotation made, or undefined when the file is small. Never throws: a ledger that cannot be rotated is still a ledger.
  rotate(now = new Date()): string | undefined {
    try {
      const path = dataPath(this.file);
      if (statSync(path).size <= MAX_BYTES) return undefined;
      const text = readText(this.file) ?? "";
      const rows = this.rows();
      const year = /"ts":"(\d{4})/.exec(text)?.[1] ?? String(now.getFullYear());
      const base = path.replace(/\.jsonl$/, "");
      let archive = `${base}-${year}.jsonl`;
      for (let n = 2; existsSync(archive); n++) archive = `${base}-${year}-${n}.jsonl`;
      copyFileSync(path, archive);
      const keep = rows.filter((r) => OPEN.has(r.status) || now.getTime() - new Date(r.ts).getTime() < KEEP_MS);
      writeFileAtomic(path, keep.map((r) => JSON.stringify(r) + "\n").join(""));
      return archive;
    } catch {
      return undefined;
    }
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
