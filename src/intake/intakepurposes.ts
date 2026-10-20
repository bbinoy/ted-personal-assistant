import { looksLikeCardNumber, sensitiveKind } from "../modules/browse/browserules.ts";
import { CARD_ITEM, cardProblem, parseExpiry } from "../modules/browse/card.ts";
import type { Data } from "../secrets/openbao.ts";
import { checkNewValue, cleanDomains, isSensitive, KEY_NAME, KINDS, kindOfKey, type Kind } from "../modules/browse/profile.ts";
import { LIMITS } from "../core/sanitize.ts";
import { CARD_TENANTS, type ItemKind } from "../secrets/secrets.ts";
import { settings } from "../core/settings.ts";
import type { Capability } from "../tenants/tenants.ts";
import type { Done } from "./intakelinks.ts";

// What each purpose of a setup link asks for and where it puts it. The page (intakeserver.ts) knows nothing about a purpose by name: it renders the
// fields, checks their shape and length, and hands the values to `store`. A purpose is the ONE place that says who may use it (`capability`), what it writes
// (`itemKind`, secrets.ts ITEM_KINDS: the page's writer, the OpenBao policies and the doctor's probe come from that list) and whether it can be offered now (`needs`).
// A new purpose (cvc: built later) is one more entry in PURPOSES. A purpose never echoes a value: everything it says about a problem is a fixed sentence.

// A problem with what was typed, in words for the person at the form. Never holds a value.
export class Invalid extends Error {}

export interface Field {
  name: string;
  label: string;
  help?: string;
  type: "text" | "password" | "select";
  max: number; // characters
  required: boolean;
  options?: readonly string[]; // for a select: the only values accepted
}
// Writes one item of the tenant the link belongs to (intakestore.ts).
export type Put = (kind: ItemKind, name: string, data: Data) => Promise<void>;

export interface Purpose {
  title: string;
  intro: string;
  capability: Capability; // what a person needs to be offered this purpose
  itemKind: ItemKind; // the kind of secret item it writes
  // The settings that are missing before this purpose can be offered at all (names, never values); none: it can. Google needs the instance's OAuth client; the others nothing.
  needs(): readonly string[];
  oauth?: string; // no form: the page shows a link to a sign-in at another service (the OAuthProvider with this id, oauth.ts) and its callback stores the result; `store` is never called
  fields(tenant: string): Field[];
  // Stores the checked values; what it stored, as names and lengths only. Throws Invalid for a problem the person can fix.
  store(tenant: string, values: Record<string, string>, put: Put): Promise<Done["stored"]>;
}

const csv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

// ---- saved details (profile.ts): one detail per submit ----

const AUTO = "auto";
const profile: Purpose = {
  capability: "profile",
  itemKind: "profile",
  needs: () => [],
  title: "Save a detail",
  intro: "Your assistant can type this into a web form for you when you ask it to. It never sees the value itself, only that it exists.",
  fields: () => [
    { name: "key", label: "Name", help: "Lowercase words like address.home, phone or passport.", type: "text", max: 40, required: true },
    { name: "value", label: "Value", type: "text", max: 200, required: true },
    { name: "kind", label: "What it is", help: "\"Detail\" lets the assistant work it out from the name.", type: "select", max: 12, required: false, options: [AUTO, ...KINDS] },
    { name: "domains", label: "Websites it may be typed on", help: "Like sbb.ch, trainline.com (separated by commas). Needed for ID numbers, birthdays and loyalty numbers.", type: "text", max: 200, required: false },
    { name: "labels", label: "Words the form field may use", help: "Optional, for a loyalty number: words like miles, member.", type: "text", max: 100, required: false },
  ],
  async store(_tenant, v, put) {
    const key = v.key!.trim();
    if (!KEY_NAME.test(key)) throw new Invalid("The name is lowercase letters, digits, dot, dash or underscore, starting with a letter (like address.home).");
    const kind = !v.kind || v.kind === AUTO ? kindOfKey(key) : (v.kind as Kind);
    if (!KINDS.includes(kind)) throw new Invalid("Choose one of the kinds in the list.");
    const { domains, bad } = cleanDomains(csv(v.domains ?? ""));
    if (bad.length) throw new Invalid("One of the websites is not a domain name (like sbb.ch).");
    const value = v.value!.trim();
    const problem = checkNewValue(value);
    if (problem) throw new Invalid(`Not saved: ${problem}.`);
    // Not a vault for card numbers or passwords (the same rule as npm run profile): those are never typed by the assistant.
    if (looksLikeCardNumber(value) || sensitiveKind(key, value)) throw new Invalid("Not saved: that looks like a card number, a password or a bank detail. Those are never stored here; a card has its own form.");
    // Nobody can name the sites afterwards (there is no terminal), so a sensitive value is saved with its sites or not at all.
    if (isSensitive({ kind }) && !domains.length) throw new Invalid("This kind of detail is saved only with the websites it may be typed on.");
    const labels = csv(v.labels ?? "").slice(0, 8).map((l) => l.slice(0, 30));
    await put("profile", key, { value, kind, domains, ...(labels.length ? { labels } : {}) });
    return [{ name: key, chars: value.length }];
  },
};

