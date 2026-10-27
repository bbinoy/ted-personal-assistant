import { overBudget } from "../core/budget.ts";
import { takeCapNotice } from "../core/capnotice.ts";
import { MAX_HELD, holdFact } from "../core/ownerfact.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { owner } from "../conversation/conversationmodel.ts";
import { OWNER, settings } from "../core/settings.ts";
import { convDb, damagedConvs, peekConvDb } from "../core/convdb.ts";
import { dayIn, inQuietHours, timeIn } from "../core/timezone.ts";
import { causeOf, FIXES, type Cause } from "../tenants/errors.ts";
import { isQuiet } from "../conversation/quiet.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { emit } from "../core/events.ts";
import { onLogin } from "../core/ownerkey.ts";

// What the owner is TOLD when things go wrong or go quiet, and what code keeps back from her at night. Three small, separate mechanisms, all pure planners over a little state:
//   1. the budget notice: the day's budget is spent and background work stops until midnight. Said ONCE a day (budget.ts overBudget), in the owner's chat, as a fixed text: over budget no model
//      run is possible (CLAUDE.md allows exactly this). It waits for the end of quiet. It is the ONE fixed text to the owner: every other system matter (the damaged database (1b), the shared key,
//      the friends' daily cap) is a FACT for her next run (core/ownerfact.ts holdFact), which says it in its own words.
//   2. looks that fail: no message at all. A group's or a friend's go to the log and the doctor; the owner's own become a FACT for her next look after a long awake stretch (below).
//   3. quiet hours, /quiet and the day's cap, in code: an unprompted heartbeat post inside the quiet window (or while the conversation's own /quiet is on), or past MAX_UNPROMPTED_PER_DAY, is HELD
//      (state, per conversation). Code never words it again: when quiet is over (and the cap has room) the conversation's next look is due at once and gets everything held as facts (takeHeld, look.ts),
//      each handed over exactly once, and says again in today's words only what is still true. A conversation without a look drops what it held (dropUnreachable). The run marks a post `urgent`
//      (rules.ts) only when it is time-critical: that is exempt from all of it.

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
  at?: number; // when it was held (epoch ms); older rows have none and are kept as they were
}

const STALE_MS = 36 * 3_600_000; // nothing held is delivered after this: it is no longer news

// Pure: what of the held items is still news at `now`? Anything older than 36 hours is dropped. (Whether the owner has moved on is the look's judgement: it has the chat log.)
export const stillTrue = (held: readonly Held[], now: number): Held[] => held.filter((h) => h.at === undefined || now - h.at <= STALE_MS);

// ---- the failure tracker ----

// Looks that fail are SYSTEM STATUS (CLAUDE.md: log, doctor, not the chat). A group's or a friend's failures are only logged (look.ts) and counted for `npm run doctor` (the looks table).
// The owner's own background is the one exception, and only as a FACT for her next look, never as a fixed message: when her looks have failed at least LONG_FAILS times in a row for
// at least LONG_AWAKE_MS of time the Mac was AWAKE. Awake time is the monotonic clock (on macOS it stands still while the Mac sleeps, heartbeat.ts sleptFor), so a night of sleep between
// two failures adds nothing; a look stopped by a sleep, or cut by its ceiling across one, is not a failure at all (look.ts). The look that then runs reads the fact and decides whether it is
// worth one line. A look that works ends the streak, with no "back to normal".
export const LONG_FAILS = 3;
export const LONG_AWAKE_MS = 2 * 3_600_000;
export type Scope = "owner" | "group" | "tenant";
interface Streak {
  n: number;
  since: number; // wall clock (ms) of the first failure: what the fact says
  monoSince: number; // the monotonic clock then: how long the Mac has been awake since
  mono: number; // the monotonic clock at the latest failure
  cause: Cause;
}

export interface FailureTracker {
  // One finished look that was neither called off nor stopped by a sleep. Groups and friends are not tracked here (log and doctor only).
  observe(key: string, scope: Scope, failed: boolean, cause: Cause | undefined, now: number, mono: number): void;
  // The fact for the conversation's next look, or "" while its failures are not a long awake stretch.
  fact(key: string, zone?: string): string;
}

export function createFailureTracker(o: { fails?: number; awakeMs?: number } = {}): FailureTracker {
  const fails = o.fails ?? LONG_FAILS;
  const awake = o.awakeMs ?? LONG_AWAKE_MS;
  const streaks = new Map<string, Streak>();
  return {
    observe(key, scope, failed, cause, now, mono) {
      if (scope !== "owner") return;
      if (!failed) return void streaks.delete(key);
      const st = streaks.get(key) ?? { n: 0, since: now, monoSince: mono, mono, cause: cause ?? "other" };
      st.n++;
      st.mono = mono;
      st.cause = cause ?? "other";
      streaks.set(key, st);
    },
    fact(key, zone) {
      const st = streaks.get(key);
      if (!st || st.n < fails || st.mono - st.monoSince < awake) return "";
      const c = FIXES[st.cause];
      const hours = Math.round(((st.mono - st.monoSince) / 3_600_000) * 10) / 10;
      return `Your own background looks have failed ${st.n} times in a row since ${timeIn(new Date(st.since), zone)} (${hours} hours of that with the Mac awake; time asleep does not count). Cause as code classifies it: ${c.what}. What would fix it: ${c.fix} This is system status: say it only if it still matters to ${OWNER} and they have to do something, in one short line in your own words; otherwise say nothing about it.`;
    },
  };
}

