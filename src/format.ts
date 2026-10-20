// Phone-readable approval text, built deterministically from the exact tool
// arguments. Deliberately not model-written: an approval prompt that a model
// paraphrases can misrepresent the call it is meant to guard.

import type { MailView } from "./mailview.ts";
import { mailView, titleOf } from "./toolmanifest.ts";

// The titles of tools shown generically are the tool modules' (`titles`, src/modules). (Mail tools are shown from mailView() below, whatever the provider; the
// titles are only for a call mailView cannot read.)

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Stamp = { day: string; time?: string };

// "2026-10-12T16:00:00" -> { day: "Mon 12 Oct", time: "16:00" }. Local wall time, no zone maths.
function stamp(value: unknown): Stamp | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return {
    day: `${DAYS[date.getUTCDay()]} ${Number(d)} ${MONTHS[date.getUTCMonth()]}`,
    time: h !== undefined ? `${h}:${mi}` : undefined,
  };
}

function when(start: unknown, end: unknown, zone: unknown): string | undefined {
  const s = stamp(start);
  if (!s) return undefined;
  const e = stamp(end);
  const tz = typeof zone === "string" && zone ? ` (${zone})` : "";
  if (!s.time) return e && e.day !== s.day ? `${s.day} to ${e.day}, all day` : `${s.day}, all day`;
  if (!e) return `${s.day}, ${s.time}${tz}`;
  if (e.day === s.day) return `${s.day}, ${s.time}–${e.time}${tz}`;
  return `${s.day} ${s.time} → ${e.day} ${e.time}${tz}`;
}

// Bidirectional-text controls can make text display in a different order than it reads
// (an approval that looks harmless on the phone but says something else). Never shown.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Characters that take no room on a screen (zero-width space, word joiner, BOM, soft hyphen, fillers) would make two different
// addresses or titles look identical. They are shown as their code point instead of staying invisible. (Not U+200C/U+200D: emoji
// sequences and some scripts need them.) Other control characters are dropped.
const INVISIBLE = /[­͏ᅟᅠ᠎​⁠-⁤ㅤ﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// An approval must never hide content silently: whatever is cut is announced.
export function clip(text: string, max: number): string {
  const flat = text
    .replace(BIDI, "")
    .replace(CONTROL, "")
    .replace(INVISIBLE, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`)
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}… (+${flat.length - max} more characters not shown)` : flat;
}

// Free text the owner is being asked to approve (an email body, event notes) gets more room.
const LONG_TEXT = new Set(["body", "description", "message", "text", "content", "markdownBody"]);

// Shape of an attendee/recipient object: shown as just its address. Anything else is shown whole.
const PERSON_KEYS = new Set(["email", "address", "name", "displayName", "responseStatus", "optional"]);

function show(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => show(key, v)).join(", ");
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const id = o.email ?? o.address;
    if (typeof id === "string" && Object.keys(o).every((k) => PERSON_KEYS.has(k))) return clip(id, 200);
    return clip(JSON.stringify(value), 300);
  }
  return clip(String(value), LONG_TEXT.has(key) ? 1200 : 200);
}

