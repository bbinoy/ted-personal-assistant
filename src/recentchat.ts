import { foldEdits, ledgerEntries, withoutDeleted } from "./messages.ts";
import type { Recent } from "./approvalprompt.ts";
import { OWNER_KEY } from "./send.ts";

// The last few lines of the owner's chat, for the approval judge and the question writer: what the owner said and what the
// assistant told them, oldest first. Approval questions themselves are left out (the judge gets those separately), and so is the
// message being judged (it is already in the log by then).
const OWNER_KINDS = new Set(["owner"]);
const ASSISTANT_KINDS = new Set(["chat", "notice", "draft", "brief"]);

export function recentChat(current?: string, keep = 5): Recent[] {
  const lines = foldEdits(withoutDeleted(ledgerEntries()))
    .filter((m) => OWNER_KINDS.has(m.kind) || ASSISTANT_KINDS.has(m.kind))
    .map((m): Recent => ({ from: OWNER_KINDS.has(m.kind) ? "owner" : "assistant", text: m.text }));
  const last = lines[lines.length - 1];
  if (current !== undefined && last?.from === "owner" && last.text === current) lines.pop();
  return lines.slice(-keep);
}

// The same for the conversation a question is asked in. Only the owner's chat has a log this module reads; any other conversation
// has none, so one person's words never reach another's approval prompt.
export const recentIn = (key: string, current?: string): Recent[] => (key === OWNER_KEY ? recentChat(current) : []);
