import { skipForCooldown } from "./cooldown.ts";
import { statSync } from "node:fs";
import { appendLine, dataPath, readText, writeText } from "./state.ts";
import { convPaths, OWNER_CONV } from "./convpaths.ts";
import { LIMITS } from "./sanitize.ts";

// Every message the assistant sends on Signal, with its Signal timestamp: one append-only file.
// It answers three questions the chat session cannot: what does a reaction (which carries only a
// timestamp) refer to, what did the assistant tell the owner on its own (alerts, handled mail,
// radar, the brief), and what was said a week ago (searchable, like any log, with search_logs).
//
// The file is bounded by SIZE, not age. Past LOG_MAX_BYTES the oldest messages are folded into
// ONE short summary line at the top ("20 more messages about ..."), written by a small model; the
// summary itself is rewritten each time, so the file never grows past the limit. The owner's own


export const FILE = convPaths(OWNER_CONV).messages; // the owner's chat; a group and a friend have their own, same format (convpaths.ts)
const KEEP_AFTER_COMPACTION = 0.7; // compact down to this share of the limit, so it does not run on every message

// What was said: the assistant's own messages (chat, notice, approval, draft, brief, other), the OWNER's messages
// (owner, including voice transcripts) and the owner's reactions (reaction: "👎 on: <the message>"), and what was
// said in a group is NOT in this log: each group has its own, in the same format (member: what a person wrote there).
//
// The log only grows, so an edit or a delete is a line of its own that points at the message it concerns (`of`, a Signal
// timestamp): "edit" is the new text of an earlier message, "delete" a marker that its author took it back. Neither is a second
// message by itself: readers fold an edit into its original (foldEdits), hide what was deleted (withoutDeleted), and a lookup
// by the original's timestamp finds the latest version. `by` is who wrote an inbound message, so an edit or a delete can be
// checked against its author.
//
// The log is also the gate's LEDGER (gate.ts): "action" is something done without posting (a wake-up that stayed
// silent) and "wake" is the chosen next look (the last one is the state). They are not conversation: everything
// that reads the log as conversation (chat context, dream, compaction summaries, recent lines, finding the message
// a reaction was on) skips them; only search_logs and the gate itself see them.
// "journal" is the third ledger kind: one line per thing the assistant DID (an archive, a calendar change, a sent mail...) with why and how to undo it, written by the journal sink
// (core/events.ts), read by the `journal` tool, /today and the daily brief. It carries a category (`cat`: archive, mail, calendar...). Not conversation, so everything above skips it; the
// F10 search indexes it; compaction keeps it verbatim for JOURNAL_KEEP_DAYS (below) and never folds it into the summary (compactIfNeeded).
export type Kind = "chat" | "notice" | "approval" | "draft" | "brief" | "other" | "owner" | "reaction" | "member" | "action" | "wake" | "journal" | "edit" | "delete";

// The ledger's "wake" line: the chosen next look, as JSON.
export interface Wake {
  next: string; // ISO: the next look
  looked: string; // ISO: when the look that chose it began (anything said after it is news)
}
export function parseWake(text: string): Wake | undefined {
  try {
    const w = JSON.parse(text) as Partial<Wake>;
    return typeof w.next === "string" && Number.isFinite(Date.parse(w.next)) && typeof w.looked === "string" && Number.isFinite(Date.parse(w.looked)) ? { next: w.next, looked: w.looked } : undefined;
  } catch {
    return undefined;
  }
}

