import { authoredPart, cutBody, mailHeader, mailText } from "./format.ts";
import { addrs, attachmentsNamed as attachmentsOf, type MailView } from "./mailview.ts";

export { authoredPart };

// A reply the background handler drafted is shown to the owner on Signal. The owner answers by
// replying to that message ("send", or what to change); the chat agent then finds the draft and
// calls send_message_now, and the APPROVAL for that call shows the draft read back from Mailbird
// at that moment (agent.ts), so what the owner approves is what is sent, whatever the model said.
//
// The draft text is written by a model from an untrusted email, so nothing here trusts the
// model's words: the draft's id is taken from the Mailbird tool RESULT, and recipients and text
// are read back from Mailbird.

export type DraftView = Omit<MailView, "action">;

// Pure: the draft's messageId from a Mailbird tool result (JSON text, or an MCP content array).
export function extractMessageId(response: unknown): number | undefined {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  const m = /messageId\\?"?\s*[:=]\s*\\?"?(\d{1,12})/.exec(text); // also inside a JSON string, where the quotes are escaped
  return m ? Number(m[1]) : undefined;
}

// Pure: Mailbird's get_message result as what we show and check. Recipients are lower-cased.
export function viewDraft(msg: unknown): DraftView | undefined {
  const m = msg as { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; body?: unknown; attachments?: unknown } | null;
  if (!m || typeof m.body !== "string") return undefined;
  return { to: addrs(m.to), cc: addrs(m.cc), bcc: addrs(m.bcc), subject: String(m.subject ?? ""), body: m.body, hasAttachments: Array.isArray(m.attachments) && m.attachments.length > 0, ...attachmentsOf(m.attachments) };
}

// Pure: the Signal text. Shows who it goes to and the whole reply (cut and announced if long).
// The draft id is in it so the chat agent can find the draft when the owner replies to this message.
export function proposalText(d: DraftView, id: number): string {
  return `✉️ Reply ready (draft #${id})\n${mailHeader(d)}\n\n${cutBody(d.body)}\n\nReply to this message with “send” to send it, or say what to change.`;
}

// Pure: the approval prompt for sending a draft, from the draft as the mail client holds it right now.
export const sendApprovalText = (d: DraftView): string => mailText({ action: "send", ...d });