function humanise(tool: string): string {
  const [server, name] = tool.replace(/^mcp__(claude_ai_)?/, "").split("__");
  const words = (name ?? server ?? tool).replace(/[_-]+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${(server ?? "").replace(/_/g, " ")})`;
}

const LABELS: Record<string, string> = {
  summary: "Title", title: "Title", subject: "Subject", to: "To", cc: "Cc", bcc: "Bcc",
  location: "Where", attendees: "With", description: "Notes", body: "Message",
};
// Fields shown specially or not worth showing.
const SKIP = new Set(["startTime", "endTime", "start", "end", "start_time", "end_time", "timeZone", "timezone", "summary", "title"]);
const SKIP_VALUES = new Set(["primary"]);

// --- an outgoing mail, the same for every provider (toolmanifest.ts mailView) ---

const MAX_SHOWN = 1200;

// A reply draft is the new text ABOVE the quoted original ("> ..." lines, or "On <date> <name> wrote:").
// The owner only needs to read what is new; the whole draft is still what gets sent and checked.
const QUOTE_HEADER = /^(On .{5,120} wrote:|Am .{5,120} schrieb.*:|Le .{5,120} a [ée]crit\s*:)\s*$/;
const QUOTE_START = /^(>|On .{5,120} wrote:\s*$|Am .{5,120} schrieb.*:\s*$|Le .{5,120} a [ée]crit\s*:\s*$)/m;
export function authoredPart(body: string): { text: string; hasQuote: boolean } {
  const i = body.search(QUOTE_START);
  if (i < 0) return { text: body.trim(), hasQuote: false };
  // Only real quote lines (and the "wrote:" line that introduces them) may be left out of what is shown. Any other text after
  // the first quote marker is new text: a reply typed below the quote, or something slipped in under a fake "> ..." line.
  const isQuote = (l: string, k: number) => (k === 0 && QUOTE_HEADER.test(l)) || l.trim() === "" || l.trimStart().startsWith(">");
  const below = body.slice(i).split("\n").filter((l, k) => !isQuote(l, k)).map((l) => l.trim());
  return { text: [body.slice(0, i).trim(), ...below].filter(Boolean).join("\n"), hasQuote: true };
}

export function cutBody(body: string): string {
  const { text, hasQuote } = authoredPart(body);
  const cut = text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}… (+${text.length - MAX_SHOWN} more characters not shown)` : text;
  return hasQuote ? `${cut}\n\n(the quoted original follows below it in the email)` : cut;
}

// Recipients and subject come from the mail client or the model (the subject from the sender of the mail being answered): one clean
// line each, so a line break cannot fake another header and an invisible or right-to-left character cannot disguise an address.
// Bcc and attachments are always shown when there are any: they are what a send must not hide.
export function mailHeader(d: Pick<MailView, "to" | "cc" | "bcc" | "subject" | "hasAttachments" | "attachments">): string {
  const list = (a: string[]) => a.map((x) => clip(x, 200)).join(", ");
  return [
    `To: ${d.to.length ? list(d.to) : "(nobody yet)"}`,
    ...(d.cc.length ? [`Cc: ${list(d.cc)}`] : []),
    ...(d.bcc.length ? [`Bcc: ${list(d.bcc)}`] : []),
    `Subject: ${clip(d.subject, 200)}`,
    ...(d.hasAttachments ? [d.attachments?.length ? `Attachments: ${d.attachments.slice(0, 8).map((a) => clip(a, 120)).join(", ")}${d.attachments.length > 8 ? ` (+${d.attachments.length - 8} more not shown)` : ""}` : "Attachments: yes (the mail client gave no names)"] : []),
  ].join("\n");
}

const MAIL_TITLES: Record<MailView["action"], string> = { send: "✉️ Send email now", reply: "✉️ Send reply now", forward: "✉️ Forward email", draft: "✉️ Save email draft" };
export const mailText = (v: MailView): string => `${MAIL_TITLES[v.action]}\n${mailHeader(v)}\n\n${cutBody(v.body)}`;

// `draft`: for a send of an existing draft, the draft as the mail client holds it (mailView).
export function describeCall(tool: string, input: Record<string, unknown>, draft?: Omit<MailView, "action">): string {
  const view = mailView(tool, input, draft);
  if (view) return mailText(view);
  const meta = titleOf(tool, input);
  const lines: string[] = [meta ? `${meta.icon} ${meta.title}` : `❓ ${humanise(tool)}`];

  const title = input.summary ?? input.title;
  if (typeof title === "string" && title) lines.push(`“${clip(title, 120)}”`);

  const time = when(input.startTime ?? input.start ?? input.start_time, input.endTime ?? input.end ?? input.end_time, input.timeZone ?? input.timezone);
  if (time) lines.push(`🕒 ${time}`);

  for (const [key, value] of Object.entries(input)) {
    if (SKIP.has(key) || value === undefined || value === null || value === "") continue;
    if (typeof value === "string" && SKIP_VALUES.has(value)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`${meta?.labels?.[key] ?? LABELS[key] ?? key}: ${show(key, value)}`);
  }
  return lines.join("\n");
}
