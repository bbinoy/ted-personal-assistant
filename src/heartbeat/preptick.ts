import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { settings } from "../core/settings.ts";
import { emitRecord } from "../core/events.ts";
import { inQuietHours } from "../core/timezone.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { isQuiet } from "../conversation/quiet.ts";
import { allows } from "../policy/capabilities.ts";
import { isRefusal, type Payer, type Refusal } from "../tenants/payer.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { lookerOf } from "../run/scope.ts";
import { PLUGIN } from "../modules/skills.ts";
import { claimMeeting, giveBack, MIN_LEAD_MS, openMeetings, prepDue, prepSkip, settleMeeting, sweepMeetings, type MeetingRow } from "../tasks/meetings.ts";
import { countPosts, postNotice } from "./notices.ts";
import { parsePrep, prepPrompt } from "../run/prep.ts";

// The MEETING PREP TICK (called from wake.ts for every conversation, like remindtick.ts): the look RECORDED the upcoming meetings (modules/meetings, tasks/meetings.ts); this fires, PREP_MINUTES before
// each one that has other people on it, ONE short helper run that gathers what is known about them and writes the message (run/agent.ts runPrep, read-only), and posts it through the notices layer.
// Code schedules, the model writes. The tick itself has no model and cannot read the calendar: it knows only what the look recorded, so without the look's record (no calendar, the look did not run) nothing fires.
//
// The rules, all in code:
//   * AT MOST ONCE per event id AND start time: the row is claimed in the database BEFORE the run starts; a moved event is a new row (its old pending one went when the look re-recorded it), so a reschedule gets its own prep.
//   * SKIPPED (meetings.ts prepSkip): declined by the owner, all-day, private, nobody else on it (and no video link), and with PREP_ONLY_EXTERNAL nobody outside her e-mail domain.
//   * NEVER IN THE DEEP NIGHT: no prep goes out between 23:00 and 06:00 in her zone, nor while her own /quiet is on. A prep is only useful before its meeting, so it is DROPPED then (never held for a digest).
//     The configured quiet window (22:00-07:00 by default) does not hold it back otherwise: a calendar entry says she is up, and a prep for a 07:00 meeting that arrives at 07:30 is worth nothing.
//   * COUNTED, NEVER CAPPED: it counts toward the day's unprompted posts (countPosts) but is not held by the cap, like an urgent post: it is time-critical by design and the cap is for chatter.
//   * NOT SENT LATE: less than MIN_LEAD_MS before the start (the run was slow, the tick late) it is dropped.
//   * BOUNDED: PREP_BUDGET_USD and a few minutes per run, its own place in the run gate (ahead of the looks), charged like any run; a failed run is tried again once while there is time.
//   * Only the conversations with a calendar: the owner's, a friend's whose set has Google calendar; a group never.

export interface PrepDeps {
  pipeline: Pick<Pipeline, "enqueue" | "runTurn">;
  may: (conv: Conversation, what: string) => Payer | Refusal;
  run: (conv: Conversation, payer: Payer, prompt: string) => Promise<{ text: string; costUsd?: number; structured?: unknown }>; // agent.ts runPrep, with the conversation's background approver
  now?: () => Date;
}

export const NIGHT_FROM = 23; // the deep night, fixed: no prep between these hours (her zone)
export const NIGHT_TO = 6;

/** Does this conversation have meeting prep at all: switched on, not a group, and a calendar in its capability set (the owner's connector, a friend's own Google). */
export const prepEnabled = (conv: Conversation): boolean => settings.prepMinutes > 0 && conv.kind !== "group" && allows(conv, "calendar") && allows(conv, "heartbeat");

/** May a prep go out at this moment? Not in the deep night, not while her /quiet is on. */
export const prepAllowedNow = (conv: Conversation, now: Date): boolean => !inQuietHours(now, NIGHT_FROM, NIGHT_TO, zoneOf(conv)) && !isQuiet(conv, now);