// ---- the state: two tables of the conversation's assistant.db (`hold`: the day's count; `held_posts`: what is held, oldest first) ----

interface HoldState {
  day: string; // the conversation's own day the count belongs to
  posted: number; // unprompted posts so far that day (urgent and system notices not counted)
  held: Held[];
}

type HeldRow = { text: string; why: string; at: number | null };
const heldOf = (r: HeldRow): Held => ({ text: r.text, why: r.why === "cap" ? "cap" : "quiet", ...(r.at !== null ? { at: r.at } : {}) });
const HELD_SQL = "SELECT text, why, at FROM held_posts ORDER BY seq";

/** How many posts are held (the usual tick: one small query, nothing more). */
export const heldCount = (conv: Pick<Conversation, "convId">): number => peekConvDb(conv.convId)?.num("SELECT COUNT(*) FROM held_posts") ?? 0; // (a tick asks every conversation: it makes no database)
/** The held posts, oldest first (a read for the tests and the doctor). */
export const heldPosts = (conv: Pick<Conversation, "convId">): Held[] => convDb(conv.convId).all<HeldRow>(HELD_SQL).map(heldOf);
/** Forget the day's count and everything held (tests). */
export function resetHeld(conv: Pick<Conversation, "convId">): void {
  const db = convDb(conv.convId);
  db.tx(() => (db.run("DELETE FROM held_posts"), db.run("DELETE FROM hold")));
}

function load(conv: Conversation, now: Date, zone: string): HoldState {
  const db = convDb(conv.convId);
  const raw = db.get<{ day: string; posted: number }>("SELECT day, posted FROM hold WHERE id = 1");
  const day = dayIn(now, zone);
  return { day, posted: raw?.day === day ? raw.posted : 0, held: db.all<HeldRow>(HELD_SQL).map(heldOf) };
}
// The whole state in one transaction (the file was one atomic write): the count, and the held posts, newest MAX_HELD.
function save(conv: Conversation, st: HoldState): void {
  const db = convDb(conv.convId);
  db.tx(() => {
    db.run("INSERT INTO hold (id, day, posted) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET day = excluded.day, posted = excluded.posted", st.day, st.posted);
    db.run("DELETE FROM held_posts");
    for (const h of st.held.slice(-MAX_HELD)) db.run("INSERT INTO held_posts (text, why, at) VALUES (?, ?, ?)", h.text, h.why, h.at ?? null);
  });
}
const zoneFor = (conv: Conversation): string => zoneOf(conv);
const isNight = (now: Date, zone: string): boolean => inQuietHours(now, settings.quietStartHour, settings.quietEndHour, zone);
// Is this conversation being left alone right now: the quiet window, or its own /quiet (conversation/quiet.ts)?
const holding = (conv: Conversation, now: Date, zone: string): boolean => isNight(now, zone) || isQuiet(conv, now);

// Is the conversation being left alone right now (the quiet window, or its /quiet)? What a look offers in a message of its own waits by this.
export const holdingNow = (conv: Conversation, now: Date): boolean => holding(conv, now, zoneFor(conv));

