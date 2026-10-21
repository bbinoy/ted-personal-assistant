import { authoredPart } from "./format.ts";
import { clip } from "../core/sanitize.ts";

// The footer of every question on the owner's phone, rendered by CODE from the code-built details of the call (format.ts; for a mail send the draft as the mail
// client holds it), never by the model: a model-written question may describe a reply carrying a 2FA code as "a short thank-you", so who gets it, what is attached
// and how the text starts are always shown as the code read them. Compact, one line each; whatever is cut is announced (clip). Pure.

const BODY_CHARS = 300;
const HEADER = /^(To|Cc|Bcc|With|Attachments):\s*(.+)$/;
const TEXT_LABELS = /^(Message|Notes):\s*(.+)$/;
const MAIL = /^✉️/;
const QUOTED_NOTE = /\n*\(the quoted original follows below it in the email\)\s*$/;

export function questionFooter(details: string): string {
  const lines = details.split("\n");
  const mail = MAIL.test(lines[0] ?? "");
  const rows: string[] = [];
  let text: string | undefined;
  if (mail) {
    const blank = lines.indexOf("");
    for (const l of lines.slice(1, blank < 0 ? undefined : blank)) {
      const h = HEADER.exec(l);
      if (h) rows.push(`${h[1]}: ${clip(h[2]!, 1000)}`);
    }
    if (blank >= 0) text = authoredPart(lines.slice(blank + 1).join("\n").replace(QUOTED_NOTE, "")).text;
  } else {
    for (const l of lines.slice(1)) {
      const h = HEADER.exec(l);
      if (h) rows.push(`${h[1]}: ${clip(h[2]!, 1000)}`);
      else text ??= TEXT_LABELS.exec(l)?.[2];
    }
  }
  if (text?.trim()) rows.push(`Text: “${clip(text, BODY_CHARS)}”`);
  return rows.length ? `\n\n— exactly what will go —\n${rows.join("\n")}` : "";
}
