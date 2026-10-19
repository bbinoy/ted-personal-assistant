// One view of an outgoing mail call, whatever the provider: the shape the approval, the judge floor and the audit read. The reading of each provider's
// own arguments is the mail module's (src/modules/mailbird.ts, gmail.ts); this file holds only the shape and the helpers they share. Pure, no imports.

export type MailAction = "send" | "reply" | "forward" | "draft";
export interface MailView {
  action: MailAction;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  hasAttachments: boolean;
}

// Pure: recipients as lower-case addresses, from strings or {email|address} objects.
export function addrs(v: unknown): string[] {
  return (Array.isArray(v) ? v : v ? [v] : [])
    .map((x) => String((x as { email?: string; address?: string })?.email ?? (x as { address?: string })?.address ?? x).trim().toLowerCase())
    .filter(Boolean);
}

export type MailInput = Record<string, unknown>;

// A view read straight from the call's own arguments (to, cc, bcc, subject, body, attachments).
export const nativeView = (action: MailAction, i: MailInput): MailView => ({
  action,
  to: addrs(i.to),
  cc: addrs(i.cc),
  bcc: addrs(i.bcc),
  subject: String(i.subject ?? ""),
  body: String(i.body ?? i.htmlBody ?? i.forwardText ?? ""),
  hasAttachments: Array.isArray(i.attachments) && i.attachments.length > 0,
});
