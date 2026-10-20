import { addrs } from "../../policy/mailview.ts";
import { destinationIsTrashOrSpam } from "../../policy/neverallowed.ts";

// The Gmail connector's rules that a manifest flag cannot say (all pure; policy.ts and permissions.ts call them). The connector's tools
// are named mcp__claude_ai_Gmail__*; their arguments are camelCase (labelIds, messageFormat, ...).

export const GMAIL_PREFIX = "mcp__claude_ai_Gmail__";
export const isGmailTool = (tool: string): boolean => tool.startsWith(GMAIL_PREFIX);
const name = (tool: string) => tool.slice(GMAIL_PREFIX.length);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => String(x));

// An archive in Gmail is removing the INBOX label from a thread, and nothing else in the same call.
export function isInboxArchive(tool: string, input: Record<string, unknown>): boolean {
  if (tool !== GMAIL_PREFIX + "unlabel_thread") return false;
  const ids = strings(input.labelIds);
  return ids.length === 1 && ids[0]!.trim().toUpperCase() === "INBOX" && typeof input.threadId === "string" && input.threadId.trim() !== "";
}

// The brief to the owner themself: one plain recipient that IS the configured address, nothing else on the mail, no draft, no thread to
// attach to, no attachment. Anything else is not a send-to-self and takes the normal approval.
export function isSelfSend(tool: string, input: Record<string, unknown>, self: string | undefined): boolean {
  if (tool !== GMAIL_PREFIX + "send_message" || !self) return false;
  const me = self.trim().toLowerCase();
  const to = Array.isArray(input.to) ? input.to : [input.to];
  const none = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0);
  return (
    to.length === 1 &&
    typeof to[0] === "string" &&
    to[0].trim().toLowerCase() === me && // a plain address: no display name, no second address in the string
    addrs(input.to).length === 1 &&
    none(input.cc) &&
    none(input.bcc) &&
    none(input.attachments) &&
    !input.draftId &&
    !input.replyThreadId &&
    !input.replyToMessageId
  );
}

// Tools this connector must never run, beyond the never-allowed set (neverallowed.ts: trash, delete, spam, block): attachment content, sensitive labels,
// labels renamed. (The names of its trash, spam and delete tools are rows of the Gmail module.)
const NEVER = /attachment|download|apply_sensitive|batch_|update_label/i;

export type GmailVerdict = "ask" | "deny";

// A restriction for a Gmail tool call, or undefined to let the manifest decide. It never grants: the brief to oneself
// is a `freeWhen` of the module's send action (modules/gmail.ts), not a verdict.
export function gmailVerdict(tool: string, input: Record<string, unknown>): GmailVerdict | undefined {
  if (!isGmailTool(tool)) return undefined;
  if (NEVER.test(name(tool))) return "deny";
  if (destinationIsTrashOrSpam(input)) return "deny";
  if (/^raw$/i.test(String(input.messageFormat ?? ""))) return "deny"; // raw MIME carries attachment content
  if (name(tool) === "unlabel_thread") {
    return isInboxArchive(tool, input) ? undefined : "ask"; // other label removals (UNREAD, a user label) are the owner's call
  }
  return undefined;
}
