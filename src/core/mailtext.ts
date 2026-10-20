import { htmlToText, looksLikeHtml } from "./html.ts";
import { clean, LIMITS } from "./sanitize.ts";

// A mail body as the text a reader would see: HTML reduced to its visible text (html.ts), then cleaned and capped (sanitize.ts).
export function mailBody(raw: string): string {
  let text = raw;
  if (looksLikeHtml(raw)) {
    const h = htmlToText(raw);
    if (h.hidden) console.log(`clean: mail body: left out ${h.hidden} hidden HTML part(s)`);
    text = h.text;
  }
  return clean("mail body", text, { max: LIMITS.body });
}
