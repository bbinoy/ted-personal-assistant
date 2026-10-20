import { readdirSync, statSync } from "node:fs";
import type { Conversation } from "./conversation.ts";
import type { Kind, Sent } from "./messages.ts";
import { localDay } from "./pause.ts";

// The wake/action ledger: the conversation's own log (messages.ts) holds kind "wake" lines (the chosen next look, the last
// one is the state) and kind "action" lines (something done without posting; the presets' progress, see below). Everything
// the gate and the clock side (wake.ts) know about "what happened so far" is read back from here, in code.

export const MIN_CHECK_MINUTES = 15;
export const MAX_CHECK_MINUTES = 60;
export const DEFAULT_CHECK_MINUTES = 30; // when the model gave nothing usable

export const clampCheck = (minutes: unknown): number => {
  const n = Number(minutes);
  return Number.isFinite(n) ? Math.max(MIN_CHECK_MINUTES, Math.min(MAX_CHECK_MINUTES, Math.round(n))) : DEFAULT_CHECK_MINUTES;
};

interface Wake {
  next: string; // ISO: the next look
  looked: string; // ISO: when the look that chose it began (anything said after it is news)
}
export function parseWake(text: string): Wake | undefined {
  try {
    const w = JSON.parse(text) as Partial<Wake>;
    return typeof w.next === "string" && Number.isFinite(Date.parse(w.next)) && typeof w.looked === "string" && Number.isFinite(Date.parse(w.looked)) ? { next: w.next, looked: w.looked } : undefined;
  } catch {
    return undefined;
  }
}


// ---- the ledger ----

// What the presets (tasks.ts) write into the owner's log as kind "action". The gate reads them back as the ledger: they
// are how it sees when each job last ran, and code derives the attempt count and the dedupe keys from them.
export const ledger = {
  briefStarted: (n: number) => `[brief] attempt ${n} started`,
  briefEnded: (n: number, outcome: string) => `[brief] attempt ${n} → ${outcome}`,
};

export interface LookState {
  wake?: Wake & { at: string }; // the last chosen next look (at: when it was written)
  lastInboundAt?: string; // the newest thing someone ELSE said or reacted
  briefAttempts: number; // brief attempts started today
  lastBriefAttemptAt?: string;
  briefDone: boolean; // a brief was delivered or posted today
}

const INBOUND: ReadonlySet<Kind> = new Set<Kind>(["owner", "member", "reaction"]);

// Pure: what the ledger says about this conversation.
export function lookState(entries: readonly Sent[], now: Date): LookState {
  const today = localDay(now);
  const st: LookState = { briefAttempts: 0, briefDone: false };
  for (const e of entries) {
    const isToday = localDay(new Date(e.at)) === today;
    if (e.kind === "wake") {
      const w = parseWake(e.text);
      if (w) st.wake = { ...w, at: e.at };
    } else if (e.kind === "brief" && isToday) st.briefDone = true;
    else if (e.kind === "action") {
      if (isToday && /^\[brief\] attempt \d+ started/.test(e.text)) (st.briefAttempts++, (st.lastBriefAttemptAt = e.at));
      else if (isToday && /^\[brief\] attempt \d+ → delivered/.test(e.text)) st.briefDone = true;
    } else if (INBOUND.has(e.kind) && (!st.lastInboundAt || e.at > st.lastInboundAt)) st.lastInboundAt = e.at;
  }
  return st;
}

// Pure: is this conversation's look due? Yes when the chosen time has come, when somebody wrote since the last look
// (not in a group set to "tagged": there only a tag matters), or when its notes changed since. No look yet: due.
export function lookDue(st: LookState, now: Date, o: { notesChangedMs?: number; messagesCount?: boolean } = {}): boolean {
  if (!st.wake) return true;
  if (now.getTime() >= Date.parse(st.wake.next)) return true;
  if (o.messagesCount !== false && st.lastInboundAt && st.lastInboundAt > st.wake.looked) return true;
  return !!o.notesChangedMs && o.notesChangedMs > Date.parse(st.wake.at);
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
