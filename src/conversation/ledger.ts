import { readdirSync, statSync } from "node:fs";
import type { Conversation } from "./conversation.ts";
import { parseWake, type Kind, type Sent, type Wake } from "../core/messages.ts";

// The wake/action ledger: the conversation's own log (messages.ts) holds kind "wake" lines (the chosen next look, the last
// one is the state) and kind "action" lines (something done without posting). Everything
// the gate and the clock side (wake.ts) know about "what happened so far" is read back from here, in code.

export const MIN_CHECK_MINUTES = 15;
export const MAX_CHECK_MINUTES = 60;
export const DEFAULT_CHECK_MINUTES = 30; // when the model gave nothing usable

export const clampCheck = (minutes: unknown): number => {
  const n = Number(minutes);
  return Number.isFinite(n) ? Math.max(MIN_CHECK_MINUTES, Math.min(MAX_CHECK_MINUTES, Math.round(n))) : DEFAULT_CHECK_MINUTES;
};


// ---- the ledger ----

export interface LookState {
  wake?: Wake & { at: string }; // the last chosen next look (at: when it was written)
  lastInboundAt?: string; // the newest thing someone ELSE said or reacted
}

const INBOUND: ReadonlySet<Kind> = new Set<Kind>(["owner", "member", "reaction"]);

// Pure: what the ledger says about this conversation.
export function lookState(entries: readonly Sent[]): LookState {
  const st: LookState = {};
  for (const e of entries) {
    if (e.kind === "wake") {
      const w = parseWake(e.text);
      if (w) st.wake = { ...w, at: e.at };
    } else if (INBOUND.has(e.kind) && (!st.lastInboundAt || e.at > st.lastInboundAt)) st.lastInboundAt = e.at;
  }
  return st;
}

// Pure: why this conversation's look is due, as a short fact for the look's message (undefined: not due). Due when the chosen time has come, when somebody wrote since
// the last look (not in a group set to "tagged": there only a tag matters), or when its notes changed since. No look yet: due.
export function lookWhy(st: LookState, now: Date, o: { notesChangedMs?: number; messagesCount?: boolean } = {}): string | undefined {
  if (!st.wake) return "No check has run yet.";
  if (now.getTime() >= Date.parse(st.wake.next)) return "The time you chose for this check has come.";
  if (o.messagesCount !== false && st.lastInboundAt && st.lastInboundAt > st.wake.looked) return "Something was written since your last check.";
  return o.notesChangedMs && o.notesChangedMs > Date.parse(st.wake.at) ? "Your notes changed since your last check." : undefined;
}

// The newest change in a notes folder, in epoch ms (0: none).
export function notesChangedAt(dir: string): number {
  try {
    return Math.max(0, ...readdirSync(dir).map((f) => statSync(`${dir}/${f}`).mtimeMs));
  } catch {
    return 0;
  }
}

// `clamp`: the gate's 15..60 minutes by default; the owner's heartbeat run chooses 10..120 (heartbeat/rules.ts clampLook).
export const wakeText = (nextCheckMinutes: number, looked: Date, now = Date.now(), clamp: (minutes: unknown) => number = clampCheck): string =>
  JSON.stringify({ next: new Date(now + clamp(nextCheckMinutes) * 60_000).toISOString(), looked: looked.toISOString() } satisfies Wake);

// The chosen next look goes into the conversation's log: the last "wake" line is the state.
export const recordWake = (pipeline: { record: (conv: Conversation, kind: Kind, ts: number, text: string) => void }, conv: Conversation, nextCheckMinutes: number, looked: Date, clamp?: (minutes: unknown) => number): void =>
  pipeline.record(conv, "wake", Date.now(), wakeText(nextCheckMinutes, looked, looked.getTime(), clamp)); // counted from the look, not from when the run ended
