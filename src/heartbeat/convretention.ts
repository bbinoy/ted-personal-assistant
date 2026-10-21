import { existsSync, readdirSync } from "node:fs";
import { convDbAt } from "../core/convdb.ts";
import { dataRoot, isConvId, layout, type Layout } from "../core/convpaths.ts";
import { registerRetention, type RetentionRule } from "../core/retention.ts";
import { pruneBlocked } from "../approvals/pending.ts";
import { pruneVoiceNotes } from "../modules/voice/voicenote.ts";
import { SEEN_MAX, trimSeenMail } from "../modules/seenmail/seenmail.ts";
import { MAX_HELD } from "./notices.ts";

// The retention rule for the tables of every conversation's assistant.db (core/convdb.ts; core/retention.ts says how rules run). Each table is bounded where it is written already; this is the
// nightly guarantee that the bound holds (a changed bound, a crash between a write and its trim) and the sweep of what has only an age:
//   seen_mail       the newest SEEN_MAX (2000) ids; older ones are forgotten (the mail they name is long past the look-back)
//   held_posts      the newest MAX_HELD (30): a morning digest, not an archive
//   pending_blocked the calls not to park again for a while: past their window, and at most 100
//   voice_notes / voice_quotes   notes outside the 7-day look-back, and the 50 / 100 newest
// NEVER touched: the session record, the dream day, /quiet, the approval inbox's items and its numbering (a number is never reused), a friend's bookkeeping. A dry run counts and removes nothing.
// Only conversations that HAVE a database are visited (none is made for the sweep).

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

export function convDbRule(L: () => Layout): RetentionRule {
  return {
    name: "conv-db",
    everyHours: 24,
    run(now, o) {
      const l = L();
      const parts = { seen: 0, held: 0, blocked: 0, voice: 0 };
      for (const conv of names(l.conversations)) {
        if (!isConvId(conv) || !existsSync(l.conv(conv).db)) continue;
        const db = convDbAt(l.root, conv);
        parts.seen += trimSeenMail(db, SEEN_MAX, o.dryRun);
        const over = Math.max(0, db.num("SELECT COUNT(*) FROM held_posts") - MAX_HELD);
        parts.held += over;
        if (over > 0 && !o.dryRun) db.run("DELETE FROM held_posts WHERE seq IN (SELECT seq FROM held_posts ORDER BY seq LIMIT ?)", over);
        parts.blocked += pruneBlocked(db, now.getTime(), o.dryRun);
        parts.voice += pruneVoiceNotes(db, now.getTime(), o.dryRun);
      }
      const removed = parts.seen + parts.held + parts.blocked + parts.voice;
      return { removed, freedBytes: 0, notes: `conversation databases: ${parts.seen} seen-mail id(s) past ${SEEN_MAX}, ${parts.held} held post(s) past ${MAX_HELD}, ${parts.blocked} expired block(s), ${parts.voice} voice row(s) past their window` };
    },
  };
}

export const registerConvRules = (): void => registerRetention(convDbRule(() => layout(dataRoot())));
