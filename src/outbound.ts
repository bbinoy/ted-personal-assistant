import type { Kind as MessageKind } from "./messages.ts";
import { settings } from "./settings.ts";
import { clean } from "./sanitize.ts";
import { briefDelivery } from "./brief.ts";
import { BRIEF_FOOTER, BRIEF_FOOTER_NO_MAIL, renderMarkdown, signalSummary, splitSections, toSignalStyles } from "./markdown.ts";
import type { Quote, SignalClient } from "@ted-personal-assistant/signal";

const CHUNK_LIMIT = 1800; // keep each Signal message comfortably short
const ECHO_WINDOW_MS = settings.echoWindowMinutes * 60_000;

// Split long text on paragraph, then line, then hard boundaries.
export function chunk(text: string, limit = CHUNK_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// `record` is told about every message sent (kind, Signal timestamp, text, group id if it went to a group): the message log.
export function createOutbound(signal: Pick<SignalClient, "send">, record?: (kind: MessageKind, ts: number, text: string, groupId?: string) => void) {
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
    return (recent.get(`t:${m.timestamp}`) ?? 0) > now || (recent.get(`x:${m.text}`) ?? 0) > now;
  }

  // Sends markdown as styled Signal text. `plain` skips markdown parsing: use it for anything
  // that embeds untrusted text (approval prompts and alerts quote email content).
  // Returns the timestamp of the last message sent (what a reaction would target).
  // `quote` threads the reply under a message (first chunk only). `groupId` sends to that group instead
  // of the owner's chat; a group's messages never come back as the owner's, so they are not echo-registered
  // (that would swallow a message of the owner's with the same text).
  async function reply(text: string, opts: { plain?: boolean; quote?: Quote; kind?: MessageKind; groupId?: string } = {}): Promise<number> {
    let last = 0;
    let quote = opts.quote;
    for (const part of chunk(text)) {
      const r = opts.plain ? { text: part, styles: [] } : renderMarkdown(part);
      if (!opts.groupId) remember(`x:${r.text}`);
      last = await signal.send(r.text, { style: toSignalStyles(r.styles), quote, ...(opts.groupId ? { groupId: opts.groupId } : {}) });
      quote = undefined;
      if (!opts.groupId) remember(`t:${last}`);
      record?.(opts.kind ?? "other", last, r.text, opts.groupId);
    }
    return last;
  }

  // A voice message (an audio file), to the owner's chat or a group. What was said is logged as text, so the log stays searchable.
  async function sendVoice(file: string, spoken: string, groupId?: string): Promise<number> {
    const ts = await signal.send("", { attachments: [file], voiceNote: true, ...(groupId ? { groupId } : {}) });
    if (!groupId) remember(`t:${ts}`);
    record?.("chat", ts, `🔊 ${spoken}`, groupId);
    return ts;
  }

  // A picture (a screenshot kept by the browse tool, shots.ts) with an optional caption, to the owner's chat or a group.
  async function sendPicture(file: string, caption: string, opts: { quote?: Quote; kind?: MessageKind; groupId?: string } = {}): Promise<number> {
    const r = caption ? renderMarkdown(clean("picture caption", caption, { max: 300 })) : { text: "", styles: [] };
    if (!opts.groupId && r.text) remember(`x:${r.text}`);
    const ts = await signal.send(r.text, { attachments: [file], style: toSignalStyles(r.styles), quote: opts.quote, ...(opts.groupId ? { groupId: opts.groupId } : {}) });
    if (!opts.groupId) remember(`t:${ts}`);
    record?.(opts.kind ?? "chat", ts, `🖼️ ${r.text || "(picture)"}`, opts.groupId);
    return ts;
  }

  const replyPlain = (text: string, kind?: MessageKind) => reply(text, { plain: true, kind });

  // The whole brief, one message per section (not used for the daily brief any more: Signal gets
  // the short summary above, the full text goes out by email).
  // The brief itself goes out by email. Signal gets the short version (pep talk, focus, a pointer).
  async function sendBriefSummary(markdown: string) {
    await reply(signalSummary(markdown, briefDelivery() === "email" ? BRIEF_FOOTER : BRIEF_FOOTER_NO_MAIL), { kind: "brief" });
  }

  async function sendBrief(markdown: string) {
    for (const section of splitSections(markdown, CHUNK_LIMIT)) {
      await reply(section, { kind: "brief" });
      await new Promise((r) => setTimeout(r, 400)); // keep delivery order stable
    }
  }

  return { reply, replyPlain, sendVoice, sendPicture, sendBrief, sendBriefSummary, isOwnEcho };
}
