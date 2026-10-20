import { cardProblem, capsFromSettings, expiryText, parseExpiry, CardStore, type CardRecord, type KillSwitch } from "./card.ts";
import { formatMoney } from "./paymentrules.ts";
import type { Ledger } from "./payments.ts";
import { ProfileError } from "./profile.ts";
import { LIMITS } from "../../sanitize.ts";

// The owner's local command for the payment card: npm run card -- set|list|enable|disable|delete|payments|clear. The card number, expiry
// and security code are typed at hidden terminal prompts, never given as an argument (shell history, process list) and never through
// the chat (logged, goes to the model). Nothing this command prints holds more than the last four digits.

export interface CardCliDeps {
  store: CardStore;
  kill: KillSwitch;
  ledger: Ledger;
  readHidden: (prompt: string) => Promise<string>;
  out: (line: string) => void;
  now?: Date;
}

const USAGE = [
  "usage: npm run card -- <command>",
  "  set [--currency CHF] [--label Wise]   asks for the card number, expiry and security code at hidden prompts, and saves them in OpenBao",
  "  list                                  the card by its last four digits, its caps and whether card payments are on",
  "  disable                               the kill switch: no card payment, whatever the chat says (the chat has /card off too)",
  "  enable                                switch card payments on again (only possible here, never from the chat)",
  "  payments                              the last payments (merchant, amount, last four, status)",
  "  clear <id>                            an unconfirmed payment you checked in the card app: stops blocking a retry and no longer counts as spent",
  "  delete                                remove the card from OpenBao",
];

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// Returns the exit code.
export async function cardCli(argv: string[], d: CardCliDeps): Promise<number> {
  const [cmd, arg] = argv;
  const args = argv.slice(1);
  try {
    if (cmd === "set") {
      const currency = (flag(args, "currency") ?? "CHF").trim().toUpperCase();
      const label = (flag(args, "label") ?? "Card").trim().slice(0, LIMITS.name) || "Card";
      const pan = (await d.readHidden("Card number (hidden): ")).replace(/[\s-]/g, "");
      if (!/^\d+$/.test(pan)) return fail(d, "Not saved: the card number is digits only.");
      const exp = parseExpiry(await d.readHidden("Expiry, month and year like 12/29 (hidden): "));
      if (!exp) return fail(d, "Not saved: the expiry date is a month and year like 12/29.");
      const cvc = (await d.readHidden("Security code (hidden): ")).trim();
      const holder = (await d.readHidden("Name on the card, if a payment form asks for it (hidden, Enter to skip): ")).trim();
      const card: CardRecord = { pan, ...exp, cvc, label, last4: pan.slice(-4), currency, ...(holder ? { holder: holder.slice(0, LIMITS.name) } : {}) };
      const problem = cardProblem(card, d.now);
      if (problem) return fail(d, `Not saved: ${problem}.`);
      await d.store.save(card);
      const caps = capsFromSettings();
      d.out(`Saved ${label} ••••${card.last4} (${currency}, security code stored). Card payments need your typed YES each time; our caps: ${currency} ${(caps.purchaseMinor / 100).toFixed(2)} per payment, ${(caps.dayMinor / 100).toFixed(2)} per day (CARD_CAP_PURCHASE, CARD_CAP_DAY).`);
      return 0;
    }
    if (cmd === "list") {
      const card = await d.store.load();
      const off = d.kill.off();
      if (!card) d.out("No card is saved. Add one with: npm run card -- set");
      else {
        const caps = capsFromSettings();
        d.out(`${card.label} ••••${card.last4}  ${card.currency}  expires ${expiryText(card)}  caps ${card.currency} ${(caps.purchaseMinor / 100).toFixed(2)} per payment, ${(caps.dayMinor / 100).toFixed(2)} per day`);
      }
      d.out(off ? `Card payments are OFF (${off}). Switch on: npm run card -- enable` : "Card payments are on (each one needs your typed YES).");
      return 0;
    }
    if (cmd === "disable") {
      d.kill.turnOff("at the terminal", d.now);
      d.out("Card payments are off. Switch on again with: npm run card -- enable");
      return 0;
    }
    if (cmd === "enable") {
      d.out(d.kill.turnOn() ? "Card payments are on again (each one needs your typed YES)." : "Card payments were already on.");
      return 0;
    }
    if (cmd === "payments") {
      const rows = d.ledger.rows().slice(-10);
      if (!rows.length) d.out("No card payments yet.");
      for (const r of rows) d.out(`${r.id}  ${r.ts.slice(0, 16).replace("T", " ")}  ${r.merchant.padEnd(24)} ${formatMoney({ minor: r.totalMinor, currency: r.currency }).padEnd(14)} ••••${r.last4}  ${r.status}`);
      return 0;
    }
    if (cmd === "clear" && arg) {
      const row = d.ledger.rows().find((r) => r.id === arg);
      if (!row) return fail(d, `No payment ${arg}.`);
      if (row.status !== "unconfirmed" && row.status !== "failed") return fail(d, `Payment ${arg} is ${row.status}; only an unconfirmed or failed one is cleared.`);
      d.ledger.setStatus(arg, "cleared", d.now);
      d.out(`Payment ${arg} is cleared: it no longer blocks a retry or counts as spent. Check the card app first if you are not sure it was not charged.`);
      return 0;
    }
    if (cmd === "delete") {
      d.out((await d.store.remove()) ? "The card is deleted from OpenBao." : "No card was saved.");
      return 0;
    }
  } catch (e) {
    if (e instanceof ProfileError) return fail(d, e.message);
    throw e;
  }
  USAGE.forEach(d.out);
  return cmd ? 1 : 0;
}

const fail = (d: CardCliDeps, msg: string): number => (d.out(msg), 1);
