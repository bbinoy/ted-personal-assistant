import type { Db } from "./db.ts";
import { dayIn } from "./timezone.ts";

// "Told X": the ONE record of a notice that goes out once, at most once a day, or at most once in a while. A `told` table (key, when, once) in the database the matter belongs to: instance.db for what
// is about the whole install (core/capnotice.ts: the budget line, a friend's cap, a refusal), a conversation's assistant.db for what is about that conversation (tasks/grouptasks.ts: a member told once
// that a reminder said in a group is the group's). Code decides WHETHER to tell and records it; the run writes the words. A key is a name of the matter and, where it is about one conversation in
// instance.db, ends with its convId (never a raw group id), so forgetting the conversation can find it.
//
// NOT this: the claim-then-done facts (a reminder, a meeting prep, a routine period are claimed BEFORE the send so they run at most once; they have states and retries) and the dream's day.

export type TellRule = { once: true } | { perDay: true; zone?: string } | { everyMs: number };

/** True when the notice may go out now, and it is recorded as told: `once` never again, `perDay` not again on the same local day (in `zone`, default the process's), `everyMs` not again within that time. */
export function told(db: Db, key: string, rule: TellRule, now = Date.now()): boolean {
  return db.tx(() => {
    const last = db.get<{ at: number }>("SELECT at FROM told WHERE key = ?", key)?.at;
    if (last !== undefined) {
      if ("once" in rule) return false;
      if ("everyMs" in rule ? now - last < rule.everyMs : dayIn(new Date(last), rule.zone) === dayIn(new Date(now), rule.zone)) return false;
    }
    db.run("INSERT INTO told (key, at, once) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at, once = excluded.once", key, now, "once" in rule ? 1 : 0);
    return true;
  });
}

const DAY = 24 * 3_600_000;
/** Forget the marks that mean nothing any more: a `perDay` or `everyMs` mark older than two days (no interval is longer). A `once` mark stays for good. Returns how many went. */
export const pruneTold = (db: Db, now = Date.now()): number => db.run("DELETE FROM told WHERE once = 0 AND at < ?", now - 2 * DAY).changes;
