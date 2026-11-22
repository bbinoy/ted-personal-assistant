import { takeCapNotice } from "../core/capnotice.ts";
import { MAX_HELD, holdFact } from "../core/ownerfact.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { settings } from "../core/settings.ts";
import { convDb, damagedConvs, peekConvDb } from "../core/convdb.ts";
import { inQuietHours } from "../core/timezone.ts";
import { isQuiet } from "../conversation/quiet.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { emit } from "../core/events.ts";
import { auditSource } from "../core/runkind.ts";

// What the owner is TOLD when things go wrong or go quiet, and what code keeps back from her at night. Small, separate mechanisms, all pure planners over a little state:
//   1. system matters (the damaged database (1b), the shared key, spend warnings) are a FACT for her next run (core/ownerfact.ts holdFact), which says it in its own words; there is no fixed text to her.
//   2. looks that fail: no message at all. They go to the log and the doctor, and the looks table keeps the cause: the conversation's next look is handed the recent failures as a FACT (facts.ts failingLooksFact).
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
  at: number; // when it was held (epoch ms)
}

// ---- the state: two tables of the conversation's assistant.db (`hold`: the day's count; `held_posts`: what is held, oldest first) ----

const HELD_SQL = "SELECT text, at FROM held_posts ORDER BY seq";

/** How many posts are held (the usual tick: one small query, nothing more). */
const heldCount = (conv: Pick<Conversation, "convId">): number => peekConvDb(conv.convId)?.num("SELECT COUNT(*) FROM held_posts") ?? 0; // (a tick asks every conversation: it makes no database)
/** The held posts, oldest first (a read for the tests and the doctor). */
export const heldPosts = (conv: Pick<Conversation, "convId">): Held[] => convDb(conv.convId).all<Held>(HELD_SQL);
/** Forget everything held (tests). */
export const resetHeld = (conv: Pick<Conversation, "convId">): void => void convDb(conv.convId).run("DELETE FROM held_posts");

// The held posts in one transaction, newest MAX_HELD.
function save(conv: Conversation, held: Held[]): void {
  const db = convDb(conv.convId);
  db.tx(() => {
    db.run("DELETE FROM held_posts");
    for (const h of held.slice(-MAX_HELD)) db.run("INSERT INTO held_posts (text, why, at) VALUES (?, 'quiet', ?)", h.text, h.at);
  });
}
const isNight = (now: Date, zone: string): boolean => inQuietHours(now, settings.quietStartHour, settings.quietEndHour, zone);
// Is this conversation being left alone right now: the quiet window, or its own /quiet (conversation/quiet.ts)?
const holding = (conv: Conversation, now: Date, zone: string): boolean => isNight(now, zone) || isQuiet(conv, now);

// Is the conversation being left alone right now (the quiet window, or its /quiet)? What a look offers in a message of its own waits by this.
export const holdingNow = (conv: Conversation, now: Date): boolean => holding(conv, now, zoneOf(conv));

// A heartbeat post that is about to go out unprompted. "post": go ahead (counted); "held": kept for later (the caller says nothing, the conversation's log notes it). `scheduled`: the look is running a due routine.
export function submitPost(conv: Conversation, text: string, urgent: boolean, now: Date, scheduled = false): "post" | "held" {
  const zone = zoneOf(conv);
  if (planPost({ urgent, night: scheduled ? isQuiet(conv, now) : holding(conv, now, zone) }) === "post") return "post";
  const held = heldPosts(conv);
  if (!held.some((h) => h.text === text)) save(conv, [...held, { text, at: now.getTime() }]);
  return "held";
}

// Deliver a notice-kind message in the conversation, the way the heartbeat does (look.ts): in its queue, logged as a notice, not a chat turn.
export const postNotice = (pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, text: string, costUsd?: number) =>
  pipeline.enqueue(conv, async () => pipeline.runTurn(conv, { run: async () => ({ text, costUsd }), background: true, announce: false, kind: "notice" })).catch((e) => ({ error: e as unknown, spoke: false }));

// What is held at the end of quiet goes to the conversation's next look as facts (look.ts), not out as text code wrote. Ready when quiet is over (the window, or /quiet).
const ready = (conv: Conversation, now: Date, held: readonly Held[]): boolean => planFlush({ night: holding(conv, now, zoneOf(conv)), held: held.length });

// All the held posts, newest first, for the conversation's next look. They are PENDING while that look runs (like seen_mail): `done()` deletes them, and the look calls it only
// when it ended well (posted or silent); a failed or called-off look leaves them for the next one, so each is told at most once yet not lost (the newest MAX_HELD are kept, so a stuck item cannot pile up).
// Nothing while the conversation is still being left alone (a night look would only hold them again). Only this conversation's own database.
export function takeHeld(conv: Conversation, now: Date): { held: Held[]; done: () => void } {
  const none = { held: [], done: () => {} };
  if (heldCount(conv) === 0) return none;
  const held = heldPosts(conv);
  if (!ready(conv, now, held)) return none;
  const db = convDb(conv.convId);
  const upTo = db.num("SELECT COALESCE(MAX(seq), 0) FROM held_posts"); // (posts held while the look runs are not part of it)
  return { held: held.reverse(), done: () => void db.run("DELETE FROM held_posts WHERE seq <= ?", upTo) };
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
