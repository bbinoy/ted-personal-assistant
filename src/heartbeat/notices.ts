import { dirname, join } from "node:path";
import { overBudget } from "../core/budget.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { owner } from "../conversation/conversationmodel.ts";
import { settings } from "../core/settings.ts";
import { readJson, writeJson } from "../core/state.ts";
import { dayIn, inQuietHours, timeIn } from "../core/timezone.ts";
import { causeOf, type Cause } from "../tenants/errors.ts";
import { tenantById, tenantContext, zoneOf } from "../tenants/tenants.ts";

// What the owner is TOLD when things go wrong or go quiet, and what code keeps back from her at night. Three small, separate mechanisms, all pure planners over a little state:
//   1. the budget notice: the day's budget is spent and background work stops until midnight. Said ONCE a day (budget.ts overBudget), in the owner's chat; in a group once per group per day
//      and only when someone addressed it.
//   2. the failure notice: looks that fail on and on (3 in a row, or failures for an hour) are said ONCE per incident with the cause class and the fix, and "back to normal" when one works.
//      The owner's own and a group's look are told as such; friends' only as a count (no names, no words of theirs).
//   3. quiet hours and the day's cap, in code: an unprompted heartbeat post inside the quiet window, or past MAX_UNPROMPTED_PER_DAY, is HELD (state, per conversation) and goes out as ONE
//      combined message when the window ends (or the next day, for the cap). The run marks a post `urgent` (rules.ts) only when it is time-critical: that is exempt from both.
// The system notices of 1 and 2 respect the quiet window too (held, then delivered with the rest), and are exempt from the cap.

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
}

// The one message that holds everything: a single item as it is, several as a short list.
export function combine(held: readonly Held[]): string {
  if (held.length === 1) return held[0]!.text;
  return `A few things I held back:\n${held.map((h) => `- ${h.text.replace(/\s*\n\s*/g, " ")}`).join("\n")}`;
}

// ---- the failure tracker ----

export type Scope = "owner" | "group" | "tenant";
const HOUR = 3_600_000;
const FIX: Readonly<Record<Cause, { what: string; fix: string }>> = {
  login: { what: "my Claude login expired", fix: "On the Mac run `claude auth login`." },
  limit: { what: "the plan's usage limit is hit", fix: "It lifts by itself; nothing to do." },
  billing: { what: "the shared API key has no credit left", fix: "Check the account behind TENANT_ANTHROPIC_API_KEY in .env, then restart." },
  refused: { what: "the shared API key was refused", fix: "Check TENANT_ANTHROPIC_API_KEY in .env, then restart." },
  timeout: { what: "the runs are timing out", fix: "Run `npm run doctor`; if it keeps happening, RUN_MAX_MINUTES_BACKGROUND in .env raises the limit." },
  connector: { what: "a connector (Notion, Calendar or Gmail) is not answering", fix: "Run `npm run doctor`, then add the connector again in your Claude account (Settings, Connectors)." },
  other: { what: "the model run keeps failing", fix: "Run `npm run doctor`; the details are in logs/agent.log." },
};

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
      const c = FIX[cause ?? "other"];
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
export const heldFileOf = (conv: Pick<Conversation, "tenantId" | "kind" | "sessionFile">): string => {
  if (conv.kind === "owner") return "state/held-posts.json";
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  return join(rec ? tenantContext(rec).dir : dirname(conv.sessionFile), "held-posts.json");
};

const MAX_HELD = 30; // a flood is dropped oldest first: this is a morning digest, not an archive
function load(conv: Conversation, now: Date, zone: string): HoldState {
  const raw = readJson<Partial<HoldState>>(heldFileOf(conv), {});
  const day = dayIn(now, zone);
  return { day, posted: raw.day === day && typeof raw.posted === "number" ? raw.posted : 0, held: Array.isArray(raw.held) ? raw.held.filter((h): h is Held => !!h && typeof h.text === "string") : [] };
}
const save = (conv: Conversation, st: HoldState): void => writeJson(heldFileOf(conv), { ...st, held: st.held.slice(-MAX_HELD) });
const zoneFor = (conv: Conversation): string => zoneOf(conv);
const isNight = (now: Date, zone: string): boolean => inQuietHours(now, settings.quietStartHour, settings.quietEndHour, zone);

// A heartbeat post that is about to go out unprompted. "post": go ahead (counted); "held": kept for later (the caller says nothing, the conversation's log notes it).
export function submitPost(conv: Conversation, text: string, urgent: boolean, now: Date): "post" | "held" {
  const zone = zoneFor(conv);
  const st = load(conv, now, zone);
  const plan = planPost({ urgent, night: isNight(now, zone), posted: st.posted, cap: settings.maxUnpromptedPerDay });
  if (plan === "post") {
    if (!urgent) st.posted++;
    save(conv, st);
    return "post";
  }
  if (!st.held.some((h) => h.text === text)) st.held.push({ text, why: plan === "hold-quiet" ? "quiet" : "cap" });
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

// On every tick: if the quiet window is over (or the day turned, for the cap) and something is held, post it as ONE message. Kept if the post fails. Returns whether it posted.
export async function releaseHeld(pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, now: Date): Promise<boolean> {
  const first = readJson<Partial<HoldState>>(heldFileOf(conv), {});
  if (!Array.isArray(first.held) || first.held.length === 0) return false; // the usual tick: one small read, nothing more
  const zone = zoneFor(conv);
  const st = load(conv, now, zone);
  if (!planFlush({ night: isNight(now, zone), posted: st.posted, cap: settings.maxUnpromptedPerDay, held: st.held.length })) return false;
  const batch = st.held.slice();
  const res = await postNotice(pipeline, conv, combine(batch));
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

// A system notice for the owner: now, or held until the quiet window ends. Never throws.
export function noticeOwner(text: string, now: Date = new Date()): void {
  try {
    const conv = owner();
    const zone = zoneFor(conv);
    if (isNight(now, zone)) {
      const st = load(conv, now, zone);
      if (!st.held.some((h) => h.text === text)) st.held.push({ text, why: "quiet", notice: true });
      return save(conv, st);
    }
    send?.(text);
  } catch (e) {
    console.error("notices: could not tell the owner:", (e as Error).message);
  }
}

// 1. The budget: once a day, from the tick (wake.ts), when the day's spend has reached the ceiling.
export const budgetText = (): string => `Daily budget of $${settings.dailyBudgetUsd} reached, background work paused until midnight. Raise DAILY_BUDGET_USD to change it.`;
export function noticeBudget(now: Date = new Date()): boolean {
  const b = overBudget(); // (the only caller: asking elsewhere never uses up the day's one notice)
  if (b.firstTime) noticeOwner(budgetText(), now);
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
