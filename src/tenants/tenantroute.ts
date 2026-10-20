import { CODE_PATTERN } from "../secrets/onetime.ts";
import { ACI, redeemInvite, tenantByAci, type TenantRecord } from "./tenants.ts";
import { ASSISTANT, OWNER, settings } from "../core/settings.ts";
import { directTarget } from "@ted-assistant/messenger";

// Who is this sender? The door for everybody who is not the owner (main.ts), with TENANTS=on. Pure of Signal: a sender and her text in, a decision out.
//   a tenant (invited or active)  -> her conversation
//   a suspended tenant            -> nothing at all, not even a reply (she is not told, not logged as a message)
//   anybody else                  -> a FIXED reply, written here, with NO model call: an invitation (or "that code is not valid"), at most once in a while
//                                    per person and a few per hour in all. A valid code makes her a tenant and welcomes her, also fixed.
// The assistant never writes first to a stranger: every reply here answers a message she sent. Whatever is not a decision (a message with no account
// id, a flood) is dropped, as it always was.

// Said once, in the first thing she is ever told (tenantrun.ts): that it is an AI, that her notes are private from other users and from the admin
// through the assistant, and the honest limit of that: whoever runs the computer could technically read the files on it (docs/SAFETY.md, host admin trust).
export const DISCLOSURE = "You're talking to an AI, and its answers may be wrong. What you tell me and what I note down stays private from other users and from the admin: I won't show it to them. Whoever runs this computer could still technically read the files on it.";
export const invitationReply = (): string => `Hi, I'm ${ASSISTANT}, an AI assistant that works for ${OWNER}. I only chat with people ${OWNER} has invited. If you have an invitation code, send it to me here; otherwise I can't help, sorry.`;
export const badCodeReply = (): string => `That code isn't valid (it may have been used already, or it has expired). Please ask ${OWNER} for a new one.`;
export const welcomeReply = (name: string): string => `${DISCLOSURE}\n\nWelcome${name ? `, ${name}` : ""}! Your invitation worked. Before we can talk I need a quick confirmation of your age and region. Never type a password or any other secret into this chat.`;
export const notSetUpReply = (): string => `I'm not set up for friends yet, so I can't reply for now. I've let ${OWNER} know.`;

export type Route =
  | { kind: "tenant"; tenant: TenantRecord }
  | { kind: "reply"; text: string; welcome?: TenantRecord } // a fixed reply to a stranger (no model call); `welcome`: she just joined
  | { kind: "ignore"; why: string };

// A tenant who may be talked to (not suspended), by her account id: reactions and deletions only ever reach one of these.
export const activeTenant = (aci: string | undefined): TenantRecord | undefined => {
  const t = tenantByAci(aci);
  return t && t.status !== "suspended" ? t : undefined;
};

export interface Sender {
  aci?: string; // her Signal account id: the identity
  name?: string; // her profile name, if Signal gave it
  text: string;
}

// Small bounded memories of who was answered when. In memory only: a restart forgets them, which costs at most one more fixed reply.
const MAX_REMEMBERED = 1000;
const repliedAt = new Map<string, number>();
const badCodes = new Map<string, number[]>();
let sentThisHour: number[] = [];
const HOUR = 3600_000;
const MAX_BAD_CODES = 5; // a person may try this many wrong codes an hour; then she is not answered at all
const MAX_FIXED_PER_HOUR = 20; // all strangers together

function trim<K, V>(m: Map<K, V>): void {
  while (m.size > MAX_REMEMBERED) m.delete(m.keys().next().value!);
}

export function forgetRouting(): void {
  repliedAt.clear();
  badCodes.clear();
  sentThisHour = [];
}

export function routeSender(who: Sender, now = Date.now()): Route {
  if (!settings.tenants) return { kind: "ignore", why: "tenants are off" };
  const aci = who.aci?.toLowerCase();
  if (!aci || !ACI.test(aci)) return { kind: "ignore", why: "no account id" };
  const known = tenantByAci(aci);
  if (known) return known.status === "suspended" ? { kind: "ignore", why: "suspended" } : { kind: "tenant", tenant: known };

  // A stranger. A code in her message is tried (a few times an hour); anything else gets the invitation.
  const code = CODE_PATTERN.exec(who.text)?.[0];
  if (code) {
    const tries = (badCodes.get(aci) ?? []).filter((t) => now - t < HOUR);
    if (tries.length >= MAX_BAD_CODES) return { kind: "ignore", why: "too many wrong codes" };
    const joined = redeemInvite(code, { aci, name: who.name }, now);
    if (joined) {
      badCodes.delete(aci);
      return { kind: "reply", text: welcomeReply(joined.name), welcome: joined };
    }
    badCodes.delete(aci);
    badCodes.set(aci, [...tries, now]);
    trim(badCodes);
  }
  // At most one fixed reply to her per TENANT_NOTICE_MINUTES, and a handful an hour in all.
  sentThisHour = sentThisHour.filter((t) => now - t < HOUR);
  const last = repliedAt.get(aci);
  if (last !== undefined && now - last < settings.tenantNoticeMinutes * 60_000) return { kind: "ignore", why: "already answered" };
  if (sentThisHour.length >= MAX_FIXED_PER_HOUR) return { kind: "ignore", why: "too many fixed replies" };
  sentThisHour.push(now);
  repliedAt.delete(aci);
  repliedAt.set(aci, now);
  trim(repliedAt);
  return { kind: "reply", text: code ? badCodeReply() : invitationReply() };
}

export interface StrangerIo {
  reply(to: string, text: string): Promise<unknown>; // a fixed message to one person (a conversation target: the messenger's directTarget)
  deliver(tenant: TenantRecord): void; // her message goes to her conversation
  welcomed?(tenant: TenantRecord): void; // she just joined; the welcome carries the AI disclosure
}

// A private message from someone other than the owner, end to end: the decision above, then what it asks for. A fixed reply is the only thing that
// can be sent from here, and it needs no model. Returns the decision (for the log and tests).
export function admitStranger(m: Pick<Sender, "name" | "text"> & { fromUuid?: string }, io: StrangerIo, now = Date.now()): Route {
  const decided = routeSender({ aci: m.fromUuid, name: m.name, text: m.text }, now);
  if (decided.kind === "tenant") io.deliver(decided.tenant);
  else if (decided.kind === "reply") {
    if (decided.welcome) io.welcomed?.(decided.welcome);
    void io.reply(directTarget(m.fromUuid!), decided.text).catch((e) => console.error("invitation reply failed:", (e as Error).message));
  }
  return decided;
}
