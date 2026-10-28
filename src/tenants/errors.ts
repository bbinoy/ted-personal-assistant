import { noteRateLimit } from "../core/cooldown.ts";
import { reportKeyProblem } from "./keynotice.ts";
import { cooldownKeyOf, LOGIN, type Payer } from "./payer.ts";
import { takeCapNotice } from "../core/capnotice.ts";
import { OWNER } from "../core/settings.ts";

// The failures that have their own message, instead of "something broke".
export class AuthError extends Error {} // the Claude login expired
export class RateLimitError extends Error {} // the plan's usage limit is hit
// The instance key (TENANT_ANTHROPIC_API_KEY) that friends run on was refused (a limit, an empty balance, a rejected request or key): the key's cooldown (cooldown.ts,
// shared by every friend, payer.ts), never the owner's login's.
export class InstanceKeyError extends Error {
  readonly why: "limit" | "billing" | "refused";
  constructor(why: "limit" | "billing" | "refused") {
    super(`instance key: ${why}`);
    this.why = why;
  }
}

// An answer from the API that says "no, not now" (as against a call that merely failed): the callers stop and let the cooldown do its work.
export const isApiRefusal = (e: unknown): e is AuthError | RateLimitError | InstanceKeyError => e instanceof AuthError || e instanceof RateLimitError || e instanceof InstanceKeyError;

// What to tell whom, by what went wrong and who is reading: the owner in their own chat (where to look), a group (nobody there should be sent to a terminal), a friend
// (no terminals, no logs; the account is the instance's, not hers, so she is told who must fix it).
export type Audience = "owner" | "group" | "friend";
// What went wrong, in the classes a person can act on (also what the background-failure notice says, heartbeat/notices.ts). A connector's failure reaches us only as text from the SDK, hence the words.
export type Cause = "login" | "limit" | "billing" | "refused" | "timeout" | "connector" | "reconnect" | "other";
// THE table from a cause to what the OWNER is told and the ONE next step she can take (the exact command, the exact setting, or the exact place in the Claude app). Every owner-facing failure
// text ends with `fix`: the chat notices below; the failing-looks FACT for the owner's next look carries it too (heartbeat/notices.ts). No secret, token or word of a friend's: a fixed sentence per cause. A friend's reconnect puts
// no minted link in the message (a link is a secret that works once): the fix is the sentence that makes the assistant send HER one, in her own chat.
export const FIXES: Readonly<Record<Cause, { what: string; fix: string }>> = {
  login: { what: "my Claude login expired", fix: "On the Mac, run `claude auth login`." },
  limit: { what: "the plan's usage limit is hit", fix: "It lifts by itself; message me again after it resets." },
  billing: { what: "the shared API key has no credit left", fix: "Add credit to the account behind TENANT_ANTHROPIC_API_KEY in .env, then restart." },
  refused: { what: "the shared API key was refused", fix: "Check TENANT_ANTHROPIC_API_KEY in .env, then restart." },
  timeout: { what: "the looks are timing out", fix: "Raise RUN_MAX_MINUTES_CHAT in .env, then restart." },
  connector: { what: "a connector (Notion, Calendar or Gmail) is not answering", fix: "Reconnect it in the Claude app under Settings > Connectors (`npm run doctor` says which)." },
  reconnect: { what: "a friend's Notion or Google permission expired", fix: 'Ask her to message me "reconnect Google" (or Notion): I send her a new one-time link in her own chat (`npm run doctor` lists who).' },
  other: { what: "the model run keeps failing", fix: "Run `npm run doctor`; it reads the errors in logs/agent.log." },
};

