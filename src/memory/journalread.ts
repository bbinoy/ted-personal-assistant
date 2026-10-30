import { LIMITS } from "../core/sanitize.ts";
import { ledgerEntries, withoutDeleted, type Sent } from "../core/messages.ts";
import { dayIn, systemZone, timeIn } from "../core/timezone.ts";
import { whenIn } from "./search.ts";

// Reading the journal (kind "journal" lines of a conversation's own log, written by the journal sink, core/events.ts): the `journal` tool, /today and the daily brief. Pure over the log's lines,
// in the conversation's own time zone, sized for a model's context. Every line is data (the tool fences it): a subject or a title in it was written by a third party.

export interface JournalArgs {
  since?: string; // YYYY-MM-DD, YYYY-MM-DDTHH:MM, "today" or "yesterday", in the conversation's time zone
  until?: string; // a bare date includes that whole day
  sinceHours?: number;
  kind?: string; // the category: archive, mail, calendar, notion, drive, memory, dream, notice, payment, removal, task, browse, triage (why each inbox mail was archived or kept), other
  query?: string; // every word must appear (case-insensitive)
  limit?: number;
}

export const KINDS = ["archive", "mail", "calendar", "notion", "drive", "memory", "dream", "notice", "payment", "removal", "task", "browse", "triage", "other"] as const;
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
function journalSelect(file: string, a: JournalArgs, now: number, zone: string): { lines: Sent[]; error?: string } {
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
    if (kind ? m.cat !== kind : m.cat === "triage" && !words.length) return false; // (the per-mail decision log is shown when asked for: kind triage, or words to search for)
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

// ---- the archived mail, for the brief and for putting one back ----

// One archive line of the journal as an item: who sent it (when the run had read it), its subject, and every id it archived (the undo names them, journalrender.ts), so a restore can put it back.
export interface ArchiveItem {
  n: number; // 1.. in the order they were archived, within the window asked for (the same window gives the same numbers: later archives only add at the end)
  at: string;
  subject?: string;
  from?: string;
  ids: string[];
  what: string; // the line's own words, when no subject could be read (an archive of several mails, a mail never read)
}

export function archiveItems(lines: readonly Sent[]): ArchiveItem[] {
  return lines
    .filter((m) => m.cat === "archive" && /^Archived /.test(m.text))
    .map((m, i) => {
      const p = splitJournal(m.text);
      const many = /npm run restore <id> for each of (.+?)(?:, or say|$)/.exec(p.undo)?.[1];
      const one = /npm run restore (\S+?)(?:,|$)/.exec(p.undo)?.[1];
      const ids = many ? many.split(/\s+/).filter(Boolean) : one && one !== "<id>" ? [one] : [];
      const what = p.what.replace(/^Archived /, "");
      const named = /^“(.*)”(?: from (.+))?$/.exec(what);
      return { n: i + 1, at: m.at, ids, what, ...(named && ids.length <= 1 ? { subject: named[1], ...(named[2] ? { from: named[2] } : {}) } : {}) };
    });
}

// The text of `journal` with kind "archive": the count, then the mail grouped by sender, numbered, each with its id (what a restore needs).
function archiveListText(items: readonly ArchiveItem[], window: string, zone: string): string {
  if (!items.length) return `No mail archived ${window} (times in ${zone}).`;
  const groups = new Map<string, ArchiveItem[]>();
  for (const it of items) {
    const key = it.from ?? (it.subject ? "unknown sender" : "not named");
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  const line = (it: ArchiveItem) => `${it.n}. ${it.subject ? `“${it.subject}”` : it.what} (${dayIn(new Date(it.at), zone).slice(5)} ${timeIn(new Date(it.at), zone)}${it.ids.length ? `, id ${it.ids.join(" ")}` : ""})`;
  const body = [...groups].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0])).map(([from, list]) => `${from} (${list.length}): ${list.map(line).join("; ")}`);
  return [`${items.length} mail${items.length === 1 ? "" : "s"} archived ${window} (times in ${zone}), by sender:`, ...body].join("\n");
}

// The text the `journal` tool returns: the newest `limit` lines, oldest first, grouped by day, each with its time in the conversation's zone. With kind "archive": the numbered archive list.
export function readJournal(file: string, a: JournalArgs, o: { now?: number; zone?: string } = {}): string {
  const now = o.now ?? Date.now();
  const zone = o.zone ?? systemZone();
  const hasWindow = a.since !== undefined || a.sinceHours !== undefined;
  if (a.kind?.trim().toLowerCase() === "archive") {
    const sel = journalSelect(file, hasWindow ? a : { ...a, sinceHours: 24 * 7 }, now, zone);
    if (sel.error) return sel.error;
    const window = a.since !== undefined ? `since ${a.since}${a.until ? ` until ${a.until}` : ""}` : a.sinceHours !== undefined ? `in the last ${a.sinceHours} hours` : "in the last 7 days";
    return archiveListText(archiveItems(sel.lines).slice(0, MAX_LIMIT), window, zone);
  }
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

const JOURNAL_BEFORE_MS = 30 * 60_000; // the actions of the look that wrote a message are logged just before it
const JOURNAL_AFTER_MS = 2 * 60_000;
const MAX_JOURNAL = 6;

// The journal lines around a message of the assistant's: what it did just before sending it, as "[cat] what (why)". A reaction is a correction when the reaction is 👎 on this: the model
// works out the rule from what was done and why (the "per your notes: ..." says which note drove it).
export function journalAround(file: string, at: string): string[] {
  const t = Date.parse(at);
  return ledgerEntries(file)
    .filter((m) => m.kind === "journal" && Date.parse(m.at) >= t - JOURNAL_BEFORE_MS && Date.parse(m.at) <= t + JOURNAL_AFTER_MS)
    .slice(-MAX_JOURNAL)
    .map((m) => { const p = splitJournal(m.text); return `[${m.cat ?? "other"}] ${p.what}${p.why ? ` (${p.why})` : ""}`.slice(0, LIMITS.line); });
}
