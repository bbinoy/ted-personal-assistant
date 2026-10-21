import { foldEdits, withoutDeleted, type Kind, type Sent } from "../core/messages.ts";
import { settings } from "../core/settings.ts";
import { dataPath } from "../core/state.ts";
import { convPaths, OWNER_CONV } from "../core/convpaths.ts";
import { FILE } from "../core/messages.ts";
import { clockIn, dayIn, systemZone, timeIn } from "../core/timezone.ts";
import { NOTES_DIR } from "./notes.ts";
import { authorLabels, orExpr, phraseExpr, SearchIndex, speakerOf, type Doc, type Filters } from "./searchindex.ts";
import { fold, queryStems, sentences, stem, stems } from "./searchtext.ts";

// Search over ONE conversation's history and memory notes: ranked by relevance, not an all-words grep.
//   The calling model does the understanding (it knows "restaurant" may be "dinner" or "trattoria" in the chat): it passes `query` and
//   `alsoTry` (related words, weighted lower). Code does the finding and ordering: FTS5 gives candidates (searchindex.ts), then BM25 with
//   those weights, a coverage and a phrase/near bonus and a recency boost order them, and a short sentence-level snippet is cut for each.
//   A "quoted phrase" in the query is a hard requirement (the old exact match).
//   Scope is the one `Scope` handed in: its log and its notes folder and its own index file. Nothing here can name another conversation.
//   Deleted messages are left out and an edited one shows its newest text (the messages.ts functions, not a second reading of the rules).

export interface Scope {
  logFile: string; // as messages.ts takes it: an absolute path (convpaths.ts messages)
  notesDir: string;
  indexPath: string; // this conversation's index (a cache; deleted and rebuilt when wrong)
}

export interface SearchArgs {
  query?: string;
  alsoTry?: readonly string[];
  who?: string;
  since?: string; // YYYY-MM-DD or YYYY-MM-DDTHH:MM in the conversation's time zone (or with an explicit Z / offset)
  until?: string; // a bare date includes that whole day
  sinceHours?: number;
  limit?: number;
  maxChars?: number;
}

export interface Term { w: string; weight: number }
export interface Query { terms: Term[]; phrases: string[] } // phrases: folded text that must appear
export interface RankDoc { tokens: string[]; text: string }
export interface Corpus { n: number; avgdl: number; df: (w: string) => number }

/** The seam for a smarter ranker (ARCHITECTURE.md, Memory): relevance of each candidate to the query, 0 for "not about it". The default is BM25. */
export interface Ranker {
  name: string;
  score(q: Query, docs: readonly RankDoc[], corpus: Corpus): number[];
}

const ALSO_WEIGHT = 0.6;
const CANDIDATES = 500;
const SNIPPET_CHARS = 280;
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 30;
export const DEFAULT_CHARS = 4000;
export const MAX_CHARS = 8000;

export function parseQuery(query: string | undefined, alsoTry: readonly string[] = []): Query {
  const phrases: string[] = [];
  const rest = (query ?? "").replace(/["“”]([^"“”]+)["“”]/g, (_, p: string) => (phrases.push(fold(p).replace(/\s+/g, " ").trim()), " "));
  const weights = new Map<string, number>();
  const add = (text: string, weight: number) => { for (const w of queryStems(text)) weights.set(w, Math.max(weights.get(w) ?? 0, weight)); };
  add(rest, 1);
  for (const p of phrases) add(p, 1);
  for (const a of alsoTry.slice(0, 30)) add(a, ALSO_WEIGHT);
  return { terms: [...weights].map(([w, weight]) => ({ w, weight })), phrases: phrases.filter(Boolean) };
}

// BM25 (k1 1.2, b 0.75) with a weight per query term, times a coverage factor (how much of the query's weight the line has) and a near factor
// (the matched terms close together, 1.4x when adjacent).
export const bm25Ranker: Ranker = {
  name: "bm25",
  score(q, docs, corpus) {
    const weight = new Map(q.terms.map((t) => [t.w, t.weight]));
    const total = q.terms.reduce((s, t) => s + t.weight, 0) || 1;
    const idf = new Map<string, number>();
    for (const t of q.terms) { const df = corpus.df(t.w); idf.set(t.w, Math.log(1 + (corpus.n - df + 0.5) / (df + 0.5))); }
    return docs.map((d) => {
      const tf = new Map<string, number>();
      const hits: { pos: number; w: string }[] = [];
      d.tokens.forEach((tok, pos) => { if (weight.has(tok)) { tf.set(tok, (tf.get(tok) ?? 0) + 1); hits.push({ pos, w: tok }); } });
      if (!tf.size) return 0;
      let s = 0;
      let got = 0;
      for (const [w, f] of tf) { s += weight.get(w)! * idf.get(w)! * ((f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.tokens.length) / corpus.avgdl))); got += weight.get(w)!; }
      return s * (1 + got / total) * nearFactor(hits, tf.size);
    });
  },
};

