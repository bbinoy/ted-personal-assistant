import { convDb } from "./convdb.ts";
import { OWNER_CONV } from "./convpaths.ts";
import { OWNER } from "./settings.ts";

// ONE way to tell the owner about a system problem: a FACT for her next look or chat turn. The model says it in its own words, and only if she has to do something (CLAUDE.md: Ted
// speaks, code doesn't). It is kept like a held post (the owner's `held_posts` table; heartbeat/notices.ts takeHeld hands it over once, when quiet is over), so it works from any folder
// that may import the core: the shared key (tenants/keynotice.ts), the friends' daily cap (core/capnotice.ts), a damaged database (heartbeat/notices.ts). The one fixed-text exception
// for the owner is the daily budget notice (heartbeat/notices.ts): over budget no run is possible.

export const MAX_HELD = 30; // a flood is dropped oldest first: this is a handover to the next look, not an archive (a retention rule, heartbeat/convretention.ts, keeps the same bound)

// Held for the owner's next look, once while it waits (the same text is not added twice). The caller throttles how often a matter is raised (capnotice.ts takeCapNotice). Never throws.
export function holdFact(text: string, now: Date = new Date()): void {
  try {
    const fact = `System status for ${OWNER}: say it in one short line in your own words, only if ${OWNER} has to do something. ${text}`;
    const db = convDb(OWNER_CONV);
    db.tx(() => {
      if (db.num("SELECT COUNT(*) FROM held_posts WHERE text = ?", fact) > 0) return;
      db.run("INSERT INTO held_posts (text, why, at) VALUES (?, 'quiet', ?)", fact, now.getTime());
      db.run("DELETE FROM held_posts WHERE seq NOT IN (SELECT seq FROM held_posts ORDER BY seq DESC LIMIT ?)", MAX_HELD);
    });
  } catch (e) {
    console.error("notices: could not keep a fact for the owner:", (e as Error).message);
  }
}
