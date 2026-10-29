// One view of an outgoing mail call, whatever the provider: the shape the approval, the judge floor and the audit read. The reading of each provider's
// own arguments is the mail module's (src/modules/mailbird/module.ts, gmail.ts); this file holds only the shape and the helpers they share. Pure, no imports.

export type MailAction = "send" | "reply" | "forward" | "draft";
export interface MailView {
  action: MailAction;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  hasAttachments: boolean;
  attachments?: string[]; // what they are called or where they come from (a name, a mailbird:// address), when the call or the mail client says; the approval shows them
}

// Pure: recipients as lower-case addresses, from strings or {email|address} objects.
export function addrs(v: unknown): string[] {
  return (Array.isArray(v) ? v : v ? [v] : [])
    .map((x) => String((x as { email?: string; address?: string })?.email ?? (x as { address?: string })?.address ?? x).trim().toLowerCase())
    .filter(Boolean);
}

// Pure: the attachments of a call or a draft as short names or addresses, whatever shape the provider gives them (strings, or objects with a filename, name, path, uri, url).
function attachmentNames(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map((x) => {
    if (typeof x === "string" || typeof x === "number") return String(x);
    const o = (x ?? {}) as Record<string, unknown>;
    const n = o.filename ?? o.fileName ?? o.name ?? o.path ?? o.uri ?? o.url ?? o.fileUrl ?? o.id;
    return typeof n === "string" || typeof n === "number" ? String(n) : "(unnamed attachment)";
  });
}

// The attachment names as the optional field of a view (absent when there are none).
export const attachmentsNamed = (v: unknown): { attachments?: string[] } => {
  const a = attachmentNames(v);
  return a.length ? { attachments: a } : {};
};

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
  ...attachmentsNamed(i.attachments),
});

