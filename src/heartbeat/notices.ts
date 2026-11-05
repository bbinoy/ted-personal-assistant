import { takeCapNotice } from "../core/capnotice.ts";
import { MAX_HELD, holdFact } from "../core/ownerfact.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { OWNER, settings } from "../core/settings.ts";
import { convDb, damagedConvs, peekConvDb } from "../core/convdb.ts";
import { inQuietHours, timeIn } from "../core/timezone.ts";
import { causeOf, FIXES, refusal, type Cause } from "../tenants/errors.ts";
import { classifySendError } from "../conversation/outbound.ts";
import { isQuiet } from "../conversation/quiet.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { emit } from "../core/events.ts";
import { auditSource } from "../core/runkind.ts";

// What the owner is TOLD when things go wrong or go quiet, and what code keeps back from her at night. Small, separate mechanisms, all pure planners over a little state:
//   1. system matters (the damaged database (1b), the shared key, spend warnings) are a FACT for her next run (core/ownerfact.ts holdFact), which says it in its own words; there is no fixed text to her.
//   2. looks that fail: no message at all. A group's or a friend's go to the log and the doctor; the owner's own become a FACT for her next look after a long awake stretch (below).
//   3. quiet hours and /quiet, in code: an unprompted heartbeat post inside the quiet window (or while the conversation's own /quiet is on) is HELD (state, per conversation). Code never words it
//      again: when quiet is over the conversation's next look is due at once and gets everything held as facts (takeHeld, look.ts), each handed over exactly once, and says again in today's words
//      only what is still true. A conversation without a look drops what it held (dropUnreachable). The run marks a post `urgent` (rules.ts) only when it is time-critical: that is exempt from it.
//      A post of a look that runs a DUE ROUTINE (`scheduled`, decided by code in look.ts, never by the run) is exempt from the quiet window (the people asked for it at that time), not from
//      /quiet: that is an explicit "leave me alone". There is no daily limit on posts.

// ---- the pure planners ----

export type Plan = "post" | "hold";

// Urgent posts always go; otherwise the quiet window (or /quiet) holds. (`night` is decided by the caller: for a scheduled post, a due routine, only /quiet counts.)
export const planPost = (i: { urgent: boolean; night: boolean }): Plan => (i.urgent || !i.night ? "post" : "hold");

// Is it time to deliver what was held? Outside the quiet window and with something held.
export const planFlush = (i: { night: boolean; held: number }): boolean => i.held > 0 && !i.night;

