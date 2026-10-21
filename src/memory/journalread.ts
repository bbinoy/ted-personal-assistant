import { ledgerEntries, withoutDeleted, type Sent } from "../core/messages.ts";
import { dayIn, systemZone, timeIn } from "../core/timezone.ts";
import { whenIn } from "./search.ts";

// Reading the journal (kind "journal" lines of a conversation's own log, written by the journal sink, core/events.ts): the `journal` tool, /today and the daily brief. Pure over the log's lines,
// in the conversation's own time zone, sized for a model's context. Every line is data (the tool fences it): a subject or a title in it was written by a third party.

export interface JournalArgs {
  since?: string; // YYYY-MM-DD, YYYY-MM-DDTHH:MM, "today" or "yesterday", in the conversation's time zone
  until?: string; // a bare date includes that whole day
  sinceHours?: number;
  kind?: string; // the category: archive, mail, calendar, notion, drive, memory, dream, notice, payment, removal, task, browse, other
  query?: string; // every word must appear (case-insensitive)
  limit?: number;
}

export const KINDS = ["archive", "mail", "calendar", "notion", "drive", "memory", "dream", "notice", "payment", "removal", "task", "browse", "other"] as const;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_CHARS = 9000;
const LINE_CHARS = 420;

// A line's parts: what was done, why, and how to undo it (journalText, core/sinks/journalsink.ts, writes "<what>. Why: <why>. [Ted's reason: “...”.] [Undo: <undo>]").
export function splitJournal(text: string): { what: string; why: string; undo: string } {
  const undoAt = text.lastIndexOf(" Undo: ");
  const undo = undoAt >= 0 ? text.slice(undoAt + 7) : "";
  const rest = undoAt >= 0 ? text.slice(0, undoAt) : text;
  const whyAt = rest.indexOf(" Why: ");
  return { what: (whyAt >= 0 ? rest.slice(0, whyAt) : rest).replace(/\.$/, ""), why: whyAt >= 0 ? rest.slice(whyAt + 6).replace(/\.$/, "") : "", undo: undo.replace(/\.$/, "") };
}

const dayWord = (word: string | undefined, now: number, zone: string): string | undefined => {
  const w = word?.trim().toLowerCase();
  if (w === "today") return dayIn(new Date(now), zone);
  if (w === "yesterday") return dayIn(new Date(now - 86_400_000), zone); // (a day is 24 hours but for a clock change; the date names it)
  return word;
};

// The journal lines that match, oldest first. `error` for a date that cannot be read.
export function journalSelect(file: string, a: JournalArgs, now: number, zone: string): { lines: Sent[]; error?: string } {
  const from = a.sinceHours && a.sinceHours > 0 ? now - a.sinceHours * 3_600_000 : whenIn(dayWord(a.since, now, zone), false, zone);
  const to = whenIn(dayWord(a.until, now, zone), true, zone);
  if (from === "bad" || to === "bad") return { lines: [], error: "since and until must be dates like 2026-10-21, or today / yesterday." };
  const words = (a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const kind = a.kind?.trim().toLowerCase();
  const lines = withoutDeleted(ledgerEntries(file)).filter((m) => {
    if (m.kind !== "journal") return false;
    const t = Date.parse(m.at);
    if (from !== undefined && t < from) return false;
    if (to !== undefined && t > to) return false;
    if (kind && m.cat !== kind) return false;
    const lower = m.text.toLowerCase();
    return words.every((w) => lower.includes(w));
  });
  return { lines };
}

// Counts by category, most first.
export function journalCounts(lines: readonly Sent[]): [string, number][] {
  const n = new Map<string, number>();
  for (const m of lines) n.set(m.cat ?? "other", (n.get(m.cat ?? "other") ?? 0) + 1);
  return [...n].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
}

// The text the `journal` tool returns: the newest `limit` lines, oldest first, grouped by day, each with its time in the conversation's zone.
export function readJournal(file: string, a: JournalArgs, o: { now?: number; zone?: string } = {}): string {
  const now = o.now ?? Date.now();
  const zone = o.zone ?? systemZone();
  const hasWindow = a.since !== undefined || a.sinceHours !== undefined;
  const { lines, error } = journalSelect(file, hasWindow ? a : { ...a, sinceHours: 24 * 7 }, now, zone); // no window asked: the last week
  if (error) return error;
  if (!lines.length) return `Nothing in the journal matches${hasWindow ? "" : " in the last 7 days"} (times in ${zone}).`;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(a.limit ?? DEFAULT_LIMIT)));
  const rendered = lines.slice(-limit).map((m) => ({ day: dayIn(new Date(m.at), zone), text: `${timeIn(new Date(m.at), zone)} [${m.cat ?? "other"}] ${m.text.length > LINE_CHARS ? `${m.text.slice(0, LINE_CHARS - 1)}…` : m.text}` }));
  let chars = 0;
  let first = rendered.length;
  while (first > 0 && chars + rendered[first - 1]!.text.length <= MAX_CHARS) chars += rendered[--first]!.text.length; // (what does not fit is the oldest)
  const body: string[] = [];
  let heading = "";
  for (const r of rendered.slice(first)) {
    if (r.day !== heading) body.push(r.day), (heading = r.day);
    body.push(r.text);
  }
  const hidden = lines.length - (rendered.length - first);
  return `${lines.length} journal line${lines.length === 1 ? "" : "s"} (times in ${zone}), oldest first:\n${body.join("\n")}${hidden > 0 ? `\n${hidden} more not shown: narrow it with since, until, kind or query, or raise limit.` : ""}`;
}

// "/today": the day so far, phone-sized: counts by category, then the last few actions with their why.
export function todayText(file: string, o: { now?: number; zone?: string; last?: number } = {}): string {
  const now = o.now ?? Date.now();
  const zone = o.zone ?? systemZone();
  const { lines } = journalSelect(file, { since: "today" }, now, zone);
  const day = dayIn(new Date(now), zone);
  if (!lines.length) return `Nothing done on my own today (${day}). Ask me "what did you do this week?" for older days.`;
  const counts = journalCounts(lines).map(([k, n]) => `${k} ${n}`).join(", ");
  const last = lines.slice(-(o.last ?? 8)).map((m) => {
    const p = splitJournal(m.text);
    const line = `${timeIn(new Date(m.at), zone)} ${p.what}${p.why ? ` (${p.why})` : ""}`;
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  });
  return [`Today (${day}): ${lines.length} action${lines.length === 1 ? "" : "s"}: ${counts}.`, ...last].join("\n");
}