// ---- what a person is told when Ted cannot serve them right now: ONE table, by reason and audience ----
// Fixed texts, on purpose (CLAUDE.md §4): they go to people for whom no model run is possible at that moment (a refused key, a spent day, a cooldown), or after a run has failed. Short and kind; the
// owner's own end with the one step (FIXES). A day's ceiling (the owner's budget or the shared key's, a group's or a friend's own) is said once a day, the others every 30 minutes (refusalOnce).
export type Reason = Cause | "owner-budget" | "shared-budget" | "cooldown" | "no-key";
export interface RefusalFacts {
  until?: string; // a cooldown: when it ends, as a clock time
  limit?: number; // a friend's own day: her ceiling
}
const OTHER = "Something broke on my end, sorry. Try again in a bit.";
const LIMIT = "I've hit my usage limit for now, so I can't think until it resets. Try me again a bit later.";
const SLOW = "That took too long, so I stopped. Try something smaller, or ask again.";
type Say = string | ((o: RefusalFacts) => string);
const REFUSALS: Readonly<Record<Reason, Readonly<Partial<Record<Audience, Say>>>>> = {
  login: { owner: `My login expired, so I can't think. ${FIXES.login.fix}`, group: `I can't think right now: my login has expired, and ${OWNER} needs to fix it.` },
  limit: { owner: `I've hit my usage limit for now, so I can't think until it resets. ${FIXES.limit.fix}`, group: LIMIT, friend: "The account I run on for friends has hit a usage limit, so I can't think for a while. I'll answer again once the limit has lifted." },
  billing: { owner: `The shared API key has no credit left, so friends get no answers. ${FIXES.billing.fix}`, friend: `The account I run on for friends says there is no credit left (or a billing problem). ${OWNER} needs to look at it; I can answer again once that is fixed.` },
  refused: { owner: `The shared API key was refused, so friends get no answers. ${FIXES.refused.fix}`, friend: `Anthropic refused the request made with the account I run on for friends. ${OWNER} needs to check it; I'll try again later.` },
  timeout: { owner: "That ran too long and I stopped it. Raise RUN_MAX_MINUTES_CHAT in .env and restart, or ask for something smaller.", group: SLOW, friend: SLOW },
  connector: { owner: `A connector I need (Notion, Calendar or Gmail) did not answer. ${FIXES.connector.fix}` },
  reconnect: { owner: `A friend's Notion or Google connection no longer works. ${FIXES.reconnect.fix}` },
  other: { owner: `Something broke on my end and I don't know the cause. Check the logs: ${FIXES.other.fix}` },
  "owner-budget": { group: `I've used up my budget for today, so I can't answer until tomorrow. ${OWNER} can raise it if it is urgent.` },
  "shared-budget": { friend: "I've hit today's shared limit, so I'm resting until tomorrow. Your message is saved." },
  cooldown: { friend: (o) => `I'm paused for a while (a usage limit, a billing problem or a refused request on the account I run on). I'll try again around ${o.until}.` },
  "no-key": { friend: `I'm not set up for friends yet, so I can't reply for now. I've let ${OWNER} know.` },
};
export function refusal(reason: Reason, audience: Audience, o: RefusalFacts = {}): string {
  const say = REFUSALS[reason][audience] ?? OTHER;
  return typeof say === "function" ? say(o) : say;
}
// The same line to the same person or group (key: their convId) at most once a day for a day's ceiling, else every 30 minutes (capnotice.ts); undefined: it was said, stay silent.
export function refusalOnce(reason: Reason, audience: Audience, convId: string, o: RefusalFacts = {}, now = Date.now()): string | undefined {
  const every = reason === "cooldown" || reason === "no-key" ? 30 * 60_000 : undefined;
  return takeCapNotice(`refusal:${reason}:${convId}`, now, every) ? refusal(reason, audience, o) : undefined;
}
export const noticeFor = (audience: Audience) => (e: unknown): string => refusal(causeOf(e), audience);
const CONNECTOR_WORDS = /\bmcp\b|connector|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|server .*(?:failed|not connected|disconnected)/i;
const RECONNECT_WORDS = /permission expired or was withdrawn|has not connected (?:Google|Notion)/i; // (googlemcp.ts GoogleReconnect, notionoauth.ts NotionReconnect: fixed sentences)
export function causeOf(e: unknown): Cause {
  if (e instanceof AuthError) return "login";
  if (e instanceof RateLimitError) return "limit";
  if (e instanceof InstanceKeyError) return e.why;
  if (e instanceof Error && /^run timed out after/.test(e.message)) return "timeout"; // (ceiling.ts RunTimeout; tenants may not import run)
  if (e instanceof Error && RECONNECT_WORDS.test(e.message)) return "reconnect";
  return e instanceof Error && CONNECTOR_WORDS.test(e.message) ? "connector" : "other";
}
// The SDK reports a failed turn as an assistant error code and an error result. `payer`: whose call it was. On the instance key any refusal of the key is the key's (HTTP
// 429, 400 and 402 arrive as rate_limit, invalid_request, billing_error): its cooldown, and the owner's one notice (keynotice.ts); on the login an expired login or the plan's limit.
// The one place a call is found to have failed, whoever started it and whatever it was (a chat turn, the gate, triage, the dream, compaction, a mail handler run).
export function failure(lastError: string | undefined, subtype: string, payer: Payer = LOGIN): Error {
  if (payer.kind === "instance") {
    const why = lastError === "rate_limit" || lastError === "overloaded" ? "limit" : lastError === "billing_error" || lastError === "account_on_hold" ? "billing" : lastError === "authentication_failed" || lastError === "invalid_request" || lastError === "oauth_org_not_allowed" || lastError === "verification_required" ? "refused" : undefined;
    if (why) {
      noteRateLimit(Date.now(), cooldownKeyOf(payer));
      if (lastError !== "overloaded") reportKeyProblem("refused"); // (an overloaded API is not the key's fault)
      return new InstanceKeyError(why);
    }
    return new Error(`agent turn ended with ${subtype}${lastError ? ` (${lastError})` : ""}`);
  }
  if (lastError === "authentication_failed") return new AuthError("authentication_failed");
  if (lastError === "rate_limit") return noteRateLimit(), new RateLimitError("rate_limit"); // also starts the shared cooldown of background jobs (cooldown.ts)
  return new Error(`agent turn ended with ${subtype}${lastError ? ` (${lastError})` : ""}`);
}
