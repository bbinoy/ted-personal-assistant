import { overBudget } from "../core/budget.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { owner } from "../conversation/conversationmodel.ts";
import { settings } from "../core/settings.ts";
import { ledgerEntries } from "../core/messages.ts";
import { readJson, writeJson } from "../core/state.ts";
import { dayIn, inQuietHours, timeIn } from "../core/timezone.ts";
import { causeOf, FIXES, type Cause } from "../tenants/errors.ts";
import { isQuiet, siblingFile } from "../conversation/quiet.ts";
import { askLines, type LineWriter } from "./digestlines.ts";
import { digestDue, digestText, oneLine, planDigest } from "./digest.ts";
import { zoneOf } from "../tenants/tenants.ts";

// What the owner is TOLD when things go wrong or go quiet, and what code keeps back from her at night. Three small, separate mechanisms, all pure planners over a little state:
//   1. the budget notice: the day's budget is spent and background work stops until midnight. Said ONCE a day (budget.ts overBudget), in the owner's chat; in a group once per group per day
//      and only when someone addressed it.
//   2. the failure notice: looks that fail on and on (3 in a row, or failures for an hour) are said ONCE per incident with the cause class and the fix, and "back to normal" when one works.
//      The owner's own and a group's look are told as such; friends' only as a count (no names, no words of theirs).
//   3. quiet hours, /quiet and the day's cap, in code: an unprompted heartbeat post inside the quiet window (or while the conversation's own /quiet is on), or past MAX_UNPROMPTED_PER_DAY,
//      is HELD (state, per conversation) and goes out as ONE curated digest (digest.ts: grouped needs you / FYI / system, deduplicated, newest first, capped) when quiet ends, and at the
//      DIGEST_TIMES slots for what the cap held. The run marks a post `urgent` (rules.ts) only when it is time-critical: that is exempt from all of it.
// The system notices of 1 and 2 respect the quiet window too (held, then delivered with the rest), and are exempt from the cap. Every failure notice ENDS with the one step to take (errors.ts FIXES).

// ---- the pure planners ----

export type Plan = "post" | "hold-quiet" | "hold-cap";

// Urgent posts always go. Otherwise the quiet window holds, then the day's cap (a quiet-hours post is held even if the cap is also spent: it is delivered in the morning, within the cap).
export function planPost(i: { urgent: boolean; night: boolean; posted: number; cap: number }): Plan {
  if (i.urgent) return "post";
  if (i.night) return "hold-quiet";
  return i.posted >= i.cap ? "hold-cap" : "post";
}

// Is it time to deliver what was held? Outside the quiet window and with the cap not yet spent today (a cap-held post therefore waits for the next day).
export const planFlush = (i: { night: boolean; posted: number; cap: number; held: number }): boolean => i.held > 0 && !i.night && i.posted < i.cap;

export interface Held {
  text: string;
  why: "quiet" | "cap";
  notice?: boolean; // a system notice (exempt from the cap)
  needsYou?: boolean; // the look said this post asks something of the owner (digest.ts kindOfItem)
  at?: number; // when it was held (epoch ms); older rows have none and are kept as they were
  day?: string; // the conversation's day it was held on
  sameDay?: boolean; // true only for the day it was written (the budget notice: "paused until midnight" is false the next morning)
}

const STALE_MS = 36 * 3_600_000; // nothing held is delivered after this: it is no longer news

// Pure: what of the held items is still true at `now`? A same-day notice from an earlier day is dropped; a held POST is dropped if someone wrote in the conversation after it was
// held (`wroteAt`: the times of what people wrote, epoch ms; the owner has moved on and the post may contradict it); anything older than 36 hours is dropped.
export function stillTrue(held: readonly Held[], now: number, today: string, wroteAt: readonly number[]): Held[] {
  return held.filter((h) => {
    if (h.at === undefined) return true;
    if (now - h.at > STALE_MS) return false;
    if (h.sameDay && h.day !== today) return false;
    if (!h.notice && wroteAt.some((t) => t > h.at!)) return false;
    return true;
  });
}

// The one message that holds everything, as the digest the owner gets (digest.ts): a single item as it is, several grouped, deduplicated, newest first and capped.
export const combine = (held: readonly Held[]): string => digestText(planDigest(held, settings.digestMaxItems));

// ---- the failure tracker ----

export type Scope = "owner" | "group" | "tenant";
const HOUR = 3_600_000;
interface Streak {
  n: number;
  since: number;
  told: boolean;
  scope: Scope;
}

export interface FailureTracker {
  // One finished look of a conversation. Returns the notices to send now (none, one, or the "back to normal").
  observe(key: string, scope: Scope, failed: boolean, cause: Cause | undefined, now: number, zone?: string): string[];
}