// THE table of kinds: what each one is, in one place. Every reader that sorts lines by kind asks it (kindIs below) and no module keeps a list of its own.
//   ledger: not conversation (the gate's state, the journal); inbound: a person wrote it (owner, member); said: the assistant said it to the person; 
//   answers: the reply (or the failure notice) of a turn, so lines before it are answered; asks: leaves a question open, so the next line is probably its answer;
//   search: how the F10 index treats it: the role/author it is found under, "marker" (kept so a deleted message is left out, never a hit) or "none" (not indexed).
// A line of a kind the table does not know (an old log: "suggestions" and "proposals" are never written any more) still parses; it is indexed as an assistant line and is nothing else.
type Search = "owner" | "member" | "assistant" | "summary" | "marker" | "none";
interface KindInfo { ledger?: true; inbound?: true; said?: true; answers?: true; asks?: true; search: Search }
export const KIND_INFO: Readonly<Record<Kind | "summary", KindInfo>> = {
  owner: { inbound: true, search: "owner" },
  member: { inbound: true, search: "member" },
  edit: { search: "member" },
  delete: { search: "marker" },
  reaction: { search: "none" },
  chat: { said: true, answers: true, search: "assistant" },
  other: { said: true, answers: true, search: "assistant" },
  notice: { said: true, search: "assistant" },
  brief: { said: true, search: "assistant" },
  draft: { said: true, asks: true, search: "assistant" },
  approval: { said: true, asks: true, search: "none" },
  action: { ledger: true, search: "none" },
  wake: { ledger: true, search: "none" },
  journal: { ledger: true, search: "assistant" },
  summary: { search: "summary" },
};
export type KindFlag = Exclude<keyof KindInfo, "search">;
const infoOf = (kind: string): KindInfo | undefined => (Object.hasOwn(KIND_INFO, kind) ? KIND_INFO[kind as Kind] : undefined);
/** Does this kind have the property? An unknown kind (an old log line) has none. */
export const kindIs = (kind: string, flag: KindFlag): boolean => !!infoOf(kind)?.[flag];
/** How the search index treats this kind; an unknown one is found as an assistant line. */
export const searchOf = (kind: string): Search => infoOf(kind)?.search ?? "assistant";
/** Every kind of the table that is found in search under a role. */
export const SEARCHED_KINDS: readonly string[] = Object.keys(KIND_INFO).filter((k) => !["marker", "none"].includes(KIND_INFO[k as Kind].search));

const isLedger = (kind: Kind) => kindIs(kind, "ledger");

export interface Sent {
  ts: number; // Signal timestamp of the message
  at: string;
  kind: Kind;
  text: string;
  by?: string; // who wrote an inbound message (owner, member, edit): their number or account id
  of?: number; // edit, delete: the timestamp of the message it concerns
  cat?: string; // journal: what kind of action (archive, mail, calendar, ...)
  addressed?: true; // an inbound line that was meant for the assistant (tagged or quoted): a restart finds in the log which lines a group has to answer (replay.ts)
}

/** What a log line can carry besides its kind and text. */
export interface Extra {
  by?: string;
  of?: number;
  cat?: string;
  addressed?: true;
}

interface Summary {
  kind: "summary";
  at: string;
  from: string;
  to: string;
  count: number;
  text: string;
}

export type Summarize = (previous: Summary | undefined, old: readonly Sent[]) => Promise<string>;

const parse = (line: string): Sent | Summary | undefined => {
  try {
    const e = JSON.parse(line);
    return e && typeof e.text === "string" ? e : undefined;
  } catch {
    return undefined;
  }
};

const isSummary = (e: Sent | Summary): e is Summary => e.kind === "summary";

// Parsed logs are cached per file, keyed by what stat says (inode, size, mtime): any append, rewrite (compaction
// writes a new file) or deletion changes the key, so a hit is always what a fresh read would give. Bounded, because
// every group has a log: only the most recently used few are kept.
const MAX_CACHED_LOGS = 8;
const parsed = new Map<string, { sig: string; sent: Sent[]; summary?: Summary }>();

