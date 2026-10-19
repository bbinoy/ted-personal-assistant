import type { Source } from "./audit.ts";
import { addrs } from "./mailview.ts";

// The Gmail connector's rules that a manifest flag cannot say (all pure; policy.ts and permissions.ts call them). The connector's tools
// are named mcp__claude_ai_Gmail__*; their arguments are camelCase (labelIds, messageFormat, ...).

export const GMAIL_PREFIX = "mcp__claude_ai_Gmail__";
export const isGmailTool = (tool: string): boolean => tool.startsWith(GMAIL_PREFIX);
const name = (tool: string) => tool.slice(GMAIL_PREFIX.length);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => String(x));

// Every label value a call names, whatever the tool calls the field.
export function labelValues(input: Record<string, unknown>): string[] {
  return [...strings(input.labelIds), ...strings(input.addLabelIds), ...strings(input.removeLabelIds), ...strings(input.labelOption), ...strings(input.labelId), ...strings(input.label)];
}

// TRASH and SPAM are never a label value, however a tool is asked to set or clear them (adding trashes, removing untrashes).
export const sensitiveLabel = (input: Record<string, unknown>): boolean => labelValues(input).some((l) => /^\s*(trash|spam)\s*$/i.test(l));

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

// Tools that must never run, however they are asked: attachment content, sensitive labels, labels deleted or renamed.
const NEVER = /attachment|download|apply_sensitive|batch_|delete_label|update_label/i;

export type GmailVerdict = "allow" | "ask" | "deny";

// A verdict for a Gmail tool call, or undefined to let the manifest decide. `archiveLive`: GMAIL_ARCHIVE_LIVE.
export function gmailVerdict(tool: string, input: Record<string, unknown>, source: Source, o: { archiveLive: boolean; self: string | undefined; briefEmail: boolean }): GmailVerdict | undefined {
  if (!isGmailTool(tool)) return undefined;
  if (NEVER.test(name(tool))) return "deny";
  if (sensitiveLabel(input)) return "deny";
  if (/^raw$/i.test(String(input.messageFormat ?? ""))) return "deny"; // raw MIME carries attachment content
  if (name(tool) === "unlabel_thread") {
    if (!isInboxArchive(tool, input)) return "ask"; // other label removals (UNREAD, a user label) are the owner's call
    return o.archiveLive ? undefined : "deny"; // log-only: recorded as would-archive (permissions.ts), not done
  }
  if (source === "brief" && o.briefEmail && isSelfSend(tool, input, o.self)) return "allow";
  return undefined;
}
