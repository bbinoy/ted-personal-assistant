import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { settings } from "../core/settings.ts";
import { inQuietHours } from "../core/timezone.ts";
import type { Conversation } from "../conversation/conversation.ts";
import { isQuiet } from "../conversation/quiet.ts";
import { allows } from "../policy/capabilities.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { claimMeeting, claimedMeetings, giveBack, openMeetings, prepDue, prepSkip, settleMeeting, sweepMeetings, type MeetingRow } from "../tasks/meetings.ts";

// The MEETING PREP TICK (called from wake.ts for every conversation, like remindtick.ts): the look RECORDED the upcoming meetings (modules/meetings, tasks/meetings.ts); this decides WHEN, PREP_MINUTES before each
// one that has other people on it, and CLAIMS it. A claimed meeting makes the conversation's look due at once (look.ts `meetingsWaiting`) and its prompt carries the meeting as a fact (tasks/meetings.ts
// `meetingFacts`); the look prepares and says it in Ted's voice (the meeting-prep skill, or the expert), and only when the look posted or sent is the meeting marked sent (`afterPrep`).
// The tick itself has no model and cannot read the calendar: it knows only what the look recorded, so without the look's record (no calendar, the look did not run) nothing fires.
//
// The rules, all in code:
//   * AT MOST ONCE per event id AND start time: the row is claimed in the database BEFORE the look is made due; a moved event is a new row (its old pending one went when the look re-recorded it).
//   * SKIPPED (meetings.ts prepSkip): declined by the owner, all-day, private, nobody else on it (and no video link). Whether a meeting is worth a word is the look's judgement from the meeting's facts (attendees, who is outside her domain).
//   * NEVER CLAIMED IN THE DEEP NIGHT: none between 23:00 and 06:00 in her zone, nor while her own /quiet is on. It stays open; a later tick claims it if the night or /quiet ends in time, the sweep drops it once too late.
//   * NOT SAID LATE: less than MIN_LEAD_MS before the start the sweep drops it, claimed or not.
//   * A look that did not tell it gives it back once while there is time; a look that told it marks it sent. Otherwise it is an ordinary look: the same floor, judge and budget as any other.
//   * Only the conversations with a calendar: the owner's, a friend's whose set has Google calendar; a group never.

export const NIGHT_FROM = 23; // the deep night, fixed: no prep between these hours (her zone)
export const NIGHT_TO = 6;

/** Does this conversation have meeting prep at all: switched on and a calendar in its capability set (the owner's connector, a friend's own Google). */
export const prepEnabled = (conv: Conversation): boolean => settings.prepMinutes > 0 && allows(conv, "calendar") && allows(conv, "heartbeat");

/** May a prep be claimed at this moment? Not in the deep night, not while her /quiet is on. */
export const prepAllowedNow = (conv: Conversation, now: Date): boolean => !inQuietHours(now, NIGHT_FROM, NIGHT_TO, zoneOf(conv)) && !isQuiet(conv, now);

/** One conversation's tick: sweeps what is too late, drops what the rules skip, claims what is due (the look says it). Never throws; never creates a database. Returns how many it claimed. */
export function claimPreps(conv: Conversation, now: Date): number {
  try {
    if (!prepEnabled(conv)) return 0;
    const peek = peekConvDb(conv.convId);
    if (!peek || peek.num("SELECT COUNT(*) FROM meetings WHERE state IN ('pending', 'retry', 'claimed')") === 0) return 0; // (the usual tick: one small query)
    const db = liveConvDb(conv.convId);
    if (!db) return 0;
    const t = now.getTime();
    sweepMeetings(db, t);
    let claimed = 0;
    for (const m of openMeetings(db)) {
      if (!prepDue(m, t, settings.prepMinutes)) continue;
      const skip = prepSkip(m);
      if (skip) settleMeeting(db, m, "skipped", t, { why: skip });
      else if (prepAllowedNow(conv, now) && claimMeeting(db, m, t)) claimed++;
    }
    return claimed;
  } catch (e) {
    console.error(`meeting prep: ${conv.kind} tick failed:`, (e as Error).message);
    return 0;
  }
}

/** Is a claimed meeting waiting for the look? Then the look is due now (look.ts). One small query. */
export const meetingsWaiting = (conv: Pick<Conversation, "convId">): boolean => (peekConvDb(conv.convId)?.num("SELECT COUNT(*) FROM meetings WHERE state = 'claimed'") ?? 0) > 0;

/** The claimed meetings the look is handed (its fact block). */
export const waitingMeetings = (conv: Pick<Conversation, "convId">): MeetingRow[] => {
  const db = peekConvDb(conv.convId);
  return db ? claimedMeetings(db) : [];
};

/** After a look: the meetings it was handed are sent when it said something (posted, or sent while it worked); else they are given back for one more try while there is time (a held post is not told: a prep after the meeting is worth nothing). */
export function afterPrep(conv: Pick<Conversation, "convId">, handed: readonly MeetingRow[], said: boolean, now: number): void {
  const db = handed.length ? liveConvDb(conv.convId) : undefined;
  if (!db) return;
  for (const m of handed) {
    if (said) settleMeeting(db, m, "sent", now);
    else giveBack(db, m, now, "look did not tell it");
  }
}
