import { noteRateLimit } from "./cooldown.ts";
import { reportKeyProblem } from "./keynotice.ts";
import { OWNER } from "./settings.ts";

// The two failures that have their own message for the owner, instead of "something broke".
export class AuthError extends Error {} // the Claude login expired
export class RateLimitError extends Error {} // the plan's usage limit is hit
// A tenant's own API key was refused (a limit, an empty balance, a rejected request or key): her cooldown only (cooldown.ts), never the instance's.
export class TenantKeyError extends Error {
  readonly why: "limit" | "billing" | "refused";
  constructor(why: "limit" | "billing" | "refused") {
    super(`tenant key: ${why}`);
    this.why = why;
  }
}

// What to tell the owner in their own chat.
export function errorNotice(e: unknown): string {
  return e instanceof AuthError
    ? "My login expired. On the Mac, run `claude auth login`, then message me again."
    : e instanceof RateLimitError
      ? "I've hit my usage limit for now, so I can't think until it resets. Try me again a bit later."
      : "Something broke on my end. Check the logs, I'm not telling you what it was.";
}

// What to tell a tenant in her own chat: nothing about terminals or logs, and the cost is hers.
export function tenantErrorNotice(e: unknown): string {
  if (e instanceof TenantKeyError) {
    return e.why === "limit"
      ? "Your Anthropic API key has hit a usage limit, so I can't think for a while. I'll answer again once the limit has lifted."
      : e.why === "billing"
        ? "Your Anthropic account says there is no credit left (or a billing problem). Please check it; I can answer again once that is fixed."
        : "Anthropic refused the request made with your API key. Please check that the key is valid; I'll try again later.";
  }
  return "Something broke on my end, sorry. Try again in a bit.";
}

// What to say in a group, where nobody should be sent to a terminal.
export function groupErrorNotice(e: unknown): string {
  return e instanceof AuthError
    ? `I can't think right now: my login has expired, and ${OWNER} needs to fix it.`
    : e instanceof RateLimitError
      ? "I've hit my usage limit for now, so I can't think until it resets. Try me again a bit later."
      : "Something broke on my end, sorry. Try again in a bit.";
}

// The SDK reports a failed turn as an assistant error code and an error result.
// `tenant`: the run is a tenant's, on her own key: any refusal of that key is hers (HTTP 429, 400 and 402 arrive as rate_limit, invalid_request, billing_error).
export function failure(lastError: string | undefined, subtype: string, tenant?: string): Error {
  if (tenant) {
    const why = lastError === "rate_limit" || lastError === "overloaded" ? "limit" : lastError === "billing_error" || lastError === "account_on_hold" ? "billing" : lastError === "authentication_failed" || lastError === "invalid_request" || lastError === "oauth_org_not_allowed" || lastError === "verification_required" ? "refused" : undefined;
    // The one place a friend's run is found to have failed on the shared key, whoever started the run: her cooldown, and the owner's one notice (keynotice.ts).
    if (why) {
      noteRateLimit(Date.now(), tenant);
      if (lastError !== "overloaded") reportKeyProblem("refused"); // (an overloaded API is not the key's fault)
      return new TenantKeyError(why);
    }
    return new Error(`agent turn ended with ${subtype}${lastError ? ` (${lastError})` : ""}`);
  }
  if (lastError === "authentication_failed") return new AuthError("authentication_failed");
  if (lastError === "rate_limit") return noteRateLimit(), new RateLimitError("rate_limit"); // also starts the shared cooldown of background jobs (cooldown.ts)
  return new Error(`agent turn ended with ${subtype}${lastError ? ` (${lastError})` : ""}`);
}