/**
 * One conversation's preps for this tick: sweeps what is too late, drops what the rules skip, claims what is due and starts a run for each (in the background: the returned promises settle with what
 * happened, the tick does not wait for them). Never throws; never creates a database.
 */
export function startPreps(deps: PrepDeps, conv: Conversation, now: Date = deps.now?.() ?? new Date()): Promise<string>[] {
  try {
    if (!prepEnabled(conv)) return [];
    const peek = peekConvDb(conv.convId);
    if (!peek || peek.num("SELECT COUNT(*) FROM meetings WHERE state IN ('pending', 'retry')") === 0) return []; // (the usual tick: one small query)
    const db = liveConvDb(conv.convId);
    if (!db) return [];
    const t = now.getTime();
    sweepMeetings(db, t);
    const jobs: Promise<string>[] = [];
    for (const m of openMeetings(db)) {
      if (!prepDue(m, t, settings.prepMinutes)) continue;
      const skip = prepSkip(m, { onlyExternal: settings.prepOnlyExternal });
      if (skip) {
        settleMeeting(db, m, "skipped", t, { why: skip });
        continue;
      }
      if (!prepAllowedNow(conv, now)) {
        settleMeeting(db, m, "skipped", t, { why: "quiet" });
        continue;
      }
      const payer = deps.may(conv, "meeting prep");
      if (isRefusal(payer)) continue; // paused, in a cooldown or over the day's budget: it stays open, and the sweep drops it if the time runs out
      if (!claimMeeting(db, m, t)) continue; // (another tick has it)
      jobs.push(job(deps, conv, payer, m, now));
    }
    return jobs;
  } catch (e) {
    console.error(`meeting prep: ${conv.kind} tick failed:`, (e as Error).message);
    return [];
  }
}

async function job(deps: PrepDeps, conv: Conversation, payer: Payer, m: MeetingRow, started: Date): Promise<string> {
  const clock = deps.now ?? (() => new Date());
  const looker = lookerOf(conv);
  const done = (state: "sent" | "skipped", why?: string, costUsd?: number): string => {
    const db = liveConvDb(conv.convId);
    if (db) settleMeeting(db, m, state, clock().getTime(), { why, costUsd });
    return state === "sent" ? "prep-sent" : `prep-${why ?? "skipped"}`;
  };
  const retry = (why: string): string => {
    const db = liveConvDb(conv.convId);
    const s = db ? giveBack(db, m, clock().getTime(), why) : "failed";
    return s === "retry" ? "prep-retry" : "prep-failed";
  };
  try {
    const minutes = Math.max(1, Math.round((m.startMs - started.getTime()) / 60_000));
    const prompt = prepPrompt(m, { now: started, zone: looker.zone, name: looker.who, minutes, skill: looker.own ? `${PLUGIN}:meeting-prep` : undefined, tasks: allows(conv, "tasks") });
    const reply = await deps.run(conv, payer, prompt);
    const cost = reply.costUsd;
    const message = parsePrep(reply.structured, reply.text);
    const now = clock();
    emitRecord("meeting_prep", message ? "written" : "empty", looker.own ? "background" : "group", { costUsd: cost ?? 0 }); // (counts only: never the title, a name or a word of the message)
    if (!message) return done("skipped", "nothing to say", cost);
    if (m.startMs - now.getTime() < MIN_LEAD_MS) return done("skipped", "too late", cost);
    if (!prepAllowedNow(conv, now)) return done("skipped", "quiet", cost); // (it got to be night, or she said /quiet, while the run worked)
    const res = await postNotice(deps.pipeline, conv, message, cost);
    if (res.error) return retry("post failed");
    countPosts(conv, 1, now);
    return done("sent", undefined, cost);
  } catch (e) {
    console.error(`meeting prep: the ${conv.kind} run failed:`, (e as Error).message);
    return retry("run failed");
  }
}
