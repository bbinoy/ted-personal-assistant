import { localDay } from "./pause.ts";
import { groupConvId } from "./convpaths.ts";
import { instanceDb } from "./instancedb.ts";

// Who hears that a daily spend ceiling (budget.ts: INSTANCE_KEY_DAILY_USD for all friends, GROUP_DAILY_BUDGET_USD for one group) was hit: each notice at most ONCE A DAY
// (the local day, like the ceilings themselves), however many messages run into it, kept in the notices table of instance.db (a group by its convId, never its raw id) so a restart does not repeat it.
//   a friend   one fixed line in her own chat       (tenantrun.ts)
//   the owner  one line in her chat, for the shared key: no friend's name, no word of any friend
//   a group    one short line in that group          (group.ts, only for a message that was addressed to us)
// `due` asks, `mark` records: a notice that could not be delivered (a group's own notice throttle) is not marked, so the next message tries again.
// A row is (key, day, last_at): `day` for the once-a-day notices, `last_at` for the ones throttled by an interval (below); a key uses one of them.

// A notice must never take a run down: while the ledger database cannot be used (damaged, busy, full) a notice is "not due" and a mark is dropped, so nobody is told twice and nothing throws.
const quiet = <T>(f: () => T, fallback: T): T => {
  try {
    return f();
  } catch {
    return fallback;
  }
};

// The notices that repeat after an INTERVAL (the shared key's problem every few hours, a group's error notice every few minutes): the time of the last
// one, so a restart does not send it again. Entries older than a day are dropped when one is written (no interval is longer).
export const lastNoticeAt = (key: string): number | undefined => quiet(() => instanceDb().get<{ last_at: number | null }>("SELECT last_at FROM notices WHERE key = ?", key)?.last_at ?? undefined, undefined);
export function markNoticeAt(key: string, now = Date.now()): void {
  quiet(() => {
  const db = instanceDb();
  db.tx(() => {
    db.run("DELETE FROM notices WHERE day IS NULL AND last_at IS NOT NULL AND last_at < ?", now - 24 * 3_600_000);
    db.run("INSERT INTO notices (key, last_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET last_at = excluded.last_at", key, now);
  });
  }, undefined);
}
export function clearNoticeAt(prefix: string): void {
  quiet(() => clearNoticeAtNow(prefix), undefined);
}
function clearNoticeAtNow(prefix: string): void {
  const db = instanceDb();
  const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  db.tx(() => {
    db.run("UPDATE notices SET last_at = NULL WHERE last_at IS NOT NULL AND key LIKE ? ESCAPE '\\'", like);
    db.run("DELETE FROM notices WHERE day IS NULL AND last_at IS NULL");
  });
}
// A conversation that is forgotten (a removed friend, a group): its keys go. Returns how many. (Every key of a group carries its convId, never its raw id.)
export function forgetNotices(match: (key: string) => boolean): number {
  const db = instanceDb();
  const today = localDay(new Date());
  return db.tx(() => {
    let n = 0;
    for (const r of db.all<{ key: string; day: string | null; last_at: number | null }>("SELECT key, day, last_at FROM notices")) {
      if (!match(r.key)) continue;
      if (r.day === today) n++;
      if (r.last_at !== null) n++;
      db.run("DELETE FROM notices WHERE key = ?", r.key);
    }
    return n;
  });
}
export const capNoticeDue = (key: string, now = Date.now()): boolean => quiet(() => instanceDb().get<{ day: string | null }>("SELECT day FROM notices WHERE key = ?", key)?.day !== localDay(new Date(now)), false);
export function markCapNotice(key: string, now = Date.now()): void {
  quiet(() => instanceDb().run("INSERT INTO notices (key, day) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET day = excluded.day", key, localDay(new Date(now))), undefined);
}
// Due now, and marked: for a notice that is delivered by the caller's own return value (a friend's reply).
export function takeCapNotice(key: string, now = Date.now()): boolean {
  return quiet(() => takeNow(key, now), false);
}
function takeNow(key: string, now: number): boolean {
  const db = instanceDb();
  return db.tx(() => {
    if (!capNoticeDue(key, now)) return false;
    markCapNotice(key, now);
    return true;
  });
}

/** Retention: rows of a past day, or an interval notice older than a day, mean nothing any more (a once-a-day notice is due again anyway). Returns how many went. */
export function pruneNotices(now = Date.now()): number {
  return instanceDb().run("DELETE FROM notices WHERE (day IS NULL OR day < ?) AND (last_at IS NULL OR last_at < ?)", localDay(new Date(now)), now - 24 * 3_600_000).changes;
}

// ---- the texts (fixed; no name, no word of anybody) ----

export const FRIEND_CAP_TEXT = "I've hit today's shared limit, so I'm resting until tomorrow. Your message is saved.";
export const GROUP_CAP_TEXT = "I've reached today's limit for this group, back tomorrow.";
export const ownerCapText = (limitUsd: number): string => `Friends' shared daily limit of $${limitUsd} reached; they're paused until midnight. To lift it today, raise INSTANCE_KEY_DAILY_USD in .env and restart.`;

// The owner's one notice a day about the shared key's ceiling (main.ts wires `sendTo` to her chat, like keynotice.ts). Returns whether it was sent. Never throws.
let ownerSend: ((text: string) => void) | undefined;
export const capNoticesTo = (send: ((text: string) => void) | undefined): void => void (ownerSend = send);
export function reportInstanceCap(limitUsd: number, now = Date.now()): boolean {
  if (!ownerSend || !capNoticeDue("owner:instance", now)) return false;
  markCapNotice("owner:instance", now);
  try {
    ownerSend(ownerCapText(limitUsd));
  } catch {
    /* a notice that cannot be sent is not a reason to fail a run */
  }
  return true;
}

// For group.ts: is this group at its ceiling, and if a message was addressed to us, say so once a day in the group. `say` returns whether the line was posted.
export async function groupCapped(over: boolean, addressed: boolean, groupId: string, say: () => Promise<boolean>, now = Date.now()): Promise<boolean> {
  if (!over) return false;
  const key = `group:${groupConvId(groupId)}`;
  if (addressed && capNoticeDue(key, now) && (await say().catch(() => false))) markCapNotice(key, now);
  return true;
}
