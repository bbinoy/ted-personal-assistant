import { emitRecord } from "../core/events.ts";
import { readJson, writeJson } from "../core/state.ts";
import { instancePaths } from "../core/convpaths.ts";
import { ASSISTANT, OWNER } from "../core/settings.ts";
import { ACI, addTenant, type TenantRecord } from "./tenants.ts";

// Open registration with the admin's approval. Anybody may write to the assistant; a stranger costs nothing and sees nothing: she gets ONE fixed line (tenantroute.ts),
// and the owner is asked in her own chat (approvals/registerask.ts) whether this person may become a friend. Until the owner says yes nothing she wrote reaches a model or
// the owner's eyes: her messages are held here (the last few, cut, in instance/registrations.json, which no run can read: policy.ts) and replayed as her first turn only after
// the yes. What the owner is shown is her sanitised profile name and a short id, nothing she typed.
//   instance/registrations.json   open requests (with the held messages), declined people, people the owner wrote to first and who may simply answer (E2: `invited`)
// Limits, in code: one open request per sender; at most MAX_OPEN open at once (beyond: silent drop); at most PER_HOUR new requests an hour in all; a request expires after
// 7 days (its held text goes with it) and its sender may ask again after COOLDOWN; a declined sender is silent for good until `npm run tenants -- forget <id>`.

export const FILE = instancePaths().registrations;
export const MAX_OPEN = 10;
export const EXPIRES_MS = 7 * 24 * 3600_000;
const COOLDOWN_MS = 24 * 3600_000;
const PER_HOUR = 3;
const HOUR = 3600_000;
const MAX_HELD = 3;
const HELD_CHARS = 2000;
const MAX_DECLINED = 500;
const MAX_COOLING = 500;
const MAX_INVITED = 50;
const INVITED_MS = 30 * 24 * 3600_000; // a hello the owner sent stays good for a month

export interface Held {
  text: string;
  timestamp: number;
}
export interface Request {
  aci: string;
  name: string; // her profile name, sanitised (letters, digits, spaces and a few marks), at most 40 characters
  number?: string; // her phone number when the messenger gave it (shown to the owner as her id)
  at: number;
  held: Held[];
}
interface Person {
  aci: string;
  name: string;
  at: number;
}
interface Invited {
  aci?: string;
  number?: string;
  at: number;
}
interface Store {
  requests: Request[];
  declined: Person[];
  cooling: { aci: string; until: number }[]; // asked, was not answered in 7 days: may ask again after this
  invited: Invited[];
}

const NUMBER = /^\+[1-9]\d{6,14}$/;

