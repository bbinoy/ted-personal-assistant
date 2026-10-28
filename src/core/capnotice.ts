import { pruneTold, told } from "./told.ts";
import { holdFact } from "./ownerfact.ts";
import { instanceDb } from "./instancedb.ts";

// "Told at most once per key per interval", the ONE throttle for every notice: the owner's daily budget line (budget.ts), the shared key's problems and the friends' daily cap (below, as facts for the
// owner's next run: ownerfact.ts), a damaged database, the line to a person Ted cannot serve right now (tenants/errors.ts refusal), a failed run's notice (conversation/delivery.ts). The time of the
// last notice per key is kept in the told table of instance.db (core/told.ts), so a restart does not repeat it. A key is a name of the matter and, where it is about one conversation, its convId (never a raw group id).

// A notice must never take a run down: while the ledger database cannot be used (damaged, busy, full) nothing is "due", so nobody is told twice and nothing throws.

/** True when the notice may go out now (and it is marked as told): no earlier one within `everyMs`, or, with no interval, none yet on this local day. The instance-wide use of core/told.ts. */
export function takeCapNotice(key: string, now = Date.now(), everyMs?: number): boolean {
  try {
    const db = instanceDb();
    return db.tx(() => {
      pruneTold(db, now);
      return told(db, key, everyMs === undefined ? { perDay: true } : { everyMs }, now);
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
    for (const r of db.all<{ key: string }>("SELECT key FROM told")) if (match(r.key)) (db.run("DELETE FROM told WHERE key = ?", r.key), n++);
    return n;
  });
}

/** Everything told about one conversation (a removed friend, a forgotten group): every key ends with its convId. */
export const forgetNoticesOf = (convId: string): number => forgetNotices((k) => k.endsWith(`:${convId}`));

/** Retention: a mark older than two days means nothing any more (see core/told.ts). Returns how many went. */
export const pruneNotices = (now = Date.now()): number => pruneTold(instanceDb(), now);

// The owner's one notice a day that the friends' shared ceiling (budget.ts INSTANCE_KEY_DAILY_USD) was hit, whichever job ran into it: a fact for her next run, with no word of any friend.
export const instanceCapFact = (limitUsd: number): string => `Friends' shared daily limit of $${limitUsd} is reached, so they are paused until midnight. To lift it today: raise INSTANCE_KEY_DAILY_USD in .env and restart.`;
export function reportInstanceCap(limitUsd: number, now = Date.now()): boolean {
  if (!takeCapNotice("owner:instance", now)) return false;
  holdFact(instanceCapFact(limitUsd), new Date(now));
  return true;
}
