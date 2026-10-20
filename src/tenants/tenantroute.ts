import { register, takeInvited, type Request } from "./registration.ts";
import { ACI, addTenant, tenantByAci, type TenantRecord } from "./tenants.ts";
import { ASSISTANT, OWNER, settings } from "../core/settings.ts";
import { directTarget } from "@ted-assistant/messenger";

// Who is this sender? The door for everybody who is not the owner (main.ts), with TENANTS=on. Pure of Signal: a sender and her text in, a decision out.
//   a tenant (invited or active)  -> her conversation
//   a suspended tenant            -> nothing at all, not even a reply (she is not told, not logged as a message)
//   somebody the owner wrote to   -> a tenant at once (the owner started it: no question), and her message is her first turn
//   anybody else                  -> a request (registration.ts): ONE fixed line, no model call, her message held; the owner is asked in her own chat whether she may join.
//                                    Everything after that, from her, is held silently (the last few) until the owner has answered.
// The assistant never writes first to a stranger: the one line answers a message she sent. Whatever is not a decision (a message with no account id, a flood, a
// declined sender) is dropped, as it always was.

// Said once, in the first thing she is ever told (tenantrun.ts): that it is an AI, that her notes are private from other users and from the admin
// through the assistant, and the honest limit of that: whoever runs the computer could technically read the files on it (docs/SAFETY.md, host admin trust).
export const DISCLOSURE = "You're talking to an AI, and its answers may be wrong. What you tell me and what I note down stays private from other users and from the admin: I won't show it to them. Whoever runs this computer could still technically read the files on it.";
// The only thing a stranger is ever told before the owner has answered. Fixed, no model.
export const holdingReply = (): string => `Hi, I'm ${ASSISTANT}, an AI assistant. I've asked my admin whether I may chat with you; if so, you'll hear back from me here.`;
export const notSetUpReply = (): string => `I'm not set up for friends yet, so I can't reply for now. I've let ${OWNER} know.`;

export type Route =
  | { kind: "tenant"; tenant: TenantRecord }
  | { kind: "request"; text: string; request: Request } // a new request: the fixed line to her (no model call) and the question to the owner
  | { kind: "ignore"; why: string };

// A tenant who may be talked to (not suspended), by her account id: reactions and deletions only ever reach one of these.
export const activeTenant = (aci: string | undefined): TenantRecord | undefined => {
  const t = tenantByAci(aci);
  return t && t.status !== "suspended" ? t : undefined;
};

export interface Sender {
  aci?: string; // her Signal account id: the identity
  name?: string; // her profile name, if Signal gave it
  number?: string; // her phone number, if Signal gave it
  text: string;
  timestamp?: number;
}

export function routeSender(who: Sender, now = Date.now()): Route {
  if (!settings.tenants) return { kind: "ignore", why: "tenants are off" };
  const aci = who.aci?.toLowerCase();
  if (!aci || !ACI.test(aci)) return { kind: "ignore", why: "no account id" };
  const known = tenantByAci(aci);
  if (known) return known.status === "suspended" ? { kind: "ignore", why: "suspended" } : { kind: "tenant", tenant: known };
  if (takeInvited({ aci, number: who.number }, now)) {
    const joined = addTenant({ aci, name: who.name }, now);
    if (joined) return { kind: "tenant", tenant: joined };
  }
  const r = register({ aci, name: who.name, number: who.number, text: who.text, timestamp: who.timestamp ?? now }, now);
  if (r.kind === "new") return { kind: "request", text: holdingReply(), request: r.request };
  return { kind: "ignore", why: r.kind === "held" ? "held until the owner answers" : r.why };
}

export interface StrangerIo {
  reply(to: string, text: string): Promise<unknown>; // a fixed message to one person (a conversation target: the messenger's directTarget)
  deliver(tenant: TenantRecord): void; // her message goes to her conversation
  requested?(request: Request): void; // a new request: ask the owner
}

// A private message from someone other than the owner, end to end: the decision above, then what it asks for. A fixed line is the only thing that
// can be sent from here, and it needs no model. Returns the decision (for the log and tests).
export function admitStranger(m: Pick<Sender, "name" | "text" | "number" | "timestamp"> & { fromUuid?: string }, io: StrangerIo, now = Date.now()): Route {
  const decided = routeSender({ aci: m.fromUuid, name: m.name, number: m.number, text: m.text, timestamp: m.timestamp }, now);
  if (decided.kind === "tenant") io.deliver(decided.tenant);
  else if (decided.kind === "request") {
    void io.reply(directTarget(m.fromUuid!), decided.text).catch((e) => console.error("holding reply failed:", (e as Error).message));
    io.requested?.(decided.request);
  }
  return decided;
}
