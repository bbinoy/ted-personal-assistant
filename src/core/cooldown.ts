import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// One shared cooldown for the plan's usage limit. When any model call is refused with a rate limit (errors.ts `failure`),
// the time is remembered; background jobs (the clock look, wake-up runs, the brief and radar, quiet compaction, mail
// triage, the dream, log summaries, notice writing) then skip their model call instead of failing against the API every
// tick. The owner's chat and group turns never check it: the limit may be back, and they have their own notice.
// The reset time is the SDK's own (rate_limit_event, status rejected) when it gave one, else a backoff of 15 minutes that
// doubles per consecutive refusal up to 2 hours. A successful call clears everything. Per process; a restart forgets it
// (one probing call is the cost).
// The cooldown is a state per payer (payer.ts cooldownKeyOf): the default key ("") is the instance's own login (the owner's and the groups'), and the instance key
// that friends run on (INSTANCE_KEY_COOLDOWN) has one of its own: its limit, an invalid key or an empty balance is the KEY's, so it pauses every friend and never the owner.

export const BASE_BACKOFF_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 2 * 3600_000;
const MAX_RESET_AHEAD_MS = 12 * 3600_000; // a reset further away than this is not believed
const RESET_SLACK_MS = 30_000;

interface State {
  until: number; // epoch ms; 0: no cooldown
  failures: number; // consecutive refusals in this episode
  announced: boolean; // the one log line of this episode
  knownReset?: number; // from the SDK, waiting for the failure that uses it
}
const states = new Map<string, State>();
const stateOf = (key: string): State => {
  let st = states.get(key);
  if (!st) states.set(key, (st = { until: 0, failures: 0, announced: false }));
  return st;
};

// Feed every message of a stream here: remembers the reset time of a rejected limit.
export function observeRateLimit(m: { type: string; rate_limit_info?: { status?: string; resetsAt?: number } } | SDKMessage, key = ""): void {
  const info = m.type === "rate_limit_event" ? (m as { rate_limit_info?: { status?: string; resetsAt?: number } }).rate_limit_info : undefined;
  if (info?.status === "rejected" && typeof info.resetsAt === "number") stateOf(key).knownReset = info.resetsAt * 1000;
}

export function noteRateLimit(now: number = Date.now(), key = ""): void {
  const st = stateOf(key);
  st.failures++;
  const reset = st.knownReset !== undefined && st.knownReset > now && st.knownReset - now <= MAX_RESET_AHEAD_MS ? st.knownReset + RESET_SLACK_MS : undefined;
  st.knownReset = undefined;
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (st.failures - 1));
  st.until = Math.max(st.until, reset ?? now + backoff);
}

// A call went through: the limit is over.
export function noteSuccess(key = ""): void {
  const st = states.get(key);
  if (!st) return;
  if (st.until && st.announced) console.log(key ? "cooldown: model calls work again for a tenant" : "cooldown: model calls work again, background jobs resume");
  if (key) states.delete(key);
  else Object.assign(st, { until: 0, failures: 0, announced: false, knownReset: undefined });
}

export const coolingDown = (now: number = Date.now(), key = ""): boolean => now < (states.get(key)?.until ?? 0);

// When the cooldown ends (epoch ms), or undefined when there is none (doctor, a tenant's notice).
export const cooldownUntil = (key = "", now: number = Date.now()): number | undefined => {
  const u = states.get(key)?.until ?? 0;
  return u > now ? u : undefined;
};

// For background jobs: true means skip the model call. Logs once per episode, not per tick.
export function skipForCooldown(what: string, now: number = Date.now()): boolean {
  if (!coolingDown(now)) return false;
  const st = stateOf("");
  if (!st.announced) {
    st.announced = true;
    console.log(`cooldown: usage limit, background model calls paused until ${new Date(st.until).toTimeString().slice(0, 5)} (first skipped: ${what})`);
  }
  return true;
}

// No key: every cooldown (tests). A key: that one's.
export function resetCooldown(key?: string): void {
  if (key === undefined) return void states.clear();
  states.delete(key);
}
