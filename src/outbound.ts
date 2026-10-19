import type { Kind as MessageKind } from "./messages.ts";
import { settings } from "./settings.ts";
import { clean } from "./sanitize.ts";
import { briefDelivery } from "./brief.ts";
import { BRIEF_FOOTER, BRIEF_FOOTER_NO_MAIL, renderMarkdown, signalSummary, splitSections } from "./markdown.ts";
import type { Messenger, Quote, Target, TextStyle } from "@ted-personal-assistant/messenger";

const LONG_BODY_MIN = 500; // an echo this long that starts a remembered reply is that reply's cut body
const ECHO_WINDOW_MS = settings.echoWindowMinutes * 60_000;

// Longer than the messenger takes as one message (capabilities.maxMessageBytes; Signal has no limit the app sees): cut into parts that each fit,
// at a paragraph, line or word break when there is one in the last half of the part, never inside a character. Styles follow their text.
export function fitParts(r: { text: string; styles: TextStyle[] }, max: number | undefined): { text: string; styles: TextStyle[] }[] {
  if (!max || Buffer.byteLength(r.text) <= max) return [r];
  const parts: { text: string; styles: TextStyle[] }[] = [];
  let from = 0;
  while (from < r.text.length) {
    let to = from;
    for (let bytes = 0; to < r.text.length; ) {
      const cp = r.text.codePointAt(to)!;
      const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (bytes + size > max && to > from) break;
      bytes += size;
      to += cp > 0xffff ? 2 : 1;
    }
    if (to < r.text.length) {
      const slice = r.text.slice(from, to);
      const at = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
      if (at > slice.length / 2) to = from + at;
    }
    const text = r.text.slice(from, to).trimEnd();
    const styles = r.styles.flatMap((s) => {
      const start = Math.max(s.start, from) - from;
      const end = Math.min(s.start + s.length, from + text.length) - from;
      return end > start ? [{ ...s, start, length: end - start }] : [];
    });
    parts.push({ text, styles });
    from = to;
    while (from < r.text.length && /\s/.test(r.text[from]!)) from++;
  }
  return parts;
}

// `record` is told about every message sent (kind, timestamp, text, target if it did not go to the owner's chat): the message log.
export function createOutbound(messenger: Pick<Messenger, "send" | "capabilities">, record?: (kind: MessageKind, ts: number, text: string, target?: Target) => void) {
  // Everything we send to Note to Self comes back to us as an incoming message, and must not
  // be answered. Each message is registered BEFORE sending, by text (the echo can arrive
  // before the send returns its timestamp), then by timestamp. Entries expire after a while.
  const recent = new Map<string, number>(); // key -> expiry (epoch ms)

  function remember(key: string) {
    const now = Date.now();
    for (const [k, expires] of recent) if (expires < now) recent.delete(k);
    recent.set(key, now + ECHO_WINDOW_MS);
  }

  function isOwnEcho(m: { text: string; timestamp: number }): boolean {
    const now = Date.now();
    if ((recent.get(`t:${m.timestamp}`) ?? 0) > now || (recent.get(`x:${m.text}`) ?? 0) > now) return true;
    // A long reply comes back as its cut body (the first part of what was sent; the rest is an attachment): the same text, cut.
    return m.text.length >= LONG_BODY_MIN && [...recent].some(([k, expires]) => expires > now && k.startsWith("x:") && k.length > m.text.length + 2 && k.startsWith(`x:${m.text}`));
  }

  // Sends markdown as styled text. `plain` skips markdown parsing: use it for anything
  // that embeds untrusted text (approval prompts and alerts quote email content).
  // Returns the timestamp of the last message sent (what a reaction would target).
  // `quote` threads the reply under a message (first part only; not at all where the messenger has no quotes). `target` sends to that
  // conversation (a group, another person) instead of the owner's chat; those messages never come back as the owner's, so they are not
  // echo-registered (that would swallow a message of the owner's with the same text).
  async function reply(text: string, opts: { plain?: boolean; quote?: Quote; kind?: MessageKind; target?: Target } = {}): Promise<number> {
    let last = 0;
    let quote = messenger.capabilities.quotes ? opts.quote : undefined;
    // One message, however long, unless the messenger declares a limit (capabilities.maxMessageBytes). A platform without one deals with long
    // text itself: Signal sends text over the official clients' limit (about 2000 characters) as a cut body plus a text attachment, which the
    // phone shows as a preview with "read more".
    if (text.trim()) {
      const whole = opts.plain ? { text: text.trim(), styles: [] } : renderMarkdown(text.trim());
      for (const r of fitParts(whole, messenger.capabilities.maxMessageBytes)) {
        if (!opts.target) remember(`x:${r.text}`);
        last = await messenger.send(opts.target, { text: r.text, styles: r.styles, quote });
        quote = undefined;
        if (!opts.target) remember(`t:${last}`);
        record?.(opts.kind ?? "other", last, r.text, opts.target);
      }
    }
    return last;
  }

  // A voice message (an audio file), to the owner's chat or another conversation. What was said is logged as text, so the log stays searchable.
  async function sendVoice(file: string, spoken: string, target?: Target): Promise<number> {
    const ts = await messenger.send(target, { text: "", attachments: [{ file, kind: "voice" }] });
    if (!target) remember(`t:${ts}`);
    record?.("chat", ts, `🔊 ${spoken}`, target);
    return ts;
  }

  // A picture (a screenshot kept by the browse tool, shots.ts) with an optional caption, to the owner's chat or another conversation.
  async function sendPicture(file: string, caption: string, opts: { quote?: Quote; kind?: MessageKind; target?: Target } = {}): Promise<number> {
    const r = caption ? renderMarkdown(clean("picture caption", caption, { max: 300 })) : { text: "", styles: [] };
    if (!opts.target && r.text) remember(`x:${r.text}`);
    const ts = await messenger.send(opts.target, { text: r.text, styles: r.styles, quote: messenger.capabilities.quotes ? opts.quote : undefined, attachments: [{ file, kind: "picture" }] });
    if (!opts.target) remember(`t:${ts}`);
    record?.(opts.kind ?? "chat", ts, `🖼️ ${r.text || "(picture)"}`, opts.target);
    return ts;
  }

  const replyPlain = (text: string, kind?: MessageKind) => reply(text, { plain: true, kind });

  // The whole brief, one message per section (not used for the daily brief any more: the chat gets
  // the short summary above, the full text goes out by email).
  // The brief itself goes out by email. The chat gets the short version (pep talk, focus, a pointer).
  async function sendBriefSummary(markdown: string) {
    await reply(signalSummary(markdown, briefDelivery() === "email" ? BRIEF_FOOTER : BRIEF_FOOTER_NO_MAIL), { kind: "brief" });
  }

  async function sendBrief(markdown: string) {
    for (const section of splitSections(markdown)) {
      await reply(section, { kind: "brief" });
      await new Promise((r) => setTimeout(r, 400)); // keep delivery order stable
    }
  }

  return { reply, replyPlain, sendVoice, sendPicture, sendBrief, sendBriefSummary, isOwnEcho };
}
