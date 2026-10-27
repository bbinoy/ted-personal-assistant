import { takeCapNotice } from "../core/capnotice.ts";
import { holdFact } from "../core/ownerfact.ts";
import { settings } from "../core/settings.ts";

// ONE place that tells the owner about a problem with the shared instance key (TENANT_ANTHROPIC_API_KEY) that every friend's run depends on. It is called from where
// a friend's run FAILS because of the key: errors.ts `failure`, which every model call on the key goes through, whatever started it (her chat turn, the heartbeat, a
// wake-up, the dream, the mail loops and the mail handler, the idle look, the compaction), and from where a run cannot start at all for want of a key (payer.ts).
// So there is no per-source branch: a source that fails the same way is reported the same way.
//
// It is a FACT for the owner's next run (core/ownerfact.ts), which says it in its own words, at most once per problem per TENANT_KEY_NOTICE_MINUTES (default three hours), however
// many friends and runs run into it. It holds no word of any friend, no name and no key.

export type KeyProblem = "refused" | "missing";

export const KEY_FACTS: Readonly<Record<KeyProblem, string>> = {
  // (each ends with the one step: the exact setting; the same fix as errors.ts FIXES.refused)
  refused: "The shared API key was refused (expired, over its limit or out of credit), so friends' chats and their background work fail until it is fixed: check TENANT_ANTHROPIC_API_KEY in .env, then restart.",
  missing: "TENANT_ANTHROPIC_API_KEY is not set, so friends cannot be answered and their background work does not run. Set it in .env (a separate Console workspace key with a spend limit) and restart.",
};

// Records the problem; hands the fact over if none of this kind went out within the interval. Returns whether it did. Never throws.
export function reportKeyProblem(problem: KeyProblem, now = Date.now()): boolean {
  if (!takeCapNotice(`key:${problem}`, now, settings.tenantKeyNoticeMinutes * 60_000)) return false;
  holdFact(KEY_FACTS[problem], new Date(now));
  return true;
}