// What changes whenever the file does ("" when there is none). Cheap: one stat.
export function logSignature(file: string = FILE): string {
  try {
    const s = statSync(dataPath(file));
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

function readAll(file: string = FILE): { sent: Sent[]; summary?: Summary } {
  const sig = logSignature(file);
  const hit = parsed.get(file);
  if (hit && sig && hit.sig === sig) {
    parsed.delete(file); // most recently used last
    parsed.set(file, hit);
    return hit;
  }
  const sent: Sent[] = [];
  let summary: Summary | undefined;
  for (const line of (readText(file) ?? "").split("\n")) {
    const e = line ? parse(line) : undefined;
    if (!e) continue;
    if (isSummary(e)) summary = e;
    else sent.push(e);
  }
  parsed.delete(file);
  if (sig) {
    parsed.set(file, { sig, sent, summary });
    while (parsed.size > MAX_CACHED_LOGS) parsed.delete(parsed.keys().next().value!);
  }
  return { sent, summary };
}

const compacting = new Set<string>(); // files being compacted: one run at a time per log

export function recordMessage(kind: Kind, ts: number, text: string, now = new Date(), file: string = FILE, extra: Extra = {}): void {
  if (!text.trim()) return;
  appendLine(file, JSON.stringify({ ts, at: now.toISOString(), kind, text: text.slice(0, LIMITS.logEntry), ...(extra.by ? { by: extra.by } : {}), ...(extra.of ? { of: extra.of } : {}), ...(extra.cat ? { cat: extra.cat } : {}), ...(extra.addressed ? { addressed: true as const } : {}) } satisfies Sent));
}

// ---- edits and deletes ----

// Messages by timestamp (the first line of each; reactions, deletion markers and the ledger are no messages), the original an
// edit leads back to, and the originals whose author deleted them.
function index(sent: readonly Sent[]) {
  const byTs = new Map<number, Sent>();
  for (const e of sent) if (e.kind !== "reaction" && e.kind !== "delete" && !isLedger(e.kind) && !byTs.has(e.ts)) byTs.set(e.ts, e);
  const rootOf = (e: Sent): Sent => {
    let x = e;
    for (let i = 0; i < 64 && x.kind === "edit" && x.of !== undefined; i++) {
      const up = byTs.get(x.of);
      if (!up || up === x) break;
      x = up;
    }
    return x; // an edit whose original was folded away (compaction) is its own root
  };
  const deleted = new Set<Sent>();
  for (const e of sent) if (e.kind === "delete" && e.of !== undefined) {
    const target = byTs.get(e.of);
    if (target) deleted.add(rootOf(target));
  }
  return { byTs, rootOf, deleted };
}

/** A message and what became of it: every timestamp it has had, its newest text, whether its author deleted it. */
export interface Revisions {
  root: Sent; // the original line (or the oldest edit left, when the original is gone)
  latest: Sent; // the newest version
  stamps: number[]; // the original's timestamp and every edit's: all of them point at this one message
  deleted: boolean;
}

export function revisionsOf(ts: number, file: string = FILE): Revisions | undefined {
  const sent = readAll(file).sent;
  const ix = index(sent);
  const hit = ix.byTs.get(ts);
  if (!hit) return undefined;
  const root = ix.rootOf(hit);
  const chain = sent.filter((e) => ix.byTs.get(e.ts) === e && ix.rootOf(e) === root);
  return { root, latest: chain.at(-1)!, stamps: chain.map((e) => e.ts), deleted: ix.deleted.has(root) };
}

// Pure: the lines minus the messages their authors deleted (all versions of them); the deletion markers stay.
export function withoutDeleted(sent: readonly Sent[]): Sent[] {
  const ix = index(sent);
  if (!ix.deleted.size) return [...sent];
  return sent.filter((e) => !(ix.byTs.get(e.ts) === e && ix.deleted.has(ix.rootOf(e))));
}

// Pure: one line per message, with its newest text; edits and deletion markers are gone. For readers that count or learn from
// what people said (the dream): an edit is neither a second message nor evidence beside the version it replaced. An edit
// whose original is not among the lines is dropped too (what the dream learnt from the original is not undone, nothing new is learnt).
export function foldEdits(sent: readonly Sent[]): Sent[] {
  const ix = index(sent);
  const newest = new Map<Sent, Sent>();
  for (const e of sent) if (e.kind === "edit" && ix.byTs.get(e.ts) === e) newest.set(ix.rootOf(e), e);
  return sent.filter((e) => e.kind !== "edit" && e.kind !== "delete").map((e) => (newest.has(e) ? { ...e, text: newest.get(e)!.text } : e));
}

// The message a reaction, a quote or an edit points at, if it is still in the log: by the original's timestamp or any edit's, with the
// newest text. A message its author deleted is gone.
export function findMessage(ts: number, file: string = FILE): Sent | undefined {
  const r = revisionsOf(ts, file);
  if (!r || r.deleted) return undefined;
  return r.latest === r.root ? r.root : { ...r.root, text: r.latest.text };
}

// Everything said after `sinceIso` (all of it when undefined), oldest first. Conversation only: no ledger lines.
export const messagesSince = (sinceIso?: string, file: string = FILE): Sent[] => readAll(file).sent.filter((m) => !isLedger(m.kind) && (!sinceIso || m.at > sinceIso));

// Every line including the ledger, oldest first: for the gate (gate.ts) alone.
export const ledgerEntries = (file: string = FILE): readonly Sent[] => readAll(file).sent; // shared with the cache: read-only

// Pure: which of the lines (oldest first, a summary first of all) must go to get under the limit.
// Returns how many leading lines to fold into the summary, or 0 when the file is small enough.
export function planCompaction(lines: readonly string[], maxBytes: number, reserved = 0): number {
  const size = (l: string) => Buffer.byteLength(l) + 1;
  let total = lines.reduce((n, l) => n + size(l), 0) + reserved; // (`reserved`: bytes that stay whatever is folded, the journal lines kept verbatim)
  if (total <= maxBytes) return 0;
  const target = maxBytes * KEEP_AFTER_COMPACTION;
  let drop = 0;
  while (total > target && drop < lines.length - 1) total -= size(lines[drop++]!); // always keep the newest
  return drop;
}

// Pure: cap a model's summary to a number of words.
export function limitWords(text: string, words: number): string {
  const w = text.trim().split(/\s+/).filter(Boolean);
  return w.length <= words ? w.join(" ") : `${w.slice(0, words).join(" ")}…`;
}

// Fold the oldest messages into the summary when the file is over its limit. Safe to call often;
// one run at a time. Messages sent while the summary is being written are kept.
// Journal lines (what the assistant did) are not conversation, so no summary is written about them; they are kept VERBATIM instead, for `journalDays`, so "what did you do last
// week?" still has its answer after a busy month folded the chat. Pure: of the lines, the journal lines young enough, newest first up to `maxBytes`, back in order.
export function journalToKeep(dropped: readonly string[], journalDays: number, maxBytes: number, nowMs = Date.now()): string[] {
  const young = dropped.filter((l) => {
    const e = parse(l);
    return e && !isSummary(e) && e.kind === "journal" && nowMs - Date.parse(e.at) < journalDays * 86_400_000;
  });
  let used = 0;
  const keep: string[] = [];
  for (const l of young.reverse()) {
    used += Buffer.byteLength(l) + 1;
    if (used > maxBytes) break;
    keep.push(l);
  }
  return keep.reverse();
}

// The log of messages the assistant sent is bounded by size; older messages become one summary of at most SUMMARY_WORDS words.
export const LOG_MAX_BYTES = 1_000_000; // the owner's chat
export const GROUP_LOG_MAX_BYTES = 500_000; // per group (and per friend), the same size-bounding
export const SUMMARY_WORDS = 60;
const JOURNAL_KEEP_DAYS = 90; // journal lines (what the assistant DID, core/events.ts) survive log compaction verbatim this long; older ones go without a summary
export async function compactIfNeeded(summarize: Summarize, maxBytes = LOG_MAX_BYTES, file: string = FILE, journalDays = JOURNAL_KEEP_DAYS): Promise<boolean> {
  if (compacting.has(file)) return false;
  try {
    if (statSync(dataPath(file)).size <= maxBytes) return false; // the common case: nothing to read
  } catch {
    return false;
  }
  const lines = (readText(file) ?? "").split("\n").filter(Boolean);
  // The journal lines to keep are chosen first and reserved in the plan, so the file lands at ~70% of the limit WITH them (not 100%, which would compact again on the next append).
  const keepers = new Set(journalToKeep(lines, journalDays, maxBytes * 0.3));
  const restAt = lines.flatMap((l, i) => (keepers.has(l) ? [] : [i])); // (by position: two identical lines are two lines)
  const rest = restAt.map((i) => lines[i]!);
  const reserved = lines.reduce((n, l) => n + (keepers.has(l) ? Buffer.byteLength(l) + 1 : 0), 0);
  const drop = planCompaction(rest, maxBytes, reserved);
  if (drop === 0) return false;
  if (skipForCooldown("log summary")) return false; // usage limit: do not fold now (a failed summary would be replaced by a bare count for good)
  compacting.add(file);
  try {
    const old = rest.slice(0, drop).map(parse).filter((e): e is Sent | Summary => !!e);
    const previous = old.find(isSummary);
    const folded = old.filter((e): e is Sent => !isSummary(e) && !isLedger(e.kind)); // ledger lines are not worth a word in the summary
    let text: string;
    if (folded.length === 0) text = previous?.text ?? ""; // nothing to say about (only ledger or old journal lines go): no model call
    else
      try {
        text = limitWords(await summarize(previous, folded), SUMMARY_WORDS);
      } catch (e) {
        console.error("messages: could not summarize, keeping a count only:", (e as Error).message);
        text = "older messages, no summary available";
      }
    const summary: Summary | undefined = folded.length === 0 && !previous ? undefined : {
      kind: "summary",
      at: new Date().toISOString(),
      from: previous?.from ?? folded[0]?.at ?? new Date().toISOString(),
      to: folded.at(-1)?.at ?? previous?.to ?? new Date().toISOString(),
      count: (previous?.count ?? 0) + folded.length,
      text,
    };
    // Re-read: anything appended during the summary comes after the lines we folded.
    const now = (readText(file) ?? "").split("\n").filter(Boolean);
    // The file again, in order: the summary, then every line that is not folded (the kept journal lines and the rest after the folded ones). Lines appended meanwhile come last.
    const dropped = new Set(restAt.slice(0, drop));
    const kept = lines.filter((_, i) => !dropped.has(i));
    writeText(file, [...(summary ? [JSON.stringify(summary)] : []), ...kept, ...now.slice(lines.length)].join("\n") + "\n");
    return true;
  } finally {
    compacting.delete(file);
  }
}
