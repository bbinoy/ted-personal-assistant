import { existsSync, readdirSync } from "node:fs";
import { convDbAt } from "../core/convdb.ts";
import { dataRoot, isConvId, layout, type Layout } from "../core/convpaths.ts";
import { registerRetention, type RetentionRule } from "../core/retention.ts";
import { pruneVoiceNotes } from "../modules/voice/voicenote.ts";
import { SEEN_MAX, trimSeenMail } from "../modules/seenmail/seenmail.ts";
import { MAX_HELD } from "../core/ownerfact.ts";
import { KEEP_MS as MEETING_KEEP_MS } from "../tasks/meetings.ts";
import { STALE_MINUTES } from "../tasks/routines.ts";
import { scheduledIn } from "../modules/tasks/routinelist.ts";

// The retention rule for the tables of every conversation's assistant.db (core/convdb.ts; core/retention.ts says how rules run). Each table is bounded where it is written already; this is the
// nightly guarantee that the bound holds (a changed bound, a crash between a write and its trim) and the sweep of what has only an age:
//   seen_mail       the newest SEEN_MAX (2000) ids; older ones are forgotten (the mail they name is long past the look-back)
//   held_posts      the newest MAX_HELD (30): a handover to the next look, not an archive
//   voice_notes / voice_quotes   notes outside the 7-day look-back, and the 50 / 100 newest
//   meetings        rows whose meeting started more than 3 days ago (tasks/meetings.ts)
//   reminders       a claimed / retry mark older than a day whose task is no longer open or snoozed (done, dropped); the marks of an open task stay: they are its at-most-once record
//   lapsed_approvals  rows older than 7 days (a lapsed background approval no look got to)
//   routine_runs    rows of a routine whose note (routine-<name>.md, broken ones too) is gone; one still `started` (not yet stale) stays
// NEVER touched: the session record, the dream day, /quiet, a friend's bookkeeping, the `told` marks (a once-told mark must outlive everything). A dry run counts and removes nothing.
// Only conversations that HAVE a database are visited (none is made for the sweep).

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The routine_runs rows of a routine that no longer exists in this conversation: nothing reads them again. A note that exists but cannot be read still counts (scheduledIn lists it as broken, by file); a run in progress stays until it is stale. */
function pruneRoutineRuns(db: ReturnType<typeof convDbAt>, notesDir: string, now: Date, dry: boolean): number {
  if (!existsSync(notesDir)) return 0; // (no notes folder to read: say nothing is gone)
  const { routines, broken } = scheduledIn({ notesDir, zone: "UTC", now: new Date(now.getTime() - 2 * 86_400_000) }); // (two days back: a note that expires today is still a routine; the expired-notes rule sets it aside)
  const alive = new Set([...routines.map((r) => r.name), ...broken.map((b) => b.file.replace(/\.md$/, ""))]);
  const stale = now.getTime() - STALE_MINUTES * 60_000;
  let n = 0;
  for (const r of db.all<{ name: string; status: string | null; at: number | null }>("SELECT name, status, at FROM routine_runs")) {
    if (alive.has(r.name) || (r.status === "started" && (r.at ?? 0) > stale)) continue;
    n++;
    if (!dry) db.run("DELETE FROM routine_runs WHERE name = ?", r.name);
  }
  return n;
}

const DEAD_REMINDER_MS = 86_400_000; // a look holds a claim for minutes (the fallback line goes out after 30): older than a day nobody holds it
const FINISHED = "state IN ('claimed', 'retry') AND at < ? AND item_id NOT IN (SELECT id FROM items WHERE status IN ('open', 'snoozed'))";
/** Claimed / retry reminder marks of a task that is done, dropped or gone: remindtick skips them and nothing else reads them. */
function pruneReminders(db: ReturnType<typeof convDbAt>, now: number, dry: boolean): number {
  return dry ? db.num(`SELECT COUNT(*) FROM reminders WHERE ${FINISHED}`, now - DEAD_REMINDER_MS) : db.run(`DELETE FROM reminders WHERE ${FINISHED}`, now - DEAD_REMINDER_MS).changes;
}

export function convDbRule(L: () => Layout): RetentionRule {
  return {
    name: "conv-db",
    everyHours: 24,
    run(now, o) {
      const l = L();
      const parts = { seen: 0, held: 0, voice: 0, meetings: 0, routines: 0, reminders: 0, lapsed: 0 };
      for (const conv of names(l.conversations)) {
        if (!isConvId(conv) || !existsSync(l.conv(conv).db)) continue;
        const db = convDbAt(l.root, conv);
        parts.seen += trimSeenMail(db, SEEN_MAX, o.dryRun);
        const over = Math.max(0, db.num("SELECT COUNT(*) FROM held_posts") - MAX_HELD);
        parts.held += over;
        if (over > 0 && !o.dryRun) db.run("DELETE FROM held_posts WHERE seq IN (SELECT seq FROM held_posts ORDER BY seq LIMIT ?)", over);
        parts.voice += pruneVoiceNotes(db, now.getTime(), o.dryRun);
        parts.meetings += o.dryRun ? db.num("SELECT COUNT(*) FROM meetings WHERE start_ms < ?", now.getTime() - MEETING_KEEP_MS) : db.run("DELETE FROM meetings WHERE start_ms < ?", now.getTime() - MEETING_KEEP_MS).changes;
        const lapsedOld = now.getTime() - 7 * 86_400_000;
        parts.lapsed += o.dryRun ? db.num("SELECT COUNT(*) FROM lapsed_approvals WHERE at < ?", lapsedOld) : db.run("DELETE FROM lapsed_approvals WHERE at < ?", lapsedOld).changes;
        parts.reminders += pruneReminders(db, now.getTime(), o.dryRun);
        parts.routines += pruneRoutineRuns(db, l.conv(conv).notes, now, o.dryRun);
      }
      const removed = parts.seen + parts.held + parts.voice + parts.meetings + parts.routines + parts.reminders + parts.lapsed;
      return { removed, freedBytes: 0, notes: `conversation databases: ${parts.seen} seen-mail id(s) past ${SEEN_MAX}, ${parts.held} held post(s) past ${MAX_HELD}, ${parts.voice} voice row(s) past their window, ${parts.meetings} meeting row(s) older than 3 days, ${parts.routines} record(s) of routines whose note is gone, ${parts.reminders} reminder mark(s) of finished tasks, ${parts.lapsed} lapsed approval(s) older than 7 days` };
    },
  };
}

export const registerConvRules = (): void => registerRetention(convDbRule(() => layout(dataRoot())));