// A heartbeat post that is about to go out unprompted. "post": go ahead (counted); "held": kept for later (the caller says nothing, the conversation's log notes it).
export function submitPost(conv: Conversation, text: string, urgent: boolean, now: Date): "post" | "held" {
  const zone = zoneFor(conv);
  const st = load(conv, now, zone);
  const plan = planPost({ urgent, night: holding(conv, now, zone), posted: st.posted, cap: settings.maxUnpromptedPerDay });
  if (plan === "post") {
    if (!urgent) st.posted++;
    save(conv, st);
    return "post";
  }
  if (!st.held.some((h) => h.text === text)) st.held.push({ text, why: plan === "hold-quiet" ? "quiet" : "cap", at: now.getTime() });
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

// What is held at the end of quiet goes to the conversation's next look as facts (look.ts), not out as text code wrote. Ready when quiet is over (the window, or /quiet) and the day's cap has room (a
// cap-held post therefore waits for the next day).
const ready = (conv: Conversation, now: Date, st: HoldState): boolean => planFlush({ night: holding(conv, now, zoneFor(conv)), posted: st.posted, cap: settings.maxUnpromptedPerDay, held: stillTrue(st.held, now.getTime()).length });

// All the held posts, newest first, for the conversation's next look. They are PENDING while that look runs (like seen_mail): `done()` deletes them (and what was stale), and the look calls it only
// when it ended well (posted or silent); a failed or called-off look leaves them for the next one, so each is told at most once yet not lost (the 36 hours of stillTrue end a stuck item).
// Nothing while the conversation is still being left alone (a night look would only hold them again). Only this conversation's own database.
export function takeHeld(conv: Conversation, now: Date): { held: Held[]; done: () => void } {
  const none = { held: [], done: () => {} };
  if (heldCount(conv) === 0) return none;
  const st = load(conv, now, zoneFor(conv));
  if (!ready(conv, now, st)) return none;
  const db = convDb(conv.convId);
  const upTo = db.num("SELECT COALESCE(MAX(seq), 0) FROM held_posts"); // (posts held while the look runs are not part of it)
  return { held: stillTrue(st.held, now.getTime()).reverse(), done: () => void db.run("DELETE FROM held_posts WHERE seq <= ?", upTo) };
}

// Is something held that may be handed over now? The look is then due at once (look.ts), not at the time it chose at night.
export const heldWaiting = (conv: Conversation, now: Date): boolean => heldCount(conv) > 0 && ready(conv, now, load(conv, now, zoneFor(conv)));

// A conversation with no look (its capabilities, as wake.ts asks them) has nobody to hand held posts to: they are dropped, never sent as they were written.
export function dropUnreachable(conv: Conversation): void {
  const n = heldCount(conv);
  if (n === 0) return;
  convDb(conv.convId).run("DELETE FROM held_posts");
  emit({ type: "notice", state: "dropped", conv: conv.key, text: `Dropped ${n} held message(s): this conversation has no look`, source: onLogin(conv) ? "background" : "group" });
}

// ---- the owner's notices ----

let send: ((text: string) => void) | undefined;
export const ownerNotices = {
  sendTo: (fn: ((text: string) => void) | undefined): void => void (send = fn), // main.ts: the owner's chat
};

// A fixed text to the owner's chat now. Never throws.
function noticeOwner(text: string): void {
  try {
    send?.(text);
  } catch (e) {
    console.error("notices: could not tell the owner:", (e as Error).message);
  }
}

// 1. The budget: once a day, from the tick (wake.ts), when the day's spend has reached the ceiling.
export const budgetText = (): string => `Daily budget of $${settings.dailyBudgetUsd} reached, background work paused until midnight. To lift it today, raise DAILY_BUDGET_USD in .env and restart.`;
export function noticeBudget(now: Date = new Date()): boolean {
  if (holdingNow(owner(), now)) return false; // (not asked, so the day's one notice is not used up: it comes when quiet is over)
  const b = overBudget(); // (the only caller: asking elsewhere never uses up the day's one notice)
  if (b.firstTime) noticeOwner(budgetText());
  return b.firstTime;
}

// 1b. A conversation's database (assistant.db, core/convdb.ts) was damaged and set aside: once a day, until a person looks (npm run doctor says which file and what to do), as a fact for the owner's next run.
// Chat in it goes on with a fresh start; its background work is stopped (payer.ts mayRun). Returns how many facts it made.
export function noticeDamaged(now: Date = new Date()): number {
  let n = 0;
  for (const d of damagedConvs()) {
    if (!takeCapNotice(`convdb:${d.conv}`, now.getTime())) continue;
    const where = d.conv === "owner" ? "your chat" : d.conv.startsWith("friend-") ? `a friend's chat (${d.conv})` : `a group (${d.conv})`;
    holdFact(`The saved state of ${where} was damaged, so I set the file aside (it is not deleted) and started it fresh${d.salvaged ? ` (I kept the mail I had already handled${d.salvaged.session ? " and the chat session" : ""})` : ""}. Chatting there still works, but my background work for it (looks, the dream) is stopped until you check: run npm run doctor on the Mac.`, now);
    n++;
  }
  return n;
}

// 2. Looks that fail. Called by look.ts with each finished look (not one called off or stopped by a sleep); `error` is what the run threw, if it did; `mono`: the monotonic clock now.
const tracker = createFailureTracker();
const scopeOf = (conv: Pick<Conversation, "kind">): Scope => (conv.kind === "tenant" ? "tenant" : conv.kind === "group" ? "group" : "owner");
export function observeLook(conv: Conversation, outcome: "posted" | "silent" | "failed", error: unknown, now: Date, mono: number = performance.now()): void {
  try {
    tracker.observe(conv.key, scopeOf(conv), outcome === "failed", outcome === "failed" ? causeOf(error) : undefined, now.getTime(), mono);
  } catch (e) {
    console.error("notices: could not track a look:", (e as Error).message);
  }
}
/** The fact block for the conversation's next look: its long awake stretch of failures, or "" (always "" for a group or a friend). */
export const failingLooksFact = (conv: Conversation): string => tracker.fact(conv.key, zoneFor(conv));
