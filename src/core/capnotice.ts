import { localDay } from "./pause.ts";
import { readJson, writeJson } from "./state.ts";
import { groupConvId, instancePaths } from "./convpaths.ts";

// Who hears that a daily spend ceiling (budget.ts: INSTANCE_KEY_DAILY_USD for all friends, GROUP_DAILY_BUDGET_USD for one group) was hit: each notice at most ONCE A DAY
// (the local day, like the ceilings themselves), however many messages run into it, kept in instance/cap-notices.json (a group by its convId, never its raw id) so a restart does not repeat it.
//   a friend   one fixed line in her own chat       (tenantrun.ts)
//   the owner  one line in her chat, for the shared key: no friend's name, no word of any friend
//   a group    one short line in that group          (group.ts, only for a message that was addressed to us)
// `due` asks, `mark` records: a notice that could not be delivered (a group's own notice throttle) is not marked, so the next message tries again.

const FILE = instancePaths().capNotices;
interface Seen {
  day: string;
  keys: string[];
  at?: Record<string, number>; // notices throttled by an interval instead of a day (below): key -> when it last went out
}
const today = (now: number): Seen => {
  const day = localDay(new Date(now));
  const s = readJson<Seen | undefined>(FILE, undefined);
  return s?.day === day ? s : { day, keys: [], ...(s?.at ? { at: s.at } : {}) };
};

// The same file for the notices that repeat after an INTERVAL (the shared key's problem every few hours, a group's error notice every few minutes): the time of the last
// one, so a restart does not send it again. Entries older than a day are dropped when one is written (no interval is longer).
export const lastNoticeAt = (key: string): number | undefined => readJson<Seen | undefined>(FILE, undefined)?.at?.[key];
export function markNoticeAt(key: string, now = Date.now()): void {
  const s = today(now);
  const at = Object.fromEntries(Object.entries(s.at ?? {}).filter(([, t]) => now - t < 24 * 3_600_000));
  writeJson(FILE, { ...s, at: { ...at, [key]: now } });
}
export function clearNoticeAt(prefix: string): void {
  const s = readJson<Seen | undefined>(FILE, undefined);
  if (s?.at) writeJson(FILE, { ...s, at: Object.fromEntries(Object.entries(s.at).filter(([k]) => !k.startsWith(prefix))) });
}
// A conversation that is forgotten (a removed friend, a group): its keys go. Returns how many. (Every key of a group carries its convId, never its raw id.)
export function forgetNotices(match: (key: string) => boolean): number {
  const s = readJson<Seen | undefined>(FILE, undefined);
  if (!s) return 0;
  const keys = s.keys.filter((k) => !match(k));
  const at = Object.fromEntries(Object.entries(s.at ?? {}).filter(([k]) => !match(k)));
  const n = s.keys.length - keys.length + Object.keys(s.at ?? {}).length - Object.keys(at).length;
  if (n > 0) writeJson(FILE, { ...s, keys, ...(s.at ? { at } : {}) });
  return n;
}
export const capNoticeDue = (key: string, now = Date.now()): boolean => !today(now).keys.includes(key);
export function markCapNotice(key: string, now = Date.now()): void {
  const s = today(now);
  if (!s.keys.includes(key)) writeJson(FILE, { ...s, keys: [...s.keys, key].slice(-1000) });
}
// Due now, and marked: for a notice that is delivered by the caller's own return value (a friend's reply).
export function takeCapNotice(key: string, now = Date.now()): boolean {
  if (!capNoticeDue(key, now)) return false;
  markCapNotice(key, now);
  return true;
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
