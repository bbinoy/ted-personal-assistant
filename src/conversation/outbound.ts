import type { Kind as MessageKind } from "../core/messages.ts";
import { clean } from "../core/sanitize.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Messenger, Quote, Target, TextStyle } from "@ted-assistant/messenger";

const LONG_BODY_MIN = 500; // an echo this long that starts a remembered reply is that reply's cut body
const ECHO_WINDOW_MS = 5 * 60_000; // our own sent text coming back within this long is an echo, not the owner

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

// A failed send is retried only when the error proves nothing went out (at-most-once: a rare missing message beats regular duplicates):
//   - "refused": the connection was not up, nothing was written: retried twice, after 2 s and 6 s;
//   - "unsure": a timeout or a connection lost with the request in flight: the messenger may well have sent it. Never retried; one log line, the error reaches the caller;
//   - anything else (signal-cli refused it: bad attachment, unknown group, a user error): not retried, the error reaches the caller.
// signal-cli's JSON-RPC has no call to ask afterwards whether a timed-out send went out (only a later sync of our own message, not reliably matchable), so none is built.
export type SendFailure = "refused" | "unsure" | "permanent";
export function classifySendError(e: unknown): SendFailure {
  const m = e instanceof Error ? e.message : String(e);
  if (/not connected|is closed|ECONNREFUSED|EPIPE/i.test(m) && !/timed out/i.test(m)) return "refused";
  if (/timed out|socket closed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(m)) return "unsure";
  return "permanent";
}
const BACKOFF_MS = [2_000, 6_000];
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// `record` is told about every message sent (kind, timestamp, text, target if it did not go to the owner's chat): the message log.
export function createOutbound(
  messenger: Pick<Messenger, "send" | "capabilities">,
  record?: (kind: MessageKind, ts: number, text: string, target?: Target) => void,
  retry: { backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
) {
  const backoff = retry.backoffMs ?? BACKOFF_MS;
  const sleep = retry.sleep ?? sleepMs;
  // messenger.send with the retry rule above.
  async function send(target: Target | undefined, message: Parameters<Messenger["send"]>[1]): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await messenger.send(target, message);
      } catch (e) {
        const kind = classifySendError(e);
        if (kind === "unsure") console.error(`outbound: send outcome unknown (${(e as Error).message}); not retried, it may have gone out`);
        if (kind !== "refused" || attempt >= backoff.length) throw e;
        console.error(`outbound: send failed (${(e as Error).message}); retrying in ${backoff[attempt]! / 1000}s`);
        await sleep(backoff[attempt]!);
      }
    }
  }

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
        last = await send(opts.target, { text: r.text, styles: r.styles, quote });
        quote = undefined;
        if (!opts.target) remember(`t:${last}`);
        record?.(opts.kind ?? "other", last, r.text, opts.target);
      }
    }
    return last;
  }

  // A voice message (an audio file), to the owner's chat or another conversation. What was said is logged as text, so the log stays searchable.
  async function sendVoice(file: string, spoken: string, target?: Target): Promise<number> {
    const ts = await send(target, { text: "", attachments: [{ file, kind: "voice" }] });
    if (!target) remember(`t:${ts}`);
    record?.("chat", ts, `🔊 ${spoken}`, target);
    return ts;
  }

  // A picture (a screenshot kept by the browse tool, shots.ts) with an optional caption, to the owner's chat or another conversation.
  async function sendPicture(file: string, caption: string, opts: { quote?: Quote; kind?: MessageKind; target?: Target } = {}): Promise<number> {
    const r = caption ? renderMarkdown(clean("picture caption", caption, { max: 300 })) : { text: "", styles: [] };
    if (!opts.target && r.text) remember(`x:${r.text}`);
    const ts = await send(opts.target, { text: r.text, styles: r.styles, quote: messenger.capabilities.quotes ? opts.quote : undefined, attachments: [{ file, kind: "picture" }] });
    if (!opts.target) remember(`t:${ts}`);
    record?.(opts.kind ?? "chat", ts, `🖼️ ${r.text || "(picture)"}`, opts.target);
    return ts;
  }

  const replyPlain = (text: string, kind?: MessageKind) => reply(text, { plain: true, kind });

  return { reply, replyPlain, sendVoice, sendPicture, isOwnEcho };
}