// A profile name is the stranger's text: only letters, digits, spaces and . ' _ - are kept, one line, 40 characters.
export const cleanName = (name: string | undefined): string => (name ?? "").replace(/[^\p{L}\p{N} .'_-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "unknown name";
// The short id the owner sees and the CLI takes: her number when the messenger gave one, else the first 8 characters of her account id.
export const shortId = (r: Pick<Request, "aci" | "number">): string => (r.number && NUMBER.test(r.number) ? r.number : r.aci.slice(0, 8));
export const labelOf = (r: Pick<Request, "aci" | "name" | "number">): string => `${r.name} (${shortId(r)})`;

function read(now: number): Store {
  const raw = readJson<Partial<Store>>(FILE, {});
  const all = (raw.requests ?? []).filter((r) => r && ACI.test(r.aci));
  const live = all.filter((r) => now - r.at < EXPIRES_MS);
  const cooling = [...(raw.cooling ?? []), ...all.filter((r) => now - r.at >= EXPIRES_MS).map((r) => ({ aci: r.aci, until: r.at + EXPIRES_MS + COOLDOWN_MS }))].filter((c) => c.until > now);
  const store: Store = {
    requests: live,
    declined: raw.declined ?? [],
    cooling: cooling.slice(-MAX_COOLING),
    invited: (raw.invited ?? []).filter((i) => now - i.at < INVITED_MS),
  };
  if (live.length !== (raw.requests ?? []).length) write(store); // an expired request's held text is deleted now, not at the next write
  return store;
}
const write = (s: Store): void => writeJson(FILE, s);

export const openRequests = (now = Date.now()): Request[] => read(now).requests;

export type Outcome = { kind: "new"; request: Request } | { kind: "held" } | { kind: "drop"; why: string };

// A stranger's first or later message. Only a "new" one is answered (once, fixed) and put to the owner; the rest are dropped silently, a later message of an open request
// only being held with the first ones (the last MAX_HELD, HELD_CHARS each).
export function register(who: { aci: string; name?: string; number?: string; text: string; timestamp: number }, now = Date.now()): Outcome {
  const aci = who.aci.toLowerCase();
  const s = read(now);
  if (s.declined.some((d) => d.aci === aci)) return { kind: "drop", why: "declined" };
  const held: Held[] = who.text.trim() ? [{ text: who.text.slice(0, HELD_CHARS), timestamp: who.timestamp }] : [];
  const open = s.requests.find((r) => r.aci === aci);
  if (open) {
    open.held = [...open.held, ...held].slice(-MAX_HELD);
    write(s);
    return { kind: "held" };
  }
  if (s.cooling.some((c) => c.aci === aci)) return { kind: "drop", why: "cooling down" };
  if (s.requests.length >= MAX_OPEN) return { kind: "drop", why: "too many open requests" };
  if (s.requests.filter((r) => now - r.at < HOUR).length >= PER_HOUR) return { kind: "drop", why: "too many new requests this hour" };
  const request: Request = { aci, name: cleanName(who.name), ...(who.number && NUMBER.test(who.number) ? { number: who.number } : {}), at: now, held };
  write({ ...s, requests: [...s.requests, request] });
  emitRecord("tenant_register", "requested", "chat", { id: shortId(request) }); // (no words: not her name, not her text)
  return { kind: "new", request };
}

// The people in `s` that `id` names: the id the owner sees (her number or 8 characters of her account id) or any longer start of her account id (at least 6 characters).
function match<T extends { aci: string; number?: string }>(list: readonly T[], id: string): T[] {
  const q = id.trim().toLowerCase();
  if (q.length < 6) return [];
  return list.filter((p) => p.aci.startsWith(q) || (!!p.number && p.number === id.trim()));
}

// Approve: she becomes a tenant. Her held messages are returned (and removed here) for the caller to replay as her first turn; a declined sender approved later has none.
// Undefined: nobody open or declined is called that, or the id is not unique.
export function approve(id: string, now = Date.now()): { tenant: TenantRecord; held: Held[]; request?: Request } | undefined {
  const s = read(now);
  const reqs = match(s.requests, id);
  const decl = match(s.declined, id);
  if (reqs.length + decl.length !== 1) return undefined;
  const r = reqs[0];
  const aci = (r ?? decl[0]!).aci;
  const tenant = addTenant({ aci, name: (r ?? decl[0]!).name }, now);
  if (!tenant) return undefined;
  write({ ...s, requests: s.requests.filter((x) => x.aci !== aci), declined: s.declined.filter((x) => x.aci !== aci) });
  emitRecord("tenant_register", "approved", "chat", { id: tenant.id });
  return { tenant, held: r?.held ?? [], request: r };
}

// Decline: remembered, silent, her held text deleted. False: no such open request.
export function decline(id: string, now = Date.now()): boolean {
  const s = read(now);
  const reqs = match(s.requests, id);
  if (reqs.length !== 1) return false;
  const r = reqs[0]!;
  write({ ...s, requests: s.requests.filter((x) => x !== r), declined: [...s.declined, { aci: r.aci, name: r.name, at: now }].slice(-MAX_DECLINED) });
  emitRecord("tenant_register", "declined", "chat", { id: shortId(r) });
  return true;
}

// Forget a declined (or open) sender entirely: she may ask again.
export function forget(id: string, now = Date.now()): boolean {
  const s = read(now);
  const hit = [...match(s.requests, id), ...match(s.declined, id)];
  if (new Set(hit.map((h) => h.aci)).size !== 1) return false;
  const aci = hit[0]!.aci;
  write({ ...s, requests: s.requests.filter((x) => x.aci !== aci), declined: s.declined.filter((x) => x.aci !== aci), cooling: s.cooling.filter((c) => c.aci !== aci) });
  return true;
}

// ---- people the owner wrote to first (E2): when they answer they are in, no question ----

export function markInvited(who: { aci?: string; number?: string }, now = Date.now()): void {
  const s = read(now);
  write({ ...s, invited: [...s.invited, { ...(who.aci ? { aci: who.aci.toLowerCase() } : {}), ...(who.number ? { number: who.number } : {}), at: now }].slice(-MAX_INVITED) });
}
// Is this sender somebody the owner wrote to? Used up by the answer (one hello, one registration).
export function takeInvited(who: { aci: string; number?: string }, now = Date.now()): boolean {
  const s = read(now);
  const aci = who.aci.toLowerCase();
  const at = s.invited.findIndex((i) => i.aci === aci || (!!i.number && !!who.number && i.number === who.number));
  if (at < 0) return false;
  write({ ...s, invited: s.invited.filter((_, i) => i !== at) });
  return true;
}

// One line per open request and declined sender, for `npm run tenants -- pending` and the doctor. Never her messages.
export function describePending(now = Date.now()): string[] {
  const s = read(now);
  const when = (ms: number) => new Date(ms).toLocaleString();
  return [
    ...s.requests.map((r) => `open: ${labelOf(r)}; asked ${when(r.at)}, expires ${when(r.at + EXPIRES_MS)}; ${r.held.length} message(s) held`),
    ...s.declined.map((d) => `declined: ${d.name} (${d.aci.slice(0, 8)}); ${when(d.at)}`),
  ];
}

// ---- the owner writes first (E2): one fixed hello to a number or a username ----

const USERNAME = /^[A-Za-z_][A-Za-z0-9_]{2,31}\.\d{2,20}$/;
export const isRecipient = (x: string): boolean => NUMBER.test(x) || USERNAME.test(x);
// The only text the assistant ever sends to somebody who has not written to it: fixed, no model, never anything the owner or anybody else typed.
export const helloText = (): string => `Hi, I'm ${ASSISTANT}, an AI assistant that works for ${OWNER}. ${OWNER} asked me to say hello. Reply here whenever you like and we can chat.`;

// Owner-initiated (CLI `invite`, or the owner's chat tool, which asks her first): send the hello, then remember the person so that her reply makes her a friend with no question.
// She is remembered by the account id the messenger reports (or her number); a username the messenger could not resolve leaves her to the ordinary request.
export async function invitePerson(recipient: string, send: (recipient: string, text: string) => Promise<{ timestamp: number; accountId?: string }>, now = Date.now()): Promise<{ preapproved: boolean }> {
  const to = /^\+?[\d\s().-]+$/.test(recipient.trim()) ? recipient.replace(/[\s().-]/g, "") : recipient.trim(); // a number as people write it ("+44 7891 563044", "+1 (555) 555-0114"): only digits and the plus count
  if (!isRecipient(to)) throw new Error("a recipient is a phone number like +15555550114 or a username like name.42");
  const sent = await send(to, helloText());
  const aci = sent.accountId && ACI.test(sent.accountId) ? sent.accountId : undefined;
  const number = NUMBER.test(to) ? to : undefined;
  if (!aci && !number) return { preapproved: false };
  markInvited({ aci, number }, now);
  emitRecord("tenant_register", "invited", "chat", { id: aci ? aci.slice(0, 8) : "number" });
  return { preapproved: true };
}