export function createFailureTracker(o: { count?: number; windowMs?: number } = {}): FailureTracker {
  const count = o.count ?? 3;
  const window = o.windowMs ?? HOUR;
  const streaks = new Map<string, Streak>();
  const toldFriends = () => [...streaks.values()].filter((s) => s.scope === "tenant" && s.told).length;
  return {
    observe(key, scope, failed, cause, now, zone) {
      const s = streaks.get(key);
      if (!failed) {
        streaks.delete(key);
        if (!s?.told) return [];
        if (scope === "tenant") return toldFriends() === 0 ? ["Background work for friends is back to normal."] : [];
        return [scope === "owner" ? "My background checks work again." : "My background checks in one of your groups work again."];
      }
      const st = s ?? { n: 0, since: now, told: false, scope };
      streaks.set(key, st);
      st.n++;
      if (st.told || !(st.n >= count || (st.n >= 2 && now - st.since >= window))) return [];
      const first = scope !== "tenant" || toldFriends() === 0; // friends: one notice for all of them while the incident lasts
      st.told = true;
      if (!first) return [];
      const c = FIXES[cause ?? "other"];
      const when = timeIn(new Date(st.since), zone);
      if (scope === "tenant") return [`Background work for ${[...streaks.values()].filter((x) => x.scope === "tenant" && x.n > 0).length} friend(s) keeps failing (since ${when}): ${c.what}. ${c.fix}`];
      return [`My background checks${scope === "group" ? " in one of your groups" : ""} have failed ${st.n} times in a row (since ${when}): ${c.what}. ${c.fix}`];
    },
  };
}

// ---- the state: one small file per conversation ----

interface HoldState {
  day: string; // the conversation's own day the count belongs to
  posted: number; // unprompted posts so far that day (urgent and system notices not counted)
  held: Held[];
}

// Next to the conversation's other bookkeeping, like seen-mail.json (seenmail.ts).
export const heldFileOf = (conv: Pick<Conversation, "tenantId" | "kind" | "sessionFile">): string => siblingFile(conv, "held-posts.json");

const MAX_HELD = 30; // a flood is dropped oldest first: this is a morning digest, not an archive
function load(conv: Conversation, now: Date, zone: string): HoldState {
  const raw = readJson<Partial<HoldState>>(heldFileOf(conv), {});
  const day = dayIn(now, zone);
  return { day, posted: raw.day === day && typeof raw.posted === "number" ? raw.posted : 0, held: Array.isArray(raw.held) ? raw.held.filter((h): h is Held => !!h && typeof h.text === "string") : [] };
}
const save = (conv: Conversation, st: HoldState): void => writeJson(heldFileOf(conv), { ...st, held: st.held.slice(-MAX_HELD) });
const zoneFor = (conv: Conversation): string => zoneOf(conv);
const isNight = (now: Date, zone: string): boolean => inQuietHours(now, settings.quietStartHour, settings.quietEndHour, zone);
// Is this conversation being left alone right now: the quiet window, or its own /quiet (conversation/quiet.ts)?
const holding = (conv: Conversation, now: Date, zone: string): boolean => isNight(now, zone) || isQuiet(conv, now);

// A heartbeat post that is about to go out unprompted. "post": go ahead (counted); "held": kept for later (the caller says nothing, the conversation's log notes it).
export function submitPost(conv: Conversation, text: string, urgent: boolean, now: Date, needsYou?: boolean): "post" | "held" {
  const zone = zoneFor(conv);
  const st = load(conv, now, zone);
  const plan = planPost({ urgent, night: holding(conv, now, zone), posted: st.posted, cap: settings.maxUnpromptedPerDay });
  if (plan === "post") {
    if (!urgent) st.posted++;
    save(conv, st);
    return "post";
  }
  if (!st.held.some((h) => h.text === text)) st.held.push({ text, why: plan === "hold-quiet" ? "quiet" : "cap", at: now.getTime(), day: st.day, ...(typeof needsYou === "boolean" ? { needsYou } : {}) });
  save(conv, st);
  return "held";
}

// Pieces the run sent with the send tool while it worked count toward the day's cap (they are not held: they are out).
export function countPosts(conv: Conversation, n: number, now: Date): void {
  if (n <= 0) return;
  const st = load(conv, now, zoneFor(conv));
  st.posted += n;
  save(conv, st);
}

// Deliver a notice-kind message in the conversation, the way the heartbeat does (look.ts): in its queue, logged as a notice, not a chat turn.
export const postNotice = (pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, text: string, costUsd?: number) =>
  pipeline.enqueue(conv, async () => pipeline.runTurn(conv, { run: async () => ({ text, costUsd }), background: true, announce: false, kind: "notice" })).catch((e) => ({ error: e as unknown, spoke: false }));

