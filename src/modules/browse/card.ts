import { existsSync, rmSync } from "node:fs";
import { luhnValid } from "./browserules.ts";
import { Ledger } from "./payments.ts";
import { inTenant, ProfileError } from "./profile.ts";
import { CARD_TENANTS, SecretsError, type TenantSecrets } from "../../secrets/secrets.ts";
import { dataPath, readText, writeText } from "../../state.ts";
import { LIMITS } from "../../sanitize.ts";
import { settings } from "../../settings.ts";

// The owner's dedicated debit card for the browse worker: the card number, expiry and security code as one item in OpenBao
// (tenants/owner/card/primary, secrets.ts), apart from the profile items. They are entered ONLY
// at a local terminal (cardcli.ts, hidden prompts), never through the chat, which is logged and goes to the model, and never shown
// beyond the last four digits. Code reads the card only inside a payment the owner approved (browseguard.ts); the model names a
// placeholder and never sees a digit. A kill switch (a plain file, so it works even when the store cannot be opened) turns card use off.

export interface CardRecord {
  pan: string; // digits only
  expMonth: number; // 1 to 12
  expYear: number; // four digits
  cvc: string; // 3 or 4 digits
  holder?: string;
  label: string; // what the owner calls it ("Wise")
  last4: string;
  currency: string; // ISO code of the card's currency; a payment in another currency is refused
}
// What the run may know about the card: nothing that can pay.
export interface CardInfo {
  last4: string;
  label: string;
  currency: string;
}
export const maskCard = (c: CardInfo): string => `${c.label} ••••${c.last4}`;

// Pure. The problem with a card the owner typed, or undefined. `now` for the expiry check.
export function cardProblem(c: Pick<CardRecord, "pan" | "expMonth" | "expYear" | "cvc" | "currency">, now = new Date()): string | undefined {
  if (!luhnValid(c.pan)) return "that is not a valid card number (13 to 19 digits that pass the check)";
  if (!Number.isInteger(c.expMonth) || c.expMonth < 1 || c.expMonth > 12 || !Number.isInteger(c.expYear) || c.expYear < 2000 || c.expYear > 2100) return "the expiry date is not a month and year like 12/29";
  if (c.expYear < now.getFullYear() || (c.expYear === now.getFullYear() && c.expMonth < now.getMonth() + 1)) return "that card has expired";
  if (!/^\d{3,4}$/.test(c.cvc)) return "the security code is 3 or 4 digits";
  if (!/^[A-Z]{3}$/.test(c.currency)) return "the currency is a three-letter code like CHF";
  return undefined;
}

// Pure. "12/29", "12 / 2029", "1229" as a month and a four-digit year.
export function parseExpiry(text: string): { expMonth: number; expYear: number } | undefined {
  const m = /^\s*(\d{1,2})\s*[/.-]?\s*(\d{2}|\d{4})\s*$/.exec(text);
  if (!m) return undefined;
  const expYear = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return { expMonth: Number(m[1]), expYear };
}
export const expiryText = (c: Pick<CardRecord, "expMonth" | "expYear">, long = false): string => `${String(c.expMonth).padStart(2, "0")}/${long ? c.expYear : String(c.expYear % 100).padStart(2, "0")}`;

// What comes out of OpenBao, checked: anything that is not a whole, valid card record is no card.
export function cardOf(raw: unknown): CardRecord | undefined {
  const o = raw as Partial<CardRecord> | null | undefined;
  if (!o || typeof o !== "object" || typeof o.pan !== "string" || typeof o.cvc !== "string" || typeof o.currency !== "string") return undefined;
  const c: CardRecord = { pan: o.pan, expMonth: Number(o.expMonth), expYear: Number(o.expYear), cvc: o.cvc, label: typeof o.label === "string" && o.label ? o.label.slice(0, LIMITS.name) : "Card", last4: o.pan.slice(-4), currency: o.currency, ...(typeof o.holder === "string" && o.holder ? { holder: o.holder.slice(0, LIMITS.name) } : {}) };
  return luhnValid(c.pan) && c.expMonth >= 1 && c.expMonth <= 12 && /^\d{3,4}$/.test(c.cvc) && /^[A-Z]{3}$/.test(c.currency) ? c : undefined;
}

