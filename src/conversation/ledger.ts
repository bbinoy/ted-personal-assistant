import { readdirSync, statSync } from "node:fs";
import type { Conversation } from "./conversation.ts";
import { ledgerEntries, parseWake, recordMessage, type Kind, type Sent, type Wake } from "../core/messages.ts";
import { convIdOfKey, convPaths } from "../core/convpaths.ts";
import { LIMITS, oneLine } from "../core/sanitize.ts";

// The wake/action ledger: the conversation's own log (messages.ts) holds kind "wake" lines (the chosen next look, the last
// one is the state) and kind "action" lines (something done without posting). Everything
// the gate and the clock side (wake.ts) know about "what happened so far" is read back from here, in code.

export const MIN_CHECK_MINUTES = 15;
export const MAX_CHECK_MINUTES = 60;
export const DEFAULT_CHECK_MINUTES = 30; // when the model gave nothing usable

const QUIET_MINUTES = 3; // a look that a message called off is retried once the conversation has been this quiet (the tick, a few minutes, is the granularity)

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
  // A look a message called off: due once nobody has written for QUIET_MINUTES (a turn still running is the caller's `busy`). This is code's own schedule, so it does not go through the 10..60 clamp; `next` is not used.
  if (st.wake.quiet) {
    const since = Math.max(Date.parse(st.wake.at), st.lastInboundAt ? Date.parse(st.lastInboundAt) : 0);
    return now.getTime() - since >= QUIET_MINUTES * 60_000 ? "Your last check was called off by a message; the conversation is quiet now." : undefined;
  }
  if (now.getTime() >= Date.parse(st.wake.next)) return st.wake.why ? `You asked to check again: ${st.wake.why}` : "The time you chose for this check has come.";
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

// `clamp`: the gate's 15..60 minutes by default; the owner's heartbeat run chooses 10..60 (heartbeat/rules.ts clampLook).
export const wakeText = (nextCheckMinutes: number, looked: Date, now = Date.now(), clamp: (minutes: unknown) => number = clampCheck): string =>
  JSON.stringify({ next: new Date(now + clamp(nextCheckMinutes) * 60_000).toISOString(), looked: looked.toISOString() } satisfies Wake);

// The chosen next look goes into the conversation's log: the last "wake" line is the state.
export const recordWake = (pipeline: { record: (conv: Conversation, kind: Kind, ts: number, text: string) => void }, conv: Conversation, nextCheckMinutes: number, looked: Date, clamp?: (minutes: unknown) => number): void =>
  pipeline.record(conv, "wake", Date.now(), wakeText(nextCheckMinutes, looked, looked.getTime(), clamp)); // counted from the look, not from when the run ended

// The same, after the act or the gate: a pulled check (check_again, it has a `why`) that is earlier than the time chosen now stands, so a later choice never postpones it.
export const recordWakeKeepingPull = (pipeline: { record: (conv: Conversation, kind: Kind, ts: number, text: string) => void }, conv: Conversation, nextCheckMinutes: number, looked: Date, clamp?: (minutes: unknown) => number): void => {
  const w = lookState(ledgerEntries(convPaths(convIdOfKey(conv.key)).messages)).wake;
  if (!(w?.why && Date.parse(w.next) < Date.parse(JSON.parse(wakeText(nextCheckMinutes, looked, looked.getTime(), clamp)).next))) recordWake(pipeline, conv, nextCheckMinutes, looked, clamp);
};

// A look a message called off: it is due again as soon as the conversation has been quiet (lookWhy), not at the normal rhythm.
export const recordCalledOff = (pipeline: { record: (conv: Conversation, kind: Kind, ts: number, text: string) => void }, conv: Conversation, looked: Date): void =>
  pipeline.record(conv, "wake", Date.now(), JSON.stringify({ next: looked.toISOString(), looked: looked.toISOString(), quiet: true } satisfies Wake));

// ---- check_again: any run pulls the conversation's next look forward ----

const PULL_MIN_MINUTES = 2;
const PULL_MAX_MINUTES = 120; // the look's own longest wait
const PULLS_PER_HOUR = 4;

// Books the next look at now+minutes with the reason, only when that is earlier than the booked one (it never postpones). Returns what the model is told.
export function pullLook(key: string, minutes: number, why: string, now = new Date()): string {
  const file = convPaths(convIdOfKey(key)).messages;
  const entries = ledgerEntries(file);
  const hourAgo = now.getTime() - 3_600_000;
  if (entries.filter((e) => e.kind === "wake" && parseWake(e.text)?.why && Date.parse(e.at) > hourAgo).length >= PULLS_PER_HOUR)
    return `Not booked: you already pulled the check forward ${PULLS_PER_HOUR} times in the last hour. Do the work in this run or leave it to the next check.`;
  const m = Math.max(PULL_MIN_MINUTES, Math.min(PULL_MAX_MINUTES, Math.round(Number.isFinite(minutes) ? minutes : PULL_MAX_MINUTES)));
  const st = lookState(entries);
  const next = new Date(now.getTime() + m * 60_000);
  if (st.wake && (st.wake.quiet || Date.parse(st.wake.next) <= next.getTime())) return "No change: the next check is already due sooner than that.";
  const w: Wake = { next: next.toISOString(), looked: st.wake?.looked ?? now.toISOString(), why: oneLine("check_again why", why, LIMITS.gist) };
  recordMessage("wake", now.getTime(), JSON.stringify(w), now, file);
  return `Booked: the next check is in ${m} minutes, with your reason.`;
}
