import { dayIn } from "./timezone.ts";
import { holdFact } from "./ownerfact.ts";
import { instanceDb } from "./instancedb.ts";

// "Told at most once per key per interval", the ONE throttle for every notice: the owner's daily budget line (budget.ts), the shared key's problems and the friends' daily cap (below, as facts for the
// owner's next run: ownerfact.ts), a damaged database, the line to a person Ted cannot serve right now (tenants/errors.ts refusal), a failed run's notice (conversation/delivery.ts). The time of the
// last notice per key is kept in the notices table of instance.db, so a restart does not repeat it. A key is a name of the matter and, where it is about one conversation, its convId (never a raw group id).

// A notice must never take a run down: while the ledger database cannot be used (damaged, busy, full) nothing is "due", so nobody is told twice and nothing throws.
const DAY = 24 * 3_600_000;

/** True when the notice may go out now (and it is marked as told): no earlier one within `everyMs`, or, with no interval, none yet on this local day. */
export function takeCapNotice(key: string, now = Date.now(), everyMs?: number): boolean {
  try {
    const db = instanceDb();
    return db.tx(() => {
      const last = db.get<{ last_at: number }>("SELECT last_at FROM notices WHERE key = ?", key)?.last_at;
      if (last !== undefined && (everyMs === undefined ? dayIn(new Date(last)) === dayIn(new Date(now)) : now - last < everyMs)) return false;
      db.run("DELETE FROM notices WHERE last_at < ?", now - 2 * DAY); // (no interval is longer than a day or two: older marks mean nothing)
      db.run("INSERT INTO notices (key, last_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET last_at = excluded.last_at", key, now);
      return true;
    });
  } catch {
    return false;
  }
}

// A conversation that is forgotten (a removed friend, a group): its keys go. Returns how many.
export function forgetNotices(match: (key: string) => boolean): number {
  const db = instanceDb();
  return db.tx(() => {
    let n = 0;
    for (const r of db.all<{ key: string }>("SELECT key FROM notices")) if (match(r.key)) (db.run("DELETE FROM notices WHERE key = ?", r.key), n++);
    return n;
  });
}

/** Everything told about one conversation (a removed friend, a forgotten group): every key ends with its convId. */
export const forgetNoticesOf = (convId: string): number => forgetNotices((k) => k.endsWith(`:${convId}`));

/** Retention: a mark older than two days means nothing any more (see takeCapNotice). Returns how many went. */
export const pruneNotices = (now = Date.now()): number => instanceDb().run("DELETE FROM notices WHERE last_at < ?", now - 2 * DAY).changes;

// The owner's one notice a day that the friends' shared ceiling (budget.ts INSTANCE_KEY_DAILY_USD) was hit, whichever job ran into it: a fact for her next run, with no word of any friend.
export const instanceCapFact = (limitUsd: number): string => `Friends' shared daily limit of $${limitUsd} is reached, so they are paused until midnight. To lift it today: raise INSTANCE_KEY_DAILY_USD in .env and restart.`;
export function reportInstanceCap(limitUsd: number, now = Date.now()): boolean {
  if (!takeCapNotice("owner:instance", now)) return false;
  holdFact(instanceCapFact(limitUsd), new Date(now));
  return true;
}
