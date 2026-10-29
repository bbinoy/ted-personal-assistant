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
