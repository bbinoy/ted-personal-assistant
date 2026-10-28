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
//   pending_*       the old approval inbox (unattended runs parked calls there until 22 Oct; nothing writes it since 26 Oct): emptied, its rows hold call arguments nobody will run
//   voice_notes / voice_quotes   notes outside the 7-day look-back, and the 50 / 100 newest
//   learned_*       the "learned overnight" rows (memory/learned.ts) older than 60 days, told or not (the lists prune themselves as they are made; this is for a conversation that never makes one)
//   meetings        rows whose meeting started more than 3 days ago (tasks/meetings.ts)
//   routine_runs    rows of a routine whose note (routine-<name>.md, broken ones too) is gone; one still `started` (not yet stale) stays
// NEVER touched: the session record, the dream day, /quiet, a friend's bookkeeping. A dry run counts and removes nothing.
// Only conversations that HAVE a database are visited (none is made for the sweep).

const INBOX_TABLES = ["pending_items", "pending_expired", "pending_blocked", "pending_lost"] as const; // (the schema keeps them: a shipped step is never edited, and a dropped table would stop an older build from opening the file)

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The routine_runs rows of a routine that no longer exists in this conversation: nothing reads them again. A note that exists but cannot be read still counts (scheduledIn lists it as broken); a run in progress stays until it is stale. */
function pruneRoutineRuns(db: ReturnType<typeof convDbAt>, notesDir: string, now: Date, dry: boolean): number {
  if (!existsSync(notesDir)) return 0; // (no notes folder to read: say nothing is gone)
  const { routines, broken } = scheduledIn({ notesDir, zone: "UTC", now: new Date(now.getTime() - 2 * 86_400_000) }); // (two days back: a note that expires today is still a routine; the expired-notes rule sets it aside)
  const alive = new Set([...routines.map((r) => r.name), ...broken.flatMap((b) => /^(\S+)\.md /.exec(b)?.[1] ?? [])]);
  const stale = now.getTime() - STALE_MINUTES * 60_000;
  let n = 0;
  for (const r of db.all<{ name: string; status: string | null; at: number | null }>("SELECT name, status, at FROM routine_runs")) {
    if (alive.has(r.name) || (r.status === "started" && (r.at ?? 0) > stale)) continue;
    n++;
    if (!dry) db.run("DELETE FROM routine_runs WHERE name = ?", r.name);
  }
  return n;
}

export function convDbRule(L: () => Layout): RetentionRule {
  return {
    name: "conv-db",
    everyHours: 24,
    run(now, o) {
      const l = L();
      const parts = { seen: 0, held: 0, inbox: 0, voice: 0, learned: 0, meetings: 0, routines: 0 };
      for (const conv of names(l.conversations)) {
        if (!isConvId(conv) || !existsSync(l.conv(conv).db)) continue;
        const db = convDbAt(l.root, conv);
        parts.seen += trimSeenMail(db, SEEN_MAX, o.dryRun);
        const over = Math.max(0, db.num("SELECT COUNT(*) FROM held_posts") - MAX_HELD);
        parts.held += over;
        if (over > 0 && !o.dryRun) db.run("DELETE FROM held_posts WHERE seq IN (SELECT seq FROM held_posts ORDER BY seq LIMIT ?)", over);
        for (const t of INBOX_TABLES) parts.inbox += o.dryRun ? db.num(`SELECT COUNT(*) FROM ${t}`) : db.run(`DELETE FROM ${t}`).changes;
        parts.voice += pruneVoiceNotes(db, now.getTime(), o.dryRun);
        const old = now.getTime() - 60 * 86_400_000;
        parts.learned += db.num("SELECT COUNT(*) FROM learned_changes WHERE at < ?", old);
        if (!o.dryRun) {
          db.run("DELETE FROM learned_changes WHERE at < ?", old);
          db.run("DELETE FROM learned_batches WHERE at < ?", old);
        }
        parts.meetings += o.dryRun ? db.num("SELECT COUNT(*) FROM meetings WHERE start_ms < ?", now.getTime() - MEETING_KEEP_MS) : db.run("DELETE FROM meetings WHERE start_ms < ?", now.getTime() - MEETING_KEEP_MS).changes;
        parts.routines += pruneRoutineRuns(db, l.conv(conv).notes, now, o.dryRun);
      }
      const removed = parts.seen + parts.held + parts.inbox + parts.voice + parts.learned + parts.meetings + parts.routines;
      return { removed, freedBytes: 0, notes: `conversation databases: ${parts.seen} seen-mail id(s) past ${SEEN_MAX}, ${parts.held} held post(s) past ${MAX_HELD}, ${parts.inbox} row(s) of the old approval inbox, ${parts.voice} voice row(s) past their window, ${parts.learned} learned row(s) older than 60 days, ${parts.meetings} meeting row(s) older than 3 days, ${parts.routines} record(s) of routines whose note is gone` };
    },
  };
}

export const registerConvRules = (): void => registerRetention(convDbRule(() => layout(dataRoot())));
