// A conversation (the owner's chat, or a group) persists across restarts and days; time alone never resets it, so Ted always has
// the recent history. Two things keep it healthy:
//   - when its context grew large it is compacted early, because the SDK only auto-compacts near the context
//     limit and every turn re-sends the whole history: in the background once the conversation has been quiet
//     for a while, or right after a reply if it grew far past the limit.
// The decision is a pure function so the boundaries are unit-tested.


export interface ChatSession {
  sessionId?: string;
  costUsd: number; // total_cost_usd is cumulative across a resumed session, so we keep the running total
  lastTurnAt?: string; // ISO time the last chat turn finished
  lastContextTokens?: number; // context size of that turn (input + cached input of its last model call)
  compactFailedAt?: string; // ISO time of the last failed compaction: back off instead of retrying every turn
  baseTokens?: number; // context size of the session's first turn: tools, skills and prompts, before any conversation. Compaction counts growth from here
  seenAt?: string; // groups: the newest log line the session has been shown (group lines nobody answered are prepended after it)
  untrustedIn?: string; // the id of the session that has read raw mail or a web page ("pending": the session this turn starts, whose id is not known yet): its context still holds that text, so the approval judge is told from then on (chatsession.ts sessionTaint)
}

// After a failed compaction there is no new try for this long.
const COMPACT_BACKOFF_MS = 60 * 60_000;

type SessionPlan = "fresh" | "resume" | "resume then compact";

// When a compaction runs. "urgent": right after a reply, only for a conversation that grew far past the limit (a long active
// chat must not run into the model's context window). "quiet": from the heartbeat, once nobody has written for a while, so
// nobody waits for it. "off": the caller only wants to know fresh or resume.
export type CompactMode = "off" | "quiet" | "urgent";
export const URGENT_FACTOR = 1.5;

export interface PlanOpts {
  compactTokens: number;
  compactGrowth: number;
  quietMinutes?: number; // "quiet": the last turn must be at least this old
  mode?: CompactMode; // default "quiet"
}

// Missing fields (a session.json from before these rules) never trigger anything: resume.
// The compaction point is the same idea for the owner and every group: the conversation itself (growth since the first turn) has
// outgrown `compactGrowth`. The owner's tools and skills alone are ~50k and a group's ~10k, so one absolute number would mean
// very different amounts of conversation; `compactTokens` is only the fallback for a session saved before baseTokens existed.
export function planSession(s: ChatSession, now: Date, opts: PlanOpts): SessionPlan {
  if (!s.sessionId) return "fresh";
  const last = s.lastTurnAt ? Date.parse(s.lastTurnAt) : NaN;
  const mode = opts.mode ?? "quiet";
  if (mode === "off") return "resume";
  const factor = mode === "urgent" ? URGENT_FACTOR : 1;
  const limit = typeof s.baseTokens === "number" ? s.baseTokens + opts.compactGrowth * factor : opts.compactTokens * factor;
  if (typeof s.lastContextTokens === "number" && s.lastContextTokens > limit) {
    if (mode === "quiet" && (!Number.isFinite(last) || now.getTime() - last < (opts.quietMinutes ?? 0) * 60_000)) return "resume"; // still talking: not now
    const failed = s.compactFailedAt ? Date.parse(s.compactFailedAt) : NaN;
    if (Number.isFinite(failed) && now.getTime() - failed < COMPACT_BACKOFF_MS) return "resume"; // it just failed; do not pay for another try yet
    return "resume then compact";
  }
  return "resume";
}