// 1.4 when the matched terms sit next to each other, falling to 1 when the smallest window holding them all is 7 words wider than they are.
export function nearFactor(hits: readonly { pos: number; w: string }[], distinct: number): number {
  if (distinct < 2) return 1;
  const have = new Map<string, number>();
  let best = Infinity;
  for (let lo = 0, hi = 0; hi < hits.length; hi++) {
    have.set(hits[hi]!.w, (have.get(hits[hi]!.w) ?? 0) + 1);
    while (have.size === distinct) {
      best = Math.min(best, hits[hi]!.pos - hits[lo]!.pos + 1);
      const c = have.get(hits[lo]!.w)! - 1;
      if (c) have.set(hits[lo]!.w, c);
      else have.delete(hits[lo]!.w);
      lo++;
    }
  }
  const extra = best - distinct;
  return extra <= 6 ? 1 + 0.4 * (1 - extra / 7) : 1;
}

const recency = (t: number, now: number) => 1 + 0.3 * 0.5 ** (Math.max(0, now - t) / 86_400_000 / 90); // up to +30% for today, half of that after 90 days

// ---- dates ----

// The instant a wall-clock time has in `zone` (the offset is looked up twice, so a clock change between the guess and the answer is right too).
function localMs(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const c = clockIn(new Date(guess), zone);
    guess += wall - Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute);
  }
  return guess;
}

function when(text: string | undefined, end: boolean, zone: string): number | undefined | "bad" {
  if (!text?.trim()) return undefined;
  const t = text.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return m[4] === undefined ? localMs(y, mo, d + (end ? 1 : 0), 0, 0, zone) - (end ? 1 : 0) : localMs(y, mo, d, Number(m[4]), Number(m[5]), zone);
  }
  const ms = /(Z|[+-]\d\d:?\d\d)$/.test(t) ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : "bad";
}

// ---- results ----

export interface Hit {
  ref: string; // "#<Signal timestamp>" of a message, "note:<file>" of a note
  at: number;
  author: string;
  text: string; // the snippet
  score: number;
}
export interface Found { hits: Hit[]; total: number; searched: number; error?: string }

const authorOf = (kind: string, by: string, text: string): { author: string; body: string } => {
  const speaker = kind === "member" || kind === "edit" ? speakerOf(text) : "";
  if (speaker) return { author: speaker, body: text.slice(text.indexOf(":") + 1).trim() };
  const author = kind === "owner" ? "owner" : kind === "chat" ? settings.assistant : kind === "member" || kind === "edit" ? by || "member" : kind === "summary" ? "earlier history (summary)" : `${settings.assistant} (${kind})`;
  return { author, body: text };
};

// The sentence(s) around the best match, at most ~280 characters.
export function snippet(text: string, q: Query, max = SNIPPET_CHARS): string {
  const weight = new Map(q.terms.map((t) => [t.w, t.weight]));
  const flat = text.replace(/[ \t]+/g, " ").trim();
  if (flat.length <= max) return flat.replace(/\n+/g, " / ");
  const ss = sentences(flat);
  let best = 0;
  let bestScore = -1;
  ss.forEach((x, i) => { const seen = new Set(stems(x.s)); let sc = 0; for (const [w, wt] of weight) if (seen.has(w)) sc += wt; if (sc > bestScore) { bestScore = sc; best = i; } });
  let lo = best;
  let hi = best;
  const len = () => ss.slice(lo, hi + 1).reduce((n, x) => n + x.s.length + 1, 0);
  for (let grew = true; grew; ) {
    grew = false;
    if (hi + 1 < ss.length && len() + ss[hi + 1]!.s.length < max) { hi++; grew = true; }
    if (lo > 0 && len() + ss[lo - 1]!.s.length < max) { lo--; grew = true; }
  }
  let out = ss.slice(lo, hi + 1).map((x) => x.s).join(" ");
  if (out.length > max) { // one long sentence: a window around the first query word in it
    const m = [...out.matchAll(/[\p{L}\p{N}]+/gu)].find((w) => weight.has(stem(fold(w[0]))));
    const from = Math.max(0, (m?.index ?? 0) - Math.floor(max / 3));
    out = `${from ? "…" : ""}${out.slice(from, from + max)}…`;
  } else {
    if (lo > 0) out = `…${out}`;
    if (hi < ss.length - 1) out = `${out}…`;
  }
  return out.replace(/\n+/g, " / ");
}

const toSent = (d: Doc): Sent => ({ ts: d.ts, at: new Date(d.t).toISOString(), kind: d.kind as Kind, text: d.text, ...(d.by ? { by: d.by } : {}), ...(d.of ? { of: d.of } : {}) });

