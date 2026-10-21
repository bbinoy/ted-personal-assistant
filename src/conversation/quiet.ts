import { dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { dataPath, readText, writeText } from "../core/state.ts";
import { timeIn } from "../core/timezone.ts";
import { tenantById, tenantContext } from "../tenants/tenants.ts";
import type { Conversation } from "./conversationmodel.ts";

// "/quiet": a conversation's own do-not-disturb, set in its chat (ownercommands.ts). While it lasts, unprompted posts and system notices are HELD exactly as in quiet hours (heartbeat/notices.ts:
// they go out in the digest when it ends; urgent still goes through), but chat, approvals the owner asked for in chat and the heartbeat's own work carry on, unlike /pause (core/pause.ts), which
// stops unattended work. One small file per conversation, next to its other bookkeeping: "" = until /unquiet, an ISO time = until then (a time nobody can read is NOT quiet: fail open, a
// missed post is worse than a dropped switch here, and nothing but a post is held).

type Where = Pick<Conversation, "kind" | "sessionFile"> & { readonly tenantId?: string };

// state/<name> for the owner, the friend's own folder (or the session file's) for the rest.
export function siblingFile(conv: Where, name: string): string {
  if (conv.kind === "owner") return `state/${name}`;
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  return join(rec ? tenantContext(rec).dir : dirname(conv.sessionFile), name);
}
export const quietFileOf = (conv: Where): string => siblingFile(conv, "quiet.json");

export const setQuiet = (conv: Where, until: string): void => writeText(quietFileOf(conv), until);
export const clearQuiet = (conv: Where): void => rmSync(dataPath(quietFileOf(conv)), { force: true });

// Pure: is the stored switch on at `now`?
export function quietOn(stored: string | undefined, now: Date): boolean {
  const until = stored?.trim();
  if (until === undefined) return false;
  if (until === "") return true;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now.getTime();
}
export const isQuiet = (conv: Where, now: Date): boolean => quietOn(readText(quietFileOf(conv)), now);

// For "/status": what the switch says, or undefined when not quiet.
export function quietText(conv: Where, now: Date, zone?: string): string | undefined {
  const stored = readText(quietFileOf(conv));
  if (!quietOn(stored, now)) return undefined;
  const until = stored!.trim();
  return until === "" ? "quiet until you say /unquiet" : `quiet until ${timeIn(new Date(until), zone)}`;
}
