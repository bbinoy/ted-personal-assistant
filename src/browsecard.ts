import { expiryText, maskCard, type CardInfo, type CardRecord } from "./card.ts";
import { formatMoney, type FieldKind, type Money } from "./paymentrules.ts";
import { clip, cleanText, LIMITS } from "./sanitize.ts";

// The state of a card payment inside one browse run (browseguard.ts decides every call; the rules are paymentrules.ts). One per guard.
// The card's plaintext exists in `card` only between the owner's typed yes and the pay click (or the end of the run).

// What one approval covers: this shop, these payment hosts, this page, this total and cart. Nothing else, and only once.
export interface PayApproval {
  id: string; // 8 hex characters, the idempotency key
  merchant: string; // registered domain of the shop
  psp: string[]; // registered domains the card is typed on
  url: string; // the page address (no fragment) the approval was given on
  money: Money;
  cartHash: string;
  frames: boolean; // the card goes into embedded frames, which are checked again at the click
  last4: string;
  expiresAt: number;
}
export const APPROVAL_MINUTES = 10;

export class PayRun {
  approval?: PayApproval;
  typed = new Set<FieldKind>(); // which card details were typed since the approval
  attempted = false; // the pay button was clicked: nothing is typed or clicked again in this run
  settled?: "confirmed" | "failed"; // what the page said after the click
  asks = 0; // payment questions put to the owner in this run (a declined one may be asked again once)
  approved = 0; // payments approved in this run
  card?: CardRecord; // plaintext; dropped at the click
  lastFillSeq = 0; // the page-view count when the last card detail went in; the pay click needs a newer full view

  // Active: the card is (partly) typed for an approved payment that has not been clicked yet.
  get active(): boolean {
    return !!this.approval && this.typed.size > 0 && !this.attempted;
  }
  // Nothing of this payment is trusted any more (page, shop, total or cart changed, or the approval ran out): a new approval would be needed.
  invalidate(): void {
    this.approval = undefined;
    this.typed.clear();
    this.card = undefined;
  }
}

// The text the owner and the question writer read before a payment. All of it from code; the cart lines are page text and are cleaned and cut.
// No card number, expiry or security code is in it, only the label, the last four digits and the currency.
export function payDetails(a: { merchant: string; psp: string[]; money: Money; card: CardInfo; id: string; cart: readonly string[]; task: string; prior: string[] }): string {
  const cart = a.cart.slice(0, 6).map((l) => `• ${clip(cleanText(l, { line: true }).text, LIMITS.gist)}`);
  return [
    "💳 Card payment approval: only a typed YES pays",
    `Merchant: ${a.merchant}`,
    `Card typed on: ${a.psp.join(", ")}`,
    `Total (read from the page by code, not checked by the shop): ${formatMoney(a.money)}`,
    `Card: ${maskCard(a.card)} (${a.card.currency})`,
    `Approval id: ${a.id}`,
    "Cart (from the page):",
    ...(cart.length ? cart : ["• (no lines with an amount)"]),
    ...(a.prior.length ? [`Earlier payments for this cart: ${a.prior.join(", ")}`] : []),
    `Task: ${clip(cleanText(a.task, { line: true }).text, LIMITS.preview)}`,
    "Approving lets the assistant type the card into that page and click pay once; the payment is then confirmed in the card's own app, where the amount is shown.",
  ].join("\n");
}

// Everything the page could echo of the card besides the field itself: the number plain, grouped by 4 (and 4-6-5 for 15 digits) with spaces or
// dashes, the expiry in the usual forms, the holder's name. The security code is NOT here (three digits cut everywhere would wreck a page): it is
// cut from the line of the field it went into. Pure.
export function secretVariants(c: CardRecord): string[] {
  const groups = c.pan.length === 15 ? [c.pan.slice(0, 4), c.pan.slice(4, 10), c.pan.slice(10)] : (c.pan.match(/.{1,4}/g) ?? [c.pan]);
  const mm = String(c.expMonth).padStart(2, "0");
  const yy = String(c.expYear % 100).padStart(2, "0");
  return [c.pan, groups.join(" "), groups.join("-"), `${mm}/${yy}`, `${mm} / ${yy}`, `${mm}/${c.expYear}`, `${mm} / ${c.expYear}`, `${mm}%2F${yy}`, `${mm}%2F${c.expYear}`, expiryText(c), ...(c.holder ? [c.holder] : [])];
}
