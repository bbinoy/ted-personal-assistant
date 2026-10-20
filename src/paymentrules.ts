import { createHash } from "node:crypto";
import { AMOUNT_NUM, CURRENCY, MONEY } from "./browserules.ts";
import { registeredDomain } from "./domains.ts";

// The pure rules of a card payment in the browse run (browsecard.ts and browseguard.ts hold the state around them). Everything here is
// code that reads the page or the owner's words, never the model: what a field is, what the page's total is, which payment hosts
// are known, which embedded frames may hold a card field, and what counts as a typed yes.

// ---- the card fields ----

export type FieldKind = "number" | "expiry" | "cvc" | "holder";
export const CARD_PLACEHOLDER = /^\{\{card:(number|expiry|cvc|holder)\}\}$/i;
export const HAS_CARD_PLACEHOLDER = /\{\{\s*card:/i;

// What a field's accessible name must say. Checked in this order, so "Card security code" is a code and "Name on card" a name, not a number.
const FIELD_NAME: [FieldKind, RegExp][] = [
  ["cvc", /cvc|cvv|cid\b|security\s*code|sicherheitscode|prüfnummer|pr[üu]fziffer|code de s[ée]curit/i],
  ["expiry", /expir|exp\.?\s*date|g[üu]ltig|valid\s*(thru|until|through)|mm\s*\/\s*yy|ablauf|date d.expiration/i],
  ["holder", /card\s*holder|name on (the )?card|karteninhaber|titulaire/i],
  ["number", /card\s*(number|no\b|#)|credit\s*card|debit\s*card|cc[\s-]?num|kartennummer|kreditkarte|numéro de carte|n° de carte|tarjeta/i],
];
export const WORDS: Record<FieldKind, string> = { number: "card number", expiry: "card expiry date", cvc: "card security code", holder: "cardholder name" };

export function kindOfFieldName(name: string): FieldKind | undefined {
  return FIELD_NAME.find(([, re]) => re.test(name))?.[0];
}
// Separate month and year fields (or a select) are not supported: one text field that takes MM/YY.
export const expirySplit = (name: string): boolean => /(month|year|monat|jahr|mois|ann[ée]e)/i.test(name) && !/mm\s*\/?\s*yy/i.test(name);

// ---- money ----

export interface Money {
  minor: number; // integer minor units (CHF 45.00 is 4500)
  currency: string; // ISO code
}
const SYMBOLS: Record<string, string> = { "€": "EUR", $: "USD", "£": "GBP", "fr.": "CHF", "sfr": "CHF", "sfr.": "CHF" };
export const formatMoney = (m: Money): string => `${m.currency} ${(m.minor / 100).toFixed(2)}`;
export const sameMoney = (a: Money, b: Money): boolean => a.minor === b.minor && a.currency === b.currency;

// Pure. An amount as a page writes it ("45.00", "45,00", "1'245.50", "1.245,50", "1 245,50") in minor units, or undefined when it is not one.
export function parseAmount(raw: string): number | undefined {
  const s = raw.replace(/[’'\s]/g, "");
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return undefined;
  const at = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let whole = s;
  let frac = "";
  if (at >= 0) {
    const after = s.length - at - 1;
    const kinds = new Set(s.match(/[.,]/g));
    const count = (s.match(/[.,]/g) ?? []).length;
    const decimal = kinds.size === 2 ? true : count === 1 && after !== 3;
    if (kinds.size === 2 && after > 2) return undefined;
    if (decimal) (whole = s.slice(0, at), (frac = s.slice(at + 1)));
  }
  const digits = whole.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits) || (frac && !/^\d{1,2}$/.test(frac))) return undefined;
  const minor = Number(digits) * 100 + Number(frac.padEnd(2, "0") || "0");
  return Number.isSafeInteger(minor) && minor <= 100_000_000_00 ? minor : undefined;
}

// Pure. The first amount WITH an explicit currency in a text ("Total CHF 45.00", "45,00 €"), or undefined.
export function parseMoney(text: string): Money | undefined {
  const m = MONEY.exec(text.replace(/\s+/g, " "));
  if (!m) return undefined;
  const cur = new RegExp(CURRENCY, "i").exec(m[0])?.[0];
  const num = new RegExp(AMOUNT_NUM).exec(m[0].replace(new RegExp(CURRENCY, "i"), " "))?.[0];
  if (!cur || !num) return undefined;
  const minor = parseAmount(num);
  if (minor === undefined) return undefined;
  const currency = SYMBOLS[cur.toLowerCase()] ?? cur.toUpperCase().replace(/\.$/, "");
  return { minor, currency };
}

// A line that states what is to be paid. The subtotal, the tax and the shipping lines are not it.
const TOTAL_LINE = /\btotal\b|gesamt|zahlbetrag|endbetrag|rechnungsbetrag|zu zahlen|amount due|\bto pay\b|à payer|a payer|total a pagar|importe total/i;
const NOT_THE_TOTAL = /sub[\s-]?total|zwischensumme|sous[\s-]?total|teilsumme|total\s+(vat|tax|mwst|tva|iva|shipping|discount|savings)|(vat|tax|mwst|shipping|discount) total/i;

// Pure. The total to pay as the page view states it, in minor units with an explicit currency; or a reason there is none. STRICT: only
// "total / zu zahlen / amount due" lines count (a weak "price" line does not), and every such line must state the same amount, otherwise
// the page is ambiguous and nothing is paid. This is the page's own figure; nothing here checks it against the shop's cart.
export function findPayableTotal(view: string): { money: Money; text: string } | { problem: string } {
  const found = new Map<string, { money: Money; text: string }>();
  for (const line of view.split("\n")) {
    if (line.length > 300 || !TOTAL_LINE.test(line) || NOT_THE_TOTAL.test(line)) continue;
    const money = parseMoney(line);
    if (money) found.set(`${money.minor} ${money.currency}`, { money, text: formatMoney(money) });
  }
  if (found.size === 0) return { problem: "no total with a currency was found on the page (a line like “Total CHF 45.00”)" };
  if (found.size > 1) return { problem: `the page shows more than one total (${[...found.values()].map((f) => f.text).join(", ")})` };
  return [...found.values()][0]!;
}

// ---- the cart ----

// A page line reduced to what it says: no refs or attributes, one space, the role word of the snapshot line cut.
const plain = (line: string): string => line.replace(/\[[^\]]*\]/g, " ").replace(/^\s*-\s*/, "").replace(/^(?:text|generic|paragraph|row|cell|listitem|button|heading|link|gridcell|term|definition|strong)\b[^:"]*[:"]?\s*/i, "").replace(/["']/g, "").replace(/\s+/g, " ").trim();

// Pure. The lines of the page view that carry an amount (the items, the total, the pay button's label), normalised, in page order, no repeats.
export function cartLines(view: string): string[] {
  const out: string[] = [];
  for (const line of view.split("\n")) {
    if (line.length > 300) continue;
    const t = plain(line);
    if (t && MONEY.test(t) && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 40);
}

export const cartHash = (merchant: string, total: Money, lines: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify([merchant.toLowerCase(), total.minor, total.currency, lines.map((l) => l.toLowerCase())])).digest("hex");
// The id the owner sees and the idempotency key of one approval: the first 8 hex characters of a hash of everything it covers.
export const approvalId = (parts: readonly unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 8);

// ---- where the card may be typed ----

// Payment providers whose hosted checkout pages and card frames are known. A registered domain (domains.ts). The card is typed on one of
// these only when the run came to it from a shop (not opened by address), and it is always named in the owner's question.
export const PSP_HOSTS: ReadonlySet<string> = new Set(["stripe.com", "adyen.com", "datatrans.com", "payrexx.com", "saferpay.com", "checkout.com", "mollie.com"]);
export const isPsp = (host: string): boolean => PSP_HOSTS.has(registeredDomain(host));
// Frames that only measure or tag a page (Google's own). They are not payment frames; anything else that is not the shop or a payment host stops the payment.
const QUIET_FRAMES: ReadonlySet<string> = new Set(["googletagmanager.com", "google-analytics.com", "doubleclick.net"]);

export interface FrameInfo {
  url: string;
}
const bare = (u: string): string => u.split("#")[0]!;

// Pure. May a card be typed into a field of an embedded frame of this page? `frames` is the browser's own frame tree, main page first, every
// frame including the hidden ones. Yes only when each frame is blank, the shop's own site, a known payment host or a quiet Google frame, and
// at least one is a payment host; then the payment hosts are returned. Anything else (a frame of another site) is the reason it is refused.
export function frameVerdict(frames: readonly FrameInfo[], pageUrl: string, merchant: string): { psp: string[] } | string {
  const main = frames[0];
  if (!main || bare(main.url) !== bare(pageUrl)) return "the browser's frame list is not of this page";
  const psp = new Set<string>();
  for (const f of frames.slice(1)) {
    if (!f.url || /^about:(blank|srcdoc)/.test(f.url)) continue;
    let u: URL;
    try {
      u = new URL(f.url);
    } catch {
      return "an embedded frame has an address that cannot be read";
    }
    if (u.protocol !== "https:") return `an embedded frame is not https (${u.protocol.replace(":", "")})`;
    const reg = registeredDomain(u.hostname);
    if (PSP_HOSTS.has(reg)) psp.add(reg);
    else if (reg !== merchant && !QUIET_FRAMES.has(reg)) return `the page embeds a frame from ${reg}, which is neither the shop nor a known payment provider`;
  }
  return psp.size ? { psp: [...psp].sort() } : "the page has no frame from a known payment provider";
}

// ---- boxes and labels ----

// A ticked box that saves the card, signs up for something or renews: not for a one-off payment.
export const RISKY_BOX = /save|remember|store (my |the )?card|subscribe|recurring|auto.?renew|future|newsletter|speichern|merken|abo\b|abonn|enregistrer|se souvenir|guardar/i;
export const riskyBoxes = (nodes: Iterable<{ role: string; name: string; checked?: boolean }>): string[] => [...nodes].filter((n) => /^(checkbox|switch)$/.test(n.role) && n.checked && RISKY_BOX.test(n.name)).map((n) => n.name);

// ---- what the page says after the click ----

const DECLINED = /payment (failed|declined|was declined|unsuccessful|could not be)|card (was |has been )?declined|transaction (failed|declined)|zahlung (fehlgeschlagen|abgelehnt)|paiement (refus|[ée]chou)|pago rechazado/i;
const CONFIRMED = /thank you for your (order|purchase|payment|booking)|order (confirmed|complete|placed|received)|payment (successful|received|confirmed|complete)|your (order|booking) (has been|was) (placed|confirmed)|booking confirmed|bestellung (best[äa]tigt|abgeschlossen|erfolgreich)|zahlung (erfolgreich|best[äa]tigt)|vielen dank f[üu]r (ihre|deine) (bestellung|zahlung|buchung)|commande confirm[ée]e|paiement r[ée]ussi/i;
export function paymentOutcome(view: string): "confirmed" | "failed" | undefined {
  if (DECLINED.test(view)) return "failed";
  return CONFIRMED.test(view) ? "confirmed" : undefined;
}

// ---- the typed yes ----

// Pure. Is this reply, as typed, an unambiguous yes to a payment? The word yes (or ja, oui) alone or with one plain word of consent. Not an
// emoji, not "ok" or "sure", not a sentence, not a question, not a transcript of a voice message (the caller checks that).
export const TYPED_YES_NEEDED = "A payment needs a typed YES: reply YES to pay, or NO to cancel. A reaction does not count.";
const TYPED_YES = /^(yes|ja|oui)( (please|pay|pay it|pay now|go ahead|do it|approved?|i approve|confirm|confirmed|bitte|zahlen|bezahlen|gerne|merci|payer))?$/;
export function isTypedYes(text: string): boolean {
  if (/[?？]/.test(text)) return false;
  return TYPED_YES.test(text.toLowerCase().replace(/['’]/g, "").replace(/[.,!;:]+/g, " ").replace(/\s+/g, " ").trim());
}
