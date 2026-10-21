import { clockIn, dayAt } from "../core/timezone.ts";

// The held items (posts and notices kept back by quiet hours, /quiet or the day's cap, notices.ts) go out as ONE curated digest instead of one lump. Everything here is pure:
//   which kind each item is, which duplicates go, what is shown and what is "N more", when a digest is due (the configured slots in the conversation's own zone, DST-safe), and its text.
// The text is written by code; a model may only shorten the lines (notices.ts), and the code's own lines are a good digest without it.

export type DigestKind = "needs" | "fyi" | "system";
export interface DigestItem {
  text: string;
  notice?: boolean; // a system notice
  at?: number; // when it was held (epoch ms)
  needsYou?: boolean; // the look's own say that it asks something of the owner; absent on items held without it (then the words decide)
  why?: "quiet" | "cap";
}

const NEEDS = /\?|\b(approve|approval|confirm|reply|respond|decide|let me know|need(?:s)? (?:you|your)|waiting (?:for|on) you|your (?:ok|okay|go-ahead|decision|call|answer))\b/i;

// A system notice is "system"; a post the look flagged `needsYou` is "needs you" (false: FYI, whatever its punctuation); an item held without the flag (an older one, or a mid-run send) is judged
// by its words as a fallback: a question, an approval, a reply. The rest is FYI.
export const kindOfItem = (h: Pick<DigestItem, "text" | "notice" | "needsYou">): DigestKind =>
  h.notice ? "system" : typeof h.needsYou === "boolean" ? (h.needsYou ? "needs" : "fyi") : NEEDS.test(h.text) ? "needs" : "fyi";

const words = (text: string): string[] => text.split("\n")[0]!.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
// The same text, or the same subject: the first line's first six words without digits ("3 new mails from the bank" and "5 new mails from the bank" are one subject). Shorter than
// three words there is no subject to speak of: only the whole text counts.
export const textKey = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
export function subjectOf(text: string): string | undefined {
  const w = words(text).map((x) => x.replace(/\d+/g, "")).filter(Boolean);
  return w.length >= 3 ? w.slice(0, 6).join(" ") : undefined;
}

// Newest first (held rows are in the order they were held; a row without a time keeps its place), one of each text and subject (the newest stays).
export function dedupe<T extends DigestItem>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const h of items.slice().reverse()) {
    const keys = [`t:${textKey(h.text)}`, ...(subjectOf(h.text) ? [`s:${kindOfItem(h)}:${subjectOf(h.text)}`] : [])];
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(h);
  }
  return out;
}

const ORDER: readonly DigestKind[] = ["needs", "fyi", "system"];
export interface DigestPlan<T> {
  groups: { kind: DigestKind; items: T[] }[]; // in the order shown; newest first inside a group
  more: number; // what the cap left out (and what the digest therefore only counts)
}

// Pure: dedupe, group by kind (needs you, FYI, system), newest first, at most `max` shown (needs you first, so a cap never cuts what waits for her before an FYI).
export function planDigest<T extends DigestItem>(held: readonly T[], max: number): DigestPlan<T> {
  const items = dedupe(held);
  const groups = ORDER.map((kind) => ({ kind, items: items.filter((h) => kindOfItem(h) === kind) })).filter((g) => g.items.length > 0);
  let room = Math.max(1, max);
  for (const g of groups) {
    g.items = g.items.slice(0, room);
    room -= g.items.length;
  }
  return { groups: groups.filter((g) => g.items.length > 0), more: items.length - groups.reduce((n, g) => n + g.items.length, 0) };
}

// The code's own one-liner for an item: whitespace collapsed, cut at a word boundary. Never empty for a non-empty text.
export function oneLine(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const TITLE: Readonly<Record<DigestKind, string>> = { needs: "Needs you", fyi: "FYI", system: "System" };

// The digest message. One item as it is; one group a plain list; several groups with their titles. `lineOf` gives an item's line (default: the code's one-liner).
export function digestText<T extends DigestItem>(plan: DigestPlan<T>, lineOf: (h: T) => string = (h) => oneLine(h.text)): string {
  const all = plan.groups.flatMap((g) => g.items);
  const more = plan.more > 0 ? `\nand ${plan.more} more, ask me.` : "";
  if (all.length === 1 && plan.more === 0) return all[0]!.text;
  const bullets = (items: T[]) => items.map((h) => `- ${lineOf(h)}`).join("\n");
  const body = plan.groups.length === 1 ? bullets(plan.groups[0]!.items) : plan.groups.map((g) => `${TITLE[g.kind]}\n${bullets(g.items)}`).join("\n");
  return `A few things I held back:\n${body}${more}`;
}

// ---- the slots ----

// The instant (epoch ms) of the wall time y-m-d hh:mm in `zone`. DST-safe: the offset is looked up at the answer, twice (a time that does not exist, in the hour a clock jumps over, lands
// next to it; a time that exists twice is the first).
export function zonedInstant(y: number, m: number, d: number, hh: number, mm: number, zone: string): number {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const c = clockIn(new Date(t), zone);
    const shown = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute);
    if (shown === want) break;
    t += want - shown;
  }
  return t;
}

// The latest slot instant at or before `now` (looking back three calendar days), or undefined (no slots). `slots`: minutes since midnight in the zone.
export function lastSlotBefore(now: number, zone: string, slots: readonly number[]): number | undefined {
  let best: number | undefined;
  for (let off = -3; off <= 0; off++) {
    const [y, m, d] = dayAt(new Date(now), off, zone).date.split("-").map(Number) as [number, number, number];
    for (const s of slots) {
      const t = zonedInstant(y, m, d, Math.floor(s / 60), s % 60, zone);
      if (t <= now && (best === undefined || t > best)) best = t;
    }
  }
  return best;
}

// Is a digest due? Never with nothing held. At once for what was held for quiet (the caller has checked the window is over: it ENDED) and for a row of the old kind without a time; for what
// the cap held (it waits for the next day) once a slot has passed since the oldest was held; with no slots at all, as soon as it may go.
export function digestDue(i: { held: readonly DigestItem[]; now: number; zone: string; slots: readonly number[] }): boolean {
  if (i.held.length === 0) return false;
  if (i.held.some((h) => h.at === undefined || h.why === "quiet")) return true;
  if (i.slots.length === 0) return true;
  const slot = lastSlotBefore(i.now, i.zone, i.slots);
  const oldest = Math.min(...i.held.map((h) => h.at!));
  return slot !== undefined && slot > oldest;
}