export interface Held {
  text: string;
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
// The exception to the exception: a cause where NO look can run and only she can fix it (NO_MODEL: the login expired). A fact for the next look would never reach her, so after LONG_FAILS
// failures (no awake stretch: the cause is certain) she gets the chat turn's fixed line (errors.ts refusal) ONCE per streak, through postNotice, held while quiet hours or /quiet last and sent
// at the first failing look after. The streak lives in memory: a restart may tell once more. Such a cause is not also a fact for a look.
const LONG_FAILS = 3;
const NO_MODEL: ReadonlySet<Cause> = new Set<Cause>(["login"]); // (billing and refused are the shared friends' key, which the owner's looks do not run on)
const LONG_AWAKE_MS = 2 * 3_600_000;
type Scope = "owner" | "group" | "tenant";
interface Streak {
  n: number;
  since: number; // wall clock (ms) of the first failure: what the fact says
  monoSince: number; // the monotonic clock then: how long the Mac has been awake since
  mono: number; // the monotonic clock at the latest failure
  cause: Cause;
  told: boolean; // NO_MODEL: her fixed line was sent (or may have been) for this streak
}

export interface FailureTracker {
  // One finished look that was neither called off nor stopped by a sleep. Groups and friends are not tracked here (log and doctor only).
  observe(key: string, scope: Scope, failed: boolean, cause: Cause | undefined, now: number, mono: number): void;
  // The fact for the conversation's next look, or "" while its failures are not a long awake stretch.
  fact(key: string, zone?: string): string;
  // The cause to tell her in a fixed line now (NO_MODEL, LONG_FAILS reached, not yet told this streak), or undefined. `told(key, true)` marks it sent; `false` lets the next failing look try again.
  toTell(key: string): Cause | undefined;
  told(key: string, yes: boolean): void;
}

export function createFailureTracker(o: { fails?: number; awakeMs?: number } = {}): FailureTracker {
  const fails = o.fails ?? LONG_FAILS;
  const awake = o.awakeMs ?? LONG_AWAKE_MS;
  const streaks = new Map<string, Streak>();
  return {
    observe(key, scope, failed, cause, now, mono) {
      if (scope !== "owner") return;
      if (!failed) return void streaks.delete(key);
      const st = streaks.get(key) ?? { n: 0, since: now, monoSince: mono, mono, cause: cause ?? "other", told: false };
      st.n++;
      st.mono = mono;
      st.cause = cause ?? "other";
      streaks.set(key, st);
    },
    fact(key, zone) {
      const st = streaks.get(key);
      if (!st || NO_MODEL.has(st.cause) || st.n < fails || st.mono - st.monoSince < awake) return "";
      const c = FIXES[st.cause];
      const hours = Math.round(((st.mono - st.monoSince) / 3_600_000) * 10) / 10;
      return `Your own background looks have failed ${st.n} times in a row since ${timeIn(new Date(st.since), zone)} (${hours} hours of that with the Mac awake; time asleep does not count). Cause as code classifies it: ${c.what}. What would fix it: ${c.fix} This is system status: say it only if it still matters to ${OWNER} and they have to do something, in one short line in your own words; otherwise say nothing about it.`;
    },
    toTell(key) {
      const st = streaks.get(key);
      return st && NO_MODEL.has(st.cause) && st.n >= fails && !st.told ? st.cause : undefined;
    },
    told(key, yes) {
      const st = streaks.get(key);
      if (st) st.told = yes;
    },
  };
}

// ---- the state: two tables of the conversation's assistant.db (`hold`: the day's count; `held_posts`: what is held, oldest first) ----

type HeldRow = { text: string; at: number | null };
const heldOf = (r: HeldRow): Held => ({ text: r.text, ...(r.at !== null ? { at: r.at } : {}) });
const HELD_SQL = "SELECT text, at FROM held_posts ORDER BY seq";

/** How many posts are held (the usual tick: one small query, nothing more). */
const heldCount = (conv: Pick<Conversation, "convId">): number => peekConvDb(conv.convId)?.num("SELECT COUNT(*) FROM held_posts") ?? 0; // (a tick asks every conversation: it makes no database)
/** The held posts, oldest first (a read for the tests and the doctor). */
export const heldPosts = (conv: Pick<Conversation, "convId">): Held[] => convDb(conv.convId).all<HeldRow>(HELD_SQL).map(heldOf);
/** Forget everything held (tests). */
export const resetHeld = (conv: Pick<Conversation, "convId">): void => void convDb(conv.convId).run("DELETE FROM held_posts");

// The held posts in one transaction, newest MAX_HELD (the old `why` column is written as "quiet": rows from the time of a daily cap read the same).
function save(conv: Conversation, held: Held[]): void {
  const db = convDb(conv.convId);
  db.tx(() => {
    db.run("DELETE FROM held_posts");
    for (const h of held.slice(-MAX_HELD)) db.run("INSERT INTO held_posts (text, why, at) VALUES (?, 'quiet', ?)", h.text, h.at ?? null);
  });
}
const zoneFor = (conv: Conversation): string => zoneOf(conv);
const isNight = (now: Date, zone: string): boolean => inQuietHours(now, settings.quietStartHour, settings.quietEndHour, zone);
// Is this conversation being left alone right now: the quiet window, or its own /quiet (conversation/quiet.ts)?
const holding = (conv: Conversation, now: Date, zone: string): boolean => isNight(now, zone) || isQuiet(conv, now);

// Is the conversation being left alone right now (the quiet window, or its /quiet)? What a look offers in a message of its own waits by this.
export const holdingNow = (conv: Conversation, now: Date): boolean => holding(conv, now, zoneFor(conv));

// A heartbeat post that is about to go out unprompted. "post": go ahead (counted); "held": kept for later (the caller says nothing, the conversation's log notes it). `scheduled`: the look is running a due routine.
export function submitPost(conv: Conversation, text: string, urgent: boolean, now: Date, scheduled = false): "post" | "held" {
  const zone = zoneFor(conv);
  if (planPost({ urgent, night: scheduled ? isQuiet(conv, now) : holding(conv, now, zone) }) === "post") return "post";
  const held = heldPosts(conv);
  if (!held.some((h) => h.text === text)) save(conv, [...held, { text, at: now.getTime() }]);
  return "held";
}

// Deliver a notice-kind message in the conversation, the way the heartbeat does (look.ts): in its queue, logged as a notice, not a chat turn.
export const postNotice = (pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, text: string, costUsd?: number) =>
  pipeline.enqueue(conv, async () => pipeline.runTurn(conv, { run: async () => ({ text, costUsd }), background: true, announce: false, kind: "notice" })).catch((e) => ({ error: e as unknown, spoke: false }));

// What is held at the end of quiet goes to the conversation's next look as facts (look.ts), not out as text code wrote. Ready when quiet is over (the window, or /quiet).
const ready = (conv: Conversation, now: Date, held: readonly Held[]): boolean => planFlush({ night: holding(conv, now, zoneFor(conv)), held: stillTrue(held, now.getTime()).length });

// All the held posts, newest first, for the conversation's next look. They are PENDING while that look runs (like seen_mail): `done()` deletes them (and what was stale), and the look calls it only
// when it ended well (posted or silent); a failed or called-off look leaves them for the next one, so each is told at most once yet not lost (the 36 hours of stillTrue end a stuck item).
// Nothing while the conversation is still being left alone (a night look would only hold them again). Only this conversation's own database.
export function takeHeld(conv: Conversation, now: Date): { held: Held[]; done: () => void } {
  const none = { held: [], done: () => {} };
  if (heldCount(conv) === 0) return none;
  const held = heldPosts(conv);
  if (!ready(conv, now, held)) return none;
  const db = convDb(conv.convId);
  const upTo = db.num("SELECT COALESCE(MAX(seq), 0) FROM held_posts"); // (posts held while the look runs are not part of it)
  return { held: stillTrue(held, now.getTime()).reverse(), done: () => void db.run("DELETE FROM held_posts WHERE seq <= ?", upTo) };
}

// Is something held that may be handed over now? The look is then due at once (look.ts), not at the time it chose at night.
export const heldWaiting = (conv: Conversation, now: Date): boolean => heldCount(conv) > 0 && ready(conv, now, heldPosts(conv));

// A conversation with no look (its capabilities, as wake.ts asks them) has nobody to hand held posts to: they are dropped, never sent as they were written.
export function dropUnreachable(conv: Conversation): void {
  const n = heldCount(conv);
  if (n === 0) return;
  convDb(conv.convId).run("DELETE FROM held_posts");
  emit({ type: "notice", state: "dropped", conv: conv.key, text: `Dropped ${n} held message(s): this conversation has no look`, source: auditSource({ who: conv.kind, attended: false }) });
}

// ---- the owner's notices (all facts for her next run, never a fixed text) ----

// 1b. A conversation's database (assistant.db, core/convdb.ts) was damaged and set aside: once a day, until a person looks (npm run doctor says which file and what to do), as a fact for the owner's next run.
// Chat in it goes on with a fresh start; its background work is stopped (payer.ts mayRun). Returns how many facts it made.
export function noticeDamaged(now: Date = new Date()): number {
  let n = 0;
  for (const d of damagedConvs()) {
    if (!takeCapNotice(`convdb:${d.conv}`, now.getTime())) continue;
    const where = d.conv === "owner" ? "your chat" : d.conv.startsWith("friend-") ? `a friend's chat (${d.conv})` : `a group (${d.conv})`;
    holdFact(`The saved state of ${where} was damaged, so I set the file aside (it is not deleted) and started it fresh${d.salvaged?.session ? " (I kept the chat session)" : ""}. Chatting there still works, but my background work for it (looks, the dream) is stopped until you check: run npm run doctor on the Mac.`, now);
    n++;
  }
  return n;
}

// 2. Looks that fail. Called by look.ts with each finished look (not one called off or stopped by a sleep); `error` is what the run threw, if it did; `mono`: the monotonic clock now.
// When no look can run and only she can fix it (NO_MODEL), she gets the fixed line once per streak (see the tracker); a send that failed is tried again at the next failing look, unless it may have gone out.
const tracker = createFailureTracker();
export async function observeLook(pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, outcome: "posted" | "silent" | "failed", error: unknown, now: Date, mono: number = performance.now()): Promise<void> {
  try {
    tracker.observe(conv.key, conv.kind, outcome === "failed", outcome === "failed" ? causeOf(error) : undefined, now.getTime(), mono);
    const cause = tracker.toTell(conv.key);
    const text = cause && refusal(cause, "owner");
    if (!text || holdingNow(conv, now)) return;
    tracker.told(conv.key, true);
    const res = await postNotice(pipeline, conv, text);
    if (res.error && classifySendError(res.error) !== "unsure") tracker.told(conv.key, false);
  } catch (e) {
    console.error("notices: could not track a look:", (e as Error).message);
  }
}
/** The fact block for the conversation's next look: its long awake stretch of failures, or "" (always "" for a group or a friend). */
export const failingLooksFact = (conv: Conversation): string => tracker.fact(conv.key, zoneFor(conv));