// ---- a card (card.ts): number, expiry, holder; the security code only for the owner's own card ----

const card: Purpose = {
  capability: "card",
  itemKind: "card",
  needs: () => [],
  title: "Save a card",
  intro: "Use a dedicated card with a low limit, never your main one. Your assistant pays with it only after you type YES in the chat.",
  fields: (tenant) => [
    { name: "label", label: "What you call it", help: "Like Wise or Travel card.", type: "text", max: LIMITS.name, required: true },
    { name: "number", label: "Card number", type: "password", max: 23, required: true },
    { name: "expiry", label: "Expires", help: "Month and year, like 12/29.", type: "text", max: 9, required: true },
    { name: "holder", label: "Name on the card", type: "text", max: LIMITS.name, required: true },
    { name: "currency", label: "Card currency", help: "Three letters, like CHF or EUR. A payment in another currency is refused.", type: "text", max: 3, required: true },
    // A friend's security code is never stored (secrets.ts CARD_TENANTS): her form has no such field, and the page refuses one that is sent anyway.
    ...(CARD_TENANTS.has(tenant) ? [{ name: "cvc", label: "Security code", type: "password" as const, max: 4, required: true }] : []),
  ],
  async store(tenant, v, put) {
    const pan = v.number!.replace(/[\s-]/g, "");
    const exp = parseExpiry(v.expiry!);
    if (!/^\d+$/.test(pan) || !exp) throw new Invalid("Check the card number and the expiry date (like 12/29).");
    const cvc = CARD_TENANTS.has(tenant) ? v.cvc! : "000"; // a stand-in for the shape check below only; it is never written for anyone else
    const currency = v.currency!.toUpperCase();
    const problem = cardProblem({ pan, ...exp, cvc, currency });
    if (problem) throw new Invalid(`Not saved: ${problem}.`);
    await put("card", CARD_ITEM, { pan, ...exp, currency, label: v.label!.trim(), holder: v.holder!.trim(), last4: pan.slice(-4), ...(CARD_TENANTS.has(tenant) ? { cvc } : {}) });
    return [{ name: "card", chars: pan.length }];
  },
};

// ---- her Google account (googleoauth.ts): not a form but a sign-in; the callback of the page stores the grant under tenants/<id>/google/oauth ----

const google: Purpose = {
  capability: "google",
  itemKind: "google",
  // Without the instance's OAuth client there is nothing to sign in with.
  needs: () => [!settings.google.clientId && "GOOGLE_OAUTH_CLIENT_ID", !settings.google.clientSecret && "GOOGLE_OAUTH_CLIENT_SECRET"].filter((x): x is string => !!x),
  title: "Connect Google",
  intro: "Connect your own Google account so your assistant can read and write your Gmail and your Calendar for you. You sign in on Google's own page, not here: nothing you type there reaches this page, and the assistant never sees a password or a key. It asks you in the chat before it sends a mail or invites anybody. You can take the access away any time at myaccount.google.com/permissions.",
  oauth: "google",
  fields: () => [],
  async store() {
    throw new Invalid("This link connects Google; use the button on the page.");
  },
};

// ---- her Notion (notionoauth.ts): also a sign-in; the callback stores the grant under tenants/<id>/notion/oauth ----

const notion: Purpose = {
  capability: "notion",
  itemKind: "notion",
  needs: () => [], // nothing but the page's public address (INTAKE_BASE_URL, which every purpose needs): the instance registers its own client with Notion the first time (notionoauth.ts)
  title: "Connect Notion",
  intro: "Connect your own Notion so your assistant can search and read the pages you share with it, and add or change pages when you ask. You sign in on Notion's own page and choose what to share, not here: nothing you type there reaches this page, and the assistant never sees a password or a key. It asks you in the chat before it changes anything. You can take the access away any time in Notion (Settings, Connections).",
  oauth: "notion",
  fields: () => [],
  async store() {
    throw new Invalid("This link connects Notion; use the button on the page.");
  },
};

// EXTENSION POINT: cvc goes here when it is built.
export const PURPOSES: Readonly<Record<string, Purpose>> = { profile, card, google, notion };
export const purposeOf = (id: string): Purpose | undefined => (Object.hasOwn(PURPOSES, id) ? PURPOSES[id] : undefined);
// Can this purpose be offered now (its settings are there)?
export const purposeAvailable = (p: Purpose): boolean => p.needs().length === 0;