// The message each candidate stands for, as it reads now: an edit leads back to its original (shown with the newest text), a deleted message is gone.
// The edits and deletion markers are few, so all of them are read; messages.ts does the folding.
function resolve(idx: SearchIndex, cands: readonly Doc[]): Map<number, Doc & { latest: string }> {
  const known = new Map<number, Doc>(); // by id
  const byTs = new Map<number, Doc>();
  const take = (d: Doc) => { if (!known.has(d.id)) { known.set(d.id, d); if (d.kind !== "delete" && !byTs.has(d.ts)) byTs.set(d.ts, d); } };
  const marks = idx.edits();
  for (const d of [...cands, ...marks]) take(d);
  for (let round = 0; round < 8; round++) { // the originals the markers point at, and theirs
    const want = [...new Set([...known.values()].map((d) => d.of).filter((o) => o && !byTs.has(o)))];
    if (!want.length) break;
    const before = known.size;
    for (const d of idx.byTs(want)) take(d);
    if (known.size === before) break;
  }
  const docs = [...known.values()].sort((a, b) => a.id - b.id);
  const visible = foldEdits(withoutDeleted(docs.map(toSent)));
  const alive = new Map<number, string>(); // an original's timestamp -> its newest text
  for (const s of visible) if (!alive.has(s.ts)) alive.set(s.ts, s.text);
  const rootOf = (d: Doc): Doc => { let x = d; for (let i = 0; i < 64 && x.kind === "edit" && x.of; i++) { const up = byTs.get(x.of); if (!up || up === x) break; x = up; } return x; };
  const out = new Map<number, Doc & { latest: string }>();
  for (const c of cands) {
    const root = rootOf(c);
    const latest = alive.get(root.ts);
    if (root.kind === "edit") continue; // an edit whose original is gone: dropped, as foldEdits does
    if (latest !== undefined && !out.has(root.ts)) out.set(root.ts, { ...root, latest });
  }
  return out;
}

async function run(idx: SearchIndex, args: SearchArgs, scope: Scope, now: number, ranker: Ranker, zone: string): Promise<Found> {
  const from = args.sinceHours && args.sinceHours > 0 ? now - args.sinceHours * 3_600_000 : when(args.since, false, zone);
  const to = when(args.until, true, zone);
  if (from === "bad" || to === "bad") return { hits: [], total: 0, searched: 0, error: "since and until must be dates like 2026-10-01." };
  const f: Filters = { sources: ["m", "n"], from, to, who: args.who };
  await idx.syncLog(scope.logFile);
  await idx.syncNotes(scope.notesDir, dayIn(new Date(now), zone));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit ?? DEFAULT_LIMIT)));
  const q = parseQuery(args.query, args.alsoTry);
  const searched = idx.stats().n;
  const phraseOnly = q.phrases.map((p) => stems(p));
  const mustHave = (text: string) => q.phrases.every((p) => fold(text).replace(/\s+/g, " ").includes(p));

  let docs: (Doc & { latest?: string })[];
  if (!q.terms.length) docs = idx.latest(f, limit * 4);
  else {
    const expr = phraseOnly.length ? phraseOnly.map((p) => phraseExpr(p)).join(" AND ") : orExpr(q.terms.map((t) => t.w));
    docs = idx.candidates(expr, f, CANDIDATES);
  }
  const msgs = resolve(idx, docs.filter((d) => d.src === "m"));
  const base: (Doc & { latest?: string })[] = [...docs.filter((d) => d.src === "n"), ...msgs.values()];
  const rows: { d: Doc & { latest?: string }; text: string }[] = [];
  const seen = new Set<string>();
  for (const d of base) {
    const text = d.latest ?? d.text;
    const key = d.src === "n" ? `n${d.name}` : `m${d.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (d.src === "m") { // after folding, the author and the time are the original's; the filters hold for it too
      if (f.who && !authorLabels(d.kind, d.by, text).includes(f.who.toLowerCase().trim())) continue;
      if ((from !== undefined && d.t < from) || (to !== undefined && d.t > to)) continue;
    }
    if (mustHave(text)) rows.push({ d, text });
  }

  let scored: { row: (typeof rows)[number]; score: number }[];
  if (!q.terms.length) scored = rows.map((row) => ({ row, score: row.d.t })).sort((a, b) => b.score - a.score);
  else {
    const stat = idx.stats();
    const dfs = new Map<string, number>();
    const corpus: Corpus = { n: stat.n, avgdl: stat.avgdl, df: (w) => dfs.get(w) ?? (dfs.set(w, idx.df(w)), dfs.get(w)!) };
    const rel = ranker.score(q, rows.map((r) => ({ tokens: stems(`${r.d.src === "n" ? `${r.d.name.replace(/\.md$/, "").replace(/[-_]/g, " ")} ` : ""}${r.text}`), text: r.text })), corpus);
    scored = rows.map((row, i) => ({ row, score: rel[i]! * (row.d.src === "m" ? recency(row.d.t, now) : 1) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  }
  const hits: Hit[] = scored.map(({ row, score }) => {
    const { d } = row;
    if (d.src === "n") return { ref: `note:${d.name}`, at: d.t, author: "note", text: snippet(row.text, q), score };
    const { author, body } = authorOf(d.kind, d.by, row.text);
    return { ref: `#${d.ts}`, at: d.t, author, text: snippet(body, q), score };
  });
  return { hits, total: hits.length, searched };
}

