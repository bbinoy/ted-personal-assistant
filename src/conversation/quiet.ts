import { convDb, peekConvDb } from "../core/convdb.ts";
import { untilOn, untilWords } from "../core/until.ts";
import { convIdOf } from "../core/convpaths.ts";
import type { Conversation } from "./conversationmodel.ts";

// "/quiet": a conversation's own do-not-disturb, set in its chat (ownercommands.ts). While it lasts, unprompted posts and system notices are HELD exactly as in quiet hours (heartbeat/notices.ts:
// the next look gets them when it ends; urgent still goes through), but chat, approvals the owner asked for in chat and the heartbeat's own work carry on, unlike /pause (core/pause.ts), which
// stops unattended work. One row per conversation, in its assistant.db (the `quiet` table): "" = until /unquiet, an ISO time = until then (a time nobody can read is NOT quiet: fail open, a
// missed post is worse than a dropped switch here, and nothing but a post is held). No row = not set.

type Where = Pick<Conversation, "kind"> & { readonly tenantId?: string; readonly groupId?: string; readonly convId?: string };

export const quietValue = (conv: Where): string | undefined => peekConvDb(convIdOf(conv))?.get<{ until: string }>("SELECT until FROM quiet WHERE id = 1")?.until;

export const setQuiet = (conv: Where, until: string): void =>
  void convDb(convIdOf(conv)).run("INSERT INTO quiet (id, until) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET until = excluded.until", until);
export const clearQuiet = (conv: Where): void => void convDb(convIdOf(conv)).run("DELETE FROM quiet WHERE id = 1");

// Is the switch on at `now`? (the one "until" test, core/until.ts; a time nobody can read is NOT quiet)
export const isQuiet = (conv: Where, now: Date): boolean => untilOn(quietValue(conv), now, false);

// For "/status": what the switch says, or undefined when not quiet.
export function quietText(conv: Where, now: Date, zone?: string): string | undefined {
  const s = quietValue(conv);
  return untilOn(s, now, false) ? `quiet ${untilWords(s!, zone)}` : undefined;
}
