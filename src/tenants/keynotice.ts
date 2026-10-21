import { clearNoticeAt, lastNoticeAt, markNoticeAt } from "../core/capnotice.ts";
import { settings } from "../core/settings.ts";

// ONE place that tells the owner about a problem with the shared instance key (TENANT_ANTHROPIC_API_KEY) that every friend's run depends on. It is called from where
// a friend's run FAILS because of the key: errors.ts `failure`, which every model call on the key goes through, whatever started it (her chat turn, the heartbeat, a
// wake-up, the dream, the mail loops and the mail handler, the idle look, the compaction), and from where a run cannot start at all for want of a key (tenantrun.ts).
// So there is no per-source branch: a source that fails the same way is reported the same way.
//
// The notice goes to the owner's own chat (main.ts sends it there), at most once per problem per TENANT_KEY_NOTICE_MINUTES (default three hours), however many friends
// and runs run into it, and it holds no word of any friend, no name and no key: a fixed sentence.

export type KeyProblem = "refused" | "missing";

const TEXT: Readonly<Record<KeyProblem, string>> = {
  // (each ends with the one step: the exact setting; the same fix as errors.ts FIXES.refused)
  refused: "The shared API key was refused (expired, over its limit or out of credit), so friends' chats and their background work fail until it is fixed: check TENANT_ANTHROPIC_API_KEY in .env, then restart.",
  missing: "TENANT_ANTHROPIC_API_KEY is not set, so friends cannot be answered and their background work does not run. Set it in .env (a separate Console workspace key with a spend limit) and restart.",
};

export interface KeyNotices {
  // Records the problem; sends the notice if none of this kind went out within the interval. Returns whether it sent one. Never throws.
  report(problem: KeyProblem, now?: number): boolean;
  sendTo(send: ((text: string) => void) | undefined): void; // main.ts: the owner's chat
  reset(): void;
}

// `persist`: the time of the last notice is kept in state/cap-notices.json (capnotice.ts), so a restart does not repeat it; the shared instance is the persistent one.
export function createKeyNotices(o: { everyMs?: () => number; persist?: boolean } = {}): KeyNotices {
  const every = o.everyMs ?? (() => settings.tenantKeyNoticeMinutes * 60_000);
  const last = new Map<KeyProblem, number>();
  let send: ((text: string) => void) | undefined;
  return {
    report(problem, now = Date.now()) {
      const at = last.get(problem) ?? (o.persist ? lastNoticeAt(`key:${problem}`) : undefined);
      if (at !== undefined && now - at < every()) return false;
      last.set(problem, now);
      if (o.persist) markNoticeAt(`key:${problem}`, now);
      try {
        send?.(TEXT[problem]);
      } catch {
        /* a notice that cannot be sent is not a reason to fail a run */
      }
      return !!send;
    },
    sendTo: (s) => void (send = s),
    reset: () => void (last.clear(), o.persist && clearNoticeAt("key:")),
  };
}

export const keyNotices = createKeyNotices({ persist: true });
export const reportKeyProblem = (problem: KeyProblem, now?: number): boolean => keyNotices.report(problem, now);