const stamp = (ms: number, zone: string) => `${dayIn(new Date(ms), zone)} ${timeIn(new Date(ms), zone)}`;

/** The answer as text for the model: best first, within `maxChars`, with the number left over. */
export function renderFound(found: Found, args: SearchArgs, zone: string = systemZone()): string {
  if (found.error) return found.error;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit ?? DEFAULT_LIMIT)));
  const cap = Math.max(500, Math.min(MAX_CHARS, Math.floor(args.maxChars ?? DEFAULT_CHARS)));
  if (!found.hits.length) {
    const tip = args.alsoTry?.length ? "" : " Try again with alsoTry: related words, synonyms, a name or a place the thing might have been called.";
    return `No matching messages or notes (searched ${found.searched} entries).${tip}`;
  }
  const lines: string[] = [];
  let used = 0;
  const latestFirst = !(args.query ?? "").trim() && !args.alsoTry?.length;
  for (const h of found.hits.slice(0, limit)) {
    const line = `${latestFirst ? "" : `${lines.length + 1}. `}[${h.ref.startsWith("note:") ? `${h.ref}, saved ${stamp(h.at, zone).slice(0, 10)}` : `${h.ref} ${stamp(h.at, zone)}`}] ${h.author === "note" ? "" : `${h.author}: `}${h.text}`;
    if (lines.length && used + line.length > cap) break;
    lines.push(line);
    used += line.length + 1;
  }
  const more = found.total - lines.length;
  return `${found.total} match${found.total === 1 ? "" : "es"}, ${latestFirst ? "the latest, newest last" : "best first"} (times in ${zone}):\n${(latestFirst ? lines.reverse() : lines).join("\n")}${more > 0 ? `\n${more} more not shown: narrow it with who, since, until or a more exact query, or raise limit.` : ""}`;
}

// One search or build at a time per index file (two connections writing the same file would lock each other out); later ones wait their turn.
const turns = new Map<string, Promise<unknown>>();
function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (turns.get(key) ?? Promise.resolve()).then(work);
  const tail = run.catch(() => undefined);
  turns.set(key, tail);
  void tail.then(() => { if (turns.get(key) === tail) turns.delete(key); });
  return run;
}

/** Searches one conversation, in the conversation's time zone. The index is built or brought up to date first, in slices that leave the event loop free. Never throws for a bad index: a file that does not work is rebuilt once, and then the error is reported as text. */
export function searchConversation(scope: Scope, args: SearchArgs, opts: { now?: number; ranker?: Ranker; zone?: string } = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const ranker = opts.ranker ?? bm25Ranker;
  const zone = opts.zone ?? systemZone();
  const attempt = async (): Promise<Found> => {
    const idx = SearchIndex.open(scope.indexPath);
    try { return await run(idx, args, scope, now, ranker, zone); } finally { idx.close(); }
  };
  return inTurn(scope.indexPath, async () => {
    let found: Found;
    try {
      found = await attempt();
    } catch {
      SearchIndex.remove(scope.indexPath); // damaged under us (a torn write, a full disk, another version): start over once
      try { found = await attempt(); } catch { return "The search index could not be built; try again later."; }
    }
    return renderFound(found, args, zone);
  });
}

/** Brings a conversation's index up to date without searching (the owner's, shortly after start-up, so the first real search is quick). */
export function warmSearchIndex(scope: Scope, zone: string = systemZone()): Promise<void> {
  return inTurn(scope.indexPath, async () => {
    const attempt = async () => {
      const idx = SearchIndex.open(scope.indexPath);
      try {
        await idx.syncLog(scope.logFile);
        await idx.syncNotes(scope.notesDir, dayIn(new Date(), zone));
      } finally { idx.close(); }
    };
    try { await attempt(); } catch { SearchIndex.remove(scope.indexPath); await attempt(); }
  });
}

/** The owner's conversation: messages.jsonl, memory/notes, state/search.sqlite. */
export const ownerSearchScope = (): Scope => ({ logFile: FILE, notesDir: NOTES_DIR, indexPath: convPaths(OWNER_CONV).search });
