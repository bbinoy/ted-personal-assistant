import { authoredPart, mailText } from "./approvals/format.ts";
import { addrs, attachmentsNamed as attachmentsOf, type MailView } from "./policy/mailview.ts";

export { authoredPart };

// The APPROVAL for sending a draft shows the draft read back from the mail client at that moment (permissions.ts), so what the owner approves is what is sent, whatever
// the model said. The draft text is written by a model from an untrusted email, so nothing here trusts the model's words: recipients and text are read back from the client.

export type DraftView = Omit<MailView, "action">;

// Pure: Mailbird's get_message result as what we show and check. Recipients are lower-cased.
export function viewDraft(msg: unknown): DraftView | undefined {
  const m = msg as { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; body?: unknown; attachments?: unknown } | null;
  if (!m || typeof m.body !== "string") return undefined;
  return { to: addrs(m.to), cc: addrs(m.cc), bcc: addrs(m.bcc), subject: String(m.subject ?? ""), body: m.body, hasAttachments: Array.isArray(m.attachments) && m.attachments.length > 0, ...attachmentsOf(m.attachments) };
}

// Pure: the approval prompt for sending a draft, from the draft as the mail client holds it right now.
export const sendApprovalText = (d: DraftView): string => mailText({ action: "send", ...d });
