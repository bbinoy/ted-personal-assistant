import { convDb } from "./convdb.ts";
import { OWNER_CONV } from "./convpaths.ts";
import { instanceDb } from "./instancedb.ts";
import { OWNER } from "./settings.ts";
import { pruneTold, told, type TellRule } from "./told.ts";

// The ONE way to tell the owner about a matter at most once, once a day or once in a while: `notify(key, rule, text)` marks the key as told (core/told.ts, in instance.db, so a restart does not repeat it)
// and, when the matter is due, keeps `text` as a FACT for her next look or chat turn: the model says it in its own words, and only if she has to do something (CLAUDE.md: Ted speaks, code doesn't). The fact
// is kept like a held post (the owner's `held_posts` table; heartbeat/notices.ts takeHeld hands it over once, when quiet is over), so it works from any folder that may import the core. Without `text` it is only
// the throttle (a line a person is told in chat: tenants/errors.ts refusals, a failed run's notice in conversation/delivery.ts). A key is a name of the matter and, where it is about one conversation, ends
// with its convId (never a raw group id), so forgetNotices finds it. The one fixed-text exception for the owner is the daily budget notice (heartbeat/notices.ts): over budget no run is possible.

export const MAX_HELD = 30; // a flood is dropped oldest first: this is a handover to the next look, not an archive (a retention rule, heartbeat/convretention.ts, keeps the same bound)

// Held for the owner's next look, once while it waits (the same text is not added twice). Never throws.
export function holdFact(text: string, now = Date.now()): boolean {
  try {
    const fact = `System status for ${OWNER}: say it in one short line in your own words, only if ${OWNER} has to do something. ${text}`;
    const db = convDb(OWNER_CONV);
    db.tx(() => {
      if (db.num("SELECT COUNT(*) FROM held_posts WHERE text = ?", fact) > 0) return;
      db.run("INSERT INTO held_posts (text, why, at) VALUES (?, 'quiet', ?)", fact, now);
      db.run("DELETE FROM held_posts WHERE seq NOT IN (SELECT seq FROM held_posts ORDER BY seq DESC LIMIT ?)", MAX_HELD);
    });
    return true;
  } catch (e) {
    console.error("notices: could not keep a fact for the owner:", (e as Error).message);
    return false;
  }
}

/**
 * True when the matter was due now (it is marked as told and its `text`, if any, held as a fact), false when it was told already within `rule`, undefined when it could not be kept at all (the store is
 * damaged, busy or full). Never throws: a notice must never take a run down. `conv` is whose assistant.db holds the mark (default instance.db; a start-up problem uses the owner's, because instance.db
 * may be the damaged store itself, and sends its fixed line only on undefined).
 */
export function notify(key: string, rule: TellRule, text?: string, now = Date.now(), conv?: string): boolean | undefined {
  try {
    const d = conv === undefined ? instanceDb() : convDb(conv);
    const due = d.tx(() => (pruneTold(d, now), told(d, key, rule, now)));
    return due && text !== undefined && !holdFact(text, now) ? undefined : due;
  } catch {
    return undefined;
  }
}

/** Everything told about one conversation (a removed friend, a forgotten group): every key ends with its convId. Returns how many. */
export const forgetNotices = (convId: string): number => {
  const end = `:${convId}`;
  return instanceDb().run("DELETE FROM told WHERE substr(key, -?) = ?", end.length, end).changes;
};

/** Retention: a mark older than two days means nothing any more (see core/told.ts). Returns how many went. */
export const pruneNotices = (now = Date.now()): number => pruneTold(instanceDb(), now);
