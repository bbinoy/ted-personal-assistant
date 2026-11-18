import { foldEdits, kindIs, ledgerEntries, withoutDeleted } from "../core/messages.ts";
import type { Recent } from "./approvalprompt.ts";
import { convIdOfKey, convPaths } from "../core/convpaths.ts";
import { kindOfKey } from "../core/ownerkey.ts";

// The last few lines of a private chat (the owner's, or a friend's: `logFile`), for the approval judge and the question writer: what the person said and what the
// assistant told them, oldest first. Approval questions themselves are left out (the judge gets those separately), and so is the
// message being judged (it is already in the log by then).
const isAssistant = (kind: string) => kindIs(kind, "said") && kind !== "approval";

function recentChat(current?: string, keep = 5, logFile?: string): Recent[] {
  const lines = foldEdits(withoutDeleted(ledgerEntries(logFile)))
    .filter((m) => kindIs(m.kind, "inbound") || isAssistant(m.kind))
    .map((m): Recent => ({ from: kindIs(m.kind, "inbound") ? "owner" : "assistant", text: m.text }));
  const last = lines[lines.length - 1];
  if (current !== undefined && last?.from === "owner" && last.text === current) lines.pop();
  return lines.slice(-keep);
}

// The same for the conversation a question is asked in: every private one-to-one chat reads its own log (convPaths: the owner's, a friend's folder), so a friend's approval
// prompt knows what she just said as the owner's does. A group has none by rule (its members' words are not one person's request), and a conversation never reads
// another's log, so one person's words never reach another's approval prompt.
export function recentIn(key: string, current?: string): Recent[] {
  return kindOfKey(key) === "group" ? [] : recentChat(current, 5, convPaths(convIdOfKey(key)).messages);
}

// When did Ted last say anything in this conversation (the timestamp of his newest message of any kind, a question included)? An unquoted "yes" answers a question only if it is
// that message (approvals.ts); `skip`: timestamps left out (a registration question). undefined: nothing logged or the log cannot be read (the caller then fails closed). Every chat, a group and a friend's too, has its own log.
export function latestSaid(key: string, skip: ReadonlySet<number> = new Set()): number | undefined {
  const said = ledgerEntries(convPaths(convIdOfKey(key)).messages).filter((m) => kindIs(m.kind, "said") && !skip.has(m.ts));
  return said[said.length - 1]?.ts;
}