// On every tick: if quiet is over (the window, or /quiet) and something is held, or a digest slot has passed for what the cap held, post it as ONE digest (digest.ts). Kept if the post fails.
// `lines`: the optional model that shortens the owner's items (digestlines.ts; the code's own lines when it is absent, fails, times out or answers wrongly). Returns whether it posted.
export async function releaseHeld(pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, now: Date, o: { lines?: LineWriter } = {}): Promise<boolean> {
  const first = readJson<Partial<HoldState>>(heldFileOf(conv), {});
  if (!Array.isArray(first.held) || first.held.length === 0) return false; // the usual tick: one small read, nothing more
  const zone = zoneFor(conv);
  const st = load(conv, now, zone);
  const wrote = ledgerEntries(conv.logFile).filter((e) => e.kind === "owner" || e.kind === "member" || e.kind === "edit").map((e) => Date.parse(e.at));
  const keep = stillTrue(st.held, now.getTime(), st.day, wrote);
  if (keep.length !== st.held.length) {
    st.held = keep; // what is no longer true is dropped, not delivered
    save(conv, st);
  }
  if (!planFlush({ night: holding(conv, now, zone), posted: st.posted, cap: settings.maxUnpromptedPerDay, held: st.held.length })) return false;
  if (!digestDue({ held: st.held, now: now.getTime(), zone, slots: settings.digestMinutes })) return false;
  const batch = st.held.slice();
  const plan = planDigest(batch, settings.digestMaxItems);
  const shown = plan.groups.flatMap((g) => g.items);
  let lines: string[] | undefined;
  const write = o.lines ?? (settings.digestSummarize && conv.kind === "owner" ? askLines : undefined); // (the model reads the owner's items only: a friend's run is paid by the shared key)
  if (write && shown.length > 1) lines = await write(shown.map((h) => h.text)).catch(() => undefined); // (a failed or slow model is just the code's lines)
  const text = digestText(plan, (h) => lines?.[shown.indexOf(h)] ?? oneLine(h.text));
  const res = await postNotice(pipeline, conv, text);
  if (res.error) return false;
  const now2 = load(conv, now, zone); // (re-read: a look may have held more meanwhile)
  now2.held = now2.held.filter((h) => !batch.some((b) => b.text === h.text));
  now2.posted++;
  save(conv, now2);
  return true;
}

// ---- the owner's notices ----

let send: ((text: string) => void) | undefined;
export const ownerNotices = {
  sendTo: (fn: ((text: string) => void) | undefined): void => void (send = fn), // main.ts: the owner's chat
};

// A system notice for the owner: now, or held until the quiet window (or /quiet) ends, then in the digest. `urgent` goes at once. Never throws.
export function noticeOwner(text: string, now: Date = new Date(), o: { sameDay?: boolean; urgent?: boolean } = {}): void {
  try {
    const conv = owner();
    const zone = zoneFor(conv);
    if (!o.urgent && holding(conv, now, zone)) {
      const st = load(conv, now, zone);
      if (!st.held.some((h) => h.text === text)) st.held.push({ text, why: "quiet", notice: true, at: now.getTime(), day: st.day, sameDay: o.sameDay });
      return save(conv, st);
    }
    send?.(text);
  } catch (e) {
    console.error("notices: could not tell the owner:", (e as Error).message);
  }
}

// 1. The budget: once a day, from the tick (wake.ts), when the day's spend has reached the ceiling.
export const budgetText = (): string => `Daily budget of $${settings.dailyBudgetUsd} reached, background work paused until midnight. To lift it today, raise DAILY_BUDGET_USD in .env and restart.`;
export function noticeBudget(now: Date = new Date()): boolean {
  const b = overBudget(); // (the only caller: asking elsewhere never uses up the day's one notice)
  if (b.firstTime) noticeOwner(budgetText(), now, { sameDay: true });
  return b.firstTime;
}

// 2. Looks that fail on and on. Called by look.ts with each finished look; `error` is what the run threw, if it did.
const tracker = createFailureTracker();
export function observeLook(conv: Conversation, outcome: "posted" | "silent" | "failed", error: unknown, now: Date): void {
  try {
    const scope: Scope = conv.kind === "tenant" ? "tenant" : conv.kind === "group" ? "group" : "owner";
    for (const text of tracker.observe(conv.key, scope, outcome === "failed", outcome === "failed" ? causeOf(error) : undefined, now.getTime(), zoneFor(conv))) noticeOwner(text, now);
  } catch (e) {
    console.error("notices: could not track a look:", (e as Error).message);
  }
}
