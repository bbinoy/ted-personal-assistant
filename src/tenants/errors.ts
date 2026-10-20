import { noteRateLimit } from "../core/cooldown.ts";
import { reportKeyProblem } from "./keynotice.ts";
import { cooldownKeyOf, LOGIN, type Payer } from "./payer.ts";
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
type Kind = "auth" | "limit" | "billing" | "refused" | "other";
const OTHER = "Something broke on my end, sorry. Try again in a bit.";
const LIMIT = "I've hit my usage limit for now, so I can't think until it resets. Try me again a bit later.";
const NOTICES: Readonly<Record<Kind, Readonly<Record<Audience, string>>>> = {
  auth: { owner: "My login expired. On the Mac, run `claude auth login`, then message me again.", group: `I can't think right now: my login has expired, and ${OWNER} needs to fix it.`, friend: OTHER },
  limit: { owner: LIMIT, group: LIMIT, friend: "The account I run on for friends has hit a usage limit, so I can't think for a while. I'll answer again once the limit has lifted." },
  billing: { owner: OTHER, group: OTHER, friend: `The account I run on for friends says there is no credit left (or a billing problem). ${OWNER} needs to look at it; I can answer again once that is fixed.` },
  refused: { owner: OTHER, group: OTHER, friend: `Anthropic refused the request made with the account I run on for friends. ${OWNER} needs to check it; I'll try again later.` },
  other: { owner: "Something broke on my end. Check the logs, I'm not telling you what it was.", group: OTHER, friend: OTHER },
};
const kindOf = (e: unknown): Kind => (e instanceof AuthError ? "auth" : e instanceof RateLimitError ? "limit" : e instanceof InstanceKeyError ? (e.why === "limit" ? "limit" : e.why) : "other");
export const noticeFor = (audience: Audience) => (e: unknown): string => NOTICES[kindOf(e)][audience];

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
