import { localDay } from "./pause.ts";
import { readJson, writeJson } from "./state.ts";

// Who hears that a daily spend ceiling (budget.ts: INSTANCE_KEY_DAILY_USD for all friends, GROUP_DAILY_BUDGET_USD for one group) was hit: each notice at most ONCE A DAY
// (the local day, like the ceilings themselves), however many messages run into it, kept in state/cap-notices.json so a restart does not repeat it.
//   a friend   one fixed line in her own chat       (tenantrun.ts)
//   the owner  one line in her chat, for the shared key: no friend's name, no word of any friend
//   a group    one short line in that group          (group.ts, only for a message that was addressed to us)
// `due` asks, `mark` records: a notice that could not be delivered (a group's own notice throttle) is not marked, so the next message tries again.

const FILE = "state/cap-notices.json";
interface Seen {
  day: string;
  keys: string[];
}
const today = (now: number): Seen => {
  const day = localDay(new Date(now));
  const s = readJson<Seen | undefined>(FILE, undefined);
  return s?.day === day ? s : { day, keys: [] };
};
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
  if (addressed && capNoticeDue(`group:${groupId}`, now) && (await say().catch(() => false))) markCapNotice(`group:${groupId}`, now);
  return true;
}