// The card item: tenants/owner/card/primary in OpenBao. Only the owner has one: a CardStore for any other tenant is refused at once (and
// secrets.ts refuses it again, whatever calls it). The card is never served from the client's cache.
export const CARD_ITEM = "primary";
export class CardStore {
  secrets?: TenantSecrets;
  constructor(secrets?: TenantSecrets) {
    if (secrets && !CARD_TENANTS.has(secrets.tenant)) throw new SecretsError("a card is never stored for this tenant (only the owner's own card; a friend's security code is never kept)");
    this.secrets = secrets;
  }
  // The card, as OpenBao holds it. Only the payment step calls this.
  async load(): Promise<CardRecord | undefined> {
    return inTenant(this, async (s) => cardOf(await s.get("card", CARD_ITEM, { cache: false })));
  }
  // What a run may know: the card is opened and dropped inside, only last four, label and currency leave.
  async peek(): Promise<CardInfo | undefined> {
    const c = await this.load();
    return c && { last4: c.last4, label: c.label, currency: c.currency };
  }
  async save(c: CardRecord): Promise<void> {
    await inTenant(this, (s) => s.put("card", CARD_ITEM, { ...c }));
  }
  async remove(): Promise<boolean> {
    return inTenant(this, (s) => s.remove("card", CARD_ITEM));
  }
}

// ---- the kill switch ----

// A plain file, checked at the payment approval and again at the pay click. Its existence disables card use, even when the store cannot
// be opened. The owner's chat can switch it ON (/card off); switching card use back on is the terminal's (npm run card -- enable) so that
// a spoofed or injected message can never re-enable it.
export class KillSwitch {
  private readonly file: string;
  constructor(file = "state/card.disabled") {
    this.file = file;
  }
  // Why card use is off, or undefined when it is on.
  off(): string | undefined {
    return existsSync(dataPath(this.file)) ? `switched off ${(readText(this.file) ?? "").trim() || "by the owner"}` : undefined;
  }
  turnOff(how: string, now = new Date()): void {
    writeText(this.file, `${how} at ${now.toISOString()}\n`);
  }
  turnOn(): boolean {
    const was = existsSync(dataPath(this.file));
    rmSync(dataPath(this.file), { force: true });
    return was;
  }
}
export const killSwitch = new KillSwitch();

// The owner's chat command, handled in code before any model sees the message. Undefined: not a card command.
export function cardCommand(text: string, kill: KillSwitch = killSwitch): string | undefined {
  const m = /^\/card(?:\s+(\S+))?\s*$/i.exec(text.trim());
  if (!m) return undefined;
  const word = (m[1] ?? "status").toLowerCase();
  if (word === "off" || word === "stop" || word === "disable") {
    kill.turnOff("from the chat");
    return "Card payments are off. Nothing can be paid with the card until you switch them on again at the terminal on the Mac: npm run card -- enable";
  }
  if (word === "on" || word === "enable") return "Switching card payments on is only possible at the terminal on the Mac (npm run card -- enable), never from the chat.";
  if (word === "status") return kill.off() ? `Card payments are off (${kill.off()}). To switch them on: npm run card -- enable` : "Card payments are on (each one still needs your typed YES). /card off switches them off.";
  return "Card commands: /card off, /card status.";
}

// ---- what a browse run gets ----

// The run's handle on the card: what it may know, a way to open the card (inside the payment step only), the switch, the ledger and our caps.
export interface CardAccess {
  info: CardInfo;
  load: () => Promise<CardRecord | string>; // a string: why the card cannot be opened now
  off: () => string | undefined; // why card use is off now (the kill switch)
  ledger: Ledger;
  caps: { purchaseMinor: number; dayMinor: number };
}

export const capsFromSettings = (): CardAccess["caps"] => ({ purchaseMinor: Math.round(settings.cardCapPurchase * 100), dayMinor: Math.round(settings.cardCapDay * 100) });

// Undefined when there is no card, card use is off, a cap is 0 or the store cannot be read (the reason goes to `onProblem`).
export async function openCardAccess(o: { store?: CardStore; kill?: KillSwitch; ledger?: Ledger; caps?: CardAccess["caps"]; onProblem?: (reason: string) => void } = {}): Promise<CardAccess | undefined> {
  const store = o.store ?? new CardStore();
  const kill = o.kill ?? killSwitch;
  const caps = o.caps ?? capsFromSettings();
  if (kill.off() || caps.purchaseMinor <= 0 || caps.dayMinor <= 0) return undefined;
  let info: CardInfo | undefined;
  try {
    info = await store.peek();
  } catch (e) {
    o.onProblem?.((e as Error).message);
    return undefined;
  }
  if (!info) return undefined;
  const last4 = info.last4;
  return {
    info,
    caps,
    off: () => kill.off(),
    ledger: o.ledger ?? new Ledger(),
    load: async () => {
      try {
        const c = await store.load();
        return c && c.last4 === last4 ? c : "the card on file changed since this run started";
      } catch (e) {
        return e instanceof ProfileError ? e.message : "the card could not be opened";
      }
    },
  };
}
