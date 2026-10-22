import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { OWNER_CONV, type ConvId } from "../core/convpaths.ts";
import type { Db } from "../core/db.ts";
import { parseNote } from "./notes.ts";
import type { Plan } from "./dreamplan.ts";

// "What I learned overnight": the notes change without the person being asked (the nightly dream tidies and adds, a background look saves an `origin: inferred` note), and this makes that VISIBLE
// without nagging. CODE records each such change where it happens (recordDream, recordInferred: a row in the conversation's assistant.db, learned_changes), and later ONE short list is built from
// the rows not yet told (planBatch / commitBatch): the owner gets it as a section of the daily brief (the `memory_changes_since_brief` tool), a friend as one message after her dream, held by quiet
// hours (conversation/learned.ts). A row is told once (its `batch`), so nothing repeats. Each line has a number; a reply "undo 2" or "confirm 1" is read by code (conversation/learnedreplies.ts).
// Groups are off: their notes are shared, and what they keep stays as it was (nothing is recorded for one). Inferred notes the person never confirms are unchanged: weighed less, no expiry here.

export const MAX_LISTED = 9; // one list holds at most this many (the rest go in the next one)
const STALE_MS = 7 * 86_400_000; // a change older than this unsummarised (no brief ran) is dropped, not told as news
const KEEP_MS = 60 * 86_400_000;
const GIST_MAX = 90;

export interface Change {
  seq: number;
  at: number;
  source: "dream" | "inferred";
  action: "add" | "update" | "merge" | "delete";
  file: string;
  gist: string;
  merged: string[];
  outcome?: "confirmed" | "undone" | "gone";
}

interface Row {
  seq: number;
  at: number;
  source: Change["source"];
  action: Change["action"];
  file: string;
  gist: string;
  merged: string | null;
  outcome: Change["outcome"] | null;
}
const changeOf = (r: Row): Change => ({ seq: r.seq, at: r.at, source: r.source, action: r.action, file: r.file, gist: r.gist, merged: r.merged ? (JSON.parse(r.merged) as string[]) : [], ...(r.outcome ? { outcome: r.outcome } : {}) });

// A conversation that is a group (conv ids: group-<hash>): nothing is recorded, nothing summarised.
export const isGroupConv = (conv: ConvId): boolean => conv.startsWith("group-");
export const isOwnerConv = (conv: ConvId): boolean => conv === OWNER_CONV;

const oneLineGist = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= GIST_MAX ? t : `${t.slice(0, GIST_MAX - 1).replace(/[\s,;:.-]+$/, "")}…`;
};

// ---- recording (at the source) ----

/** The dream applied `plan` (the notes folder is `dir`, to see what really landed): its adds, updates, merges and forgets. The deletes a merge makes are the merge's own and are not listed twice. */
export function recordDream(conv: ConvId, plan: Plan, dir: string, now: number): number {
  if (isGroupConv(conv)) return 0;
  const db = liveConvDb(conv);
  if (!db) return 0;
  let n = 0;
  db.tx(() => {
    for (const a of plan.actions) {
      const there = existsSync(join(dir, a.file));
      if (a.kind === "delete") {
        if (there || a.why.startsWith("merged into")) continue; // (a skipped one is still there; a merge's source is told by the merge)
        db.run("INSERT INTO learned_changes (at, source, action, file, gist) VALUES (?, 'dream', 'delete', ?, ?)", now, a.file, oneLineGist(a.why));
      } else {
        if (!there) continue;
        db.run("INSERT INTO learned_changes (at, source, action, file, gist, merged) VALUES (?, 'dream', ?, ?, ?, ?)", now, a.kind, a.file, oneLineGist(a.description), a.merged.length ? JSON.stringify(a.merged) : null);
      }
      n++;
    }
  });
  return n;
}

/** A background look saved or updated an inferred note (write_note). One pending row per note: a second write the same night replaces the first. */
export function recordInferred(conv: ConvId, file: string, created: boolean, gist: string, now: number): void {
  if (isGroupConv(conv)) return;
  const db = liveConvDb(conv);
  if (!db) return;
  db.tx(() => {
    const before = db.get<{ action: string }>("SELECT action FROM learned_changes WHERE source = 'inferred' AND file = ? AND batch IS NULL AND outcome IS NULL", file);
    db.run("DELETE FROM learned_changes WHERE source = 'inferred' AND file = ? AND batch IS NULL AND outcome IS NULL", file);
    db.run("INSERT INTO learned_changes (at, source, action, file, gist) VALUES (?, 'inferred', ?, ?, ?)", now, created || before?.action === "add" ? "add" : "update", file, oneLineGist(gist)); // (new tonight stays new)
  });
}

// ---- the list ----

export interface Item extends Change {
  n: number;
}
export interface Batch {
  items: Item[];
  seqs: number[]; // every row this list settles (the stale ones too)
}

const gistOfNote = (raw: string, file: string): string | undefined => {
  const m = /^description:\s*(.+)$/m.exec(raw.split(/\n---\n/)[0] ?? "");
  if (!m) return parseNote(file, raw)?.text.split("\n")[0];
  try {
    return String(JSON.parse(m[1]!));
  } catch {
    return m[1]!.replace(/^["']|["']$/g, "");
  }
};

/** Is this note still an unconfirmed guess of the assistant's? (read from the folder: the person may have confirmed or forgotten it since) */
export function isStillInferred(dir: string, file: string): boolean {
  try {
    return !!parseNote(file, readFileSync(join(dir, file), "utf8"))?.inferred;
  } catch {
    return false;
  }
}

/** The rows not yet told, as a numbered list (at most MAX_LISTED), without writing anything. Changes that are no longer true (an inferred note forgotten or confirmed since, a note gone) are skipped. */
export function planBatch(conv: ConvId, dir: string, now: number): Batch | undefined {
  if (isGroupConv(conv)) return undefined;
  const db = peekConvDb(conv);
  if (!db) return undefined;
  const rows = db.all<Row>("SELECT seq, at, source, action, file, gist, merged, outcome FROM learned_changes WHERE batch IS NULL AND outcome IS NULL ORDER BY seq");
  const items: Item[] = [];
  const seqs: number[] = [];
  for (const r of rows) {
    const c = changeOf(r);
    const fresh = now - c.at < STALE_MS;
    const true_ = c.source === "inferred" ? isStillInferred(dir, c.file) : c.action === "delete" ? !existsSync(join(dir, c.file)) : existsSync(join(dir, c.file));
    if (!fresh || !true_) {
      seqs.push(c.seq); // settled without a word
      continue;
    }
    if (items.length >= MAX_LISTED) continue;
    const live = c.source === "inferred" && c.action !== "delete" ? gistOfNote(readFileSync(join(dir, c.file), "utf8"), c.file) : undefined; // (the note as it is now, in case it was updated again)
    items.push({ ...c, ...(live ? { gist: oneLineGist(live) } : {}), n: items.length + 1 });
    seqs.push(c.seq);
  }
  return items.length || seqs.length ? { items, seqs } : undefined;
}

/** Writes down that `batch` was told (as message `ts`, if it went as one): its rows will not be listed again, and its numbers answer replies. Returns the batch id. */
export function commitBatch(conv: ConvId, batch: Batch, now: number, ts?: number): number | undefined {
  const db = liveConvDb(conv);
  if (!db) return undefined;
  return db.tx(() => {
    const id = db.run("INSERT INTO learned_batches (at, msg_ts) VALUES (?, ?)", now, ts ?? null).lastInsertRowid;
    const listed = new Map(batch.items.map((i) => [i.seq, i.n]));
    for (const seq of batch.seqs) {
      if (listed.has(seq)) {
        db.run("UPDATE learned_changes SET batch = ? WHERE seq = ?", id, seq);
        db.run("INSERT INTO learned_asks (batch, n, seq) VALUES (?, ?, ?)", id, listed.get(seq)!, seq);
      } else db.run("UPDATE learned_changes SET batch = ?, outcome = 'gone' WHERE seq = ?", id, seq);
    }
    prune(db, now);
    return id;
  });
}

function prune(db: Db, now: number): void {
  const old = "(SELECT id FROM learned_batches WHERE at < ?)";
  db.run(`DELETE FROM learned_asks WHERE batch IN ${old}`, now - KEEP_MS);
  db.run(`DELETE FROM learned_changes WHERE batch IN ${old}`, now - KEEP_MS);
  db.run("DELETE FROM learned_batches WHERE at < ?", now - KEEP_MS);
}

// ---- the words ----

const name = (file: string) => file.replace(/\.md$/, "");
const verb = (i: Item): string =>
  i.source === "inferred" ? (i.action === "add" ? "inferred" : "inferred, updated") : i.action === "merge" ? `merged ${i.merged.length} note${i.merged.length === 1 ? "" : "s"}` : i.action === "delete" ? "forgotten" : i.action === "add" ? "saved" : "updated";

/** One line: "1. people-anna: Anna moved to Lisbon (inferred)". */
export const lineOf = (i: Item): string => `${i.n}. ${name(i.file)}: ${i.gist} (${verb(i)})`;

/** The reply hint, with numbers that exist: 'undo N' always, 'confirm N' only when a guess is listed. */
export function hintOf(items: readonly Item[]): string {
  const guess = items.find((i) => i.source === "inferred");
  return `Reply 'undo ${items[0]!.n}' to take one back${guess ? ` or 'confirm ${guess.n}' to keep an inferred note as yours` : ""}.`;
}

/** The list as it goes into the brief (under the section's own heading): the lines and the hint. */
export const learnedBody = (items: readonly Item[]): string => [...items.map(lineOf), hintOf(items)].join("\n");

/** The list as a message of its own (a friend's, after her dream). */
export const learnedMessage = (items: readonly Item[]): string => `🧠 Learned overnight\n${learnedBody(items)}`;

// ---- answering ----

export interface Ask {
  n: number;
  change: Change;
  batch: number;
}

/** The list a reply is about: the one that carried message `ts` (a quote), else the latest one told within `withinMs`. undefined: none. */
export function batchFor(conv: ConvId, ts: number | undefined, now: number, withinMs: number): { id: number; at: number; viaQuote: boolean } | undefined {
  const db = peekConvDb(conv);
  if (!db) return undefined;
  if (ts) {
    const q = db.get<{ id: number; at: number }>("SELECT id, at FROM learned_batches WHERE msg_ts = ?", ts);
    return q ? { ...q, viaQuote: true } : undefined;
  }
  const l = db.get<{ id: number; at: number }>("SELECT id, at FROM learned_batches b WHERE at > ? AND EXISTS (SELECT 1 FROM learned_asks WHERE batch = b.id) ORDER BY id DESC LIMIT 1", now - withinMs);
  return l ? { ...l, viaQuote: false } : undefined;
}

export function askOf(conv: ConvId, batch: number, n: number): Ask | undefined {
  const r = peekConvDb(conv)?.get<Row & { n: number }>("SELECT c.seq, c.at, c.source, c.action, c.file, c.gist, c.merged, c.outcome, a.n FROM learned_asks a JOIN learned_changes c ON c.seq = a.seq WHERE a.batch = ? AND a.n = ?", batch, n);
  return r ? { n, change: changeOf(r), batch } : undefined;
}

export const settleChange = (conv: ConvId, seq: number, outcome: "confirmed" | "undone"): void => void liveConvDb(conv)?.run("UPDATE learned_changes SET outcome = ? WHERE seq = ?", outcome, seq);

/** The latest list that has no message of its own (it went in the brief), told within `withinMs`, for the brief tool to hand out again if the brief is redone. */
export function recentBriefBatch(conv: ConvId, dir: string, now: number, withinMs: number): Item[] | undefined {
  const db = peekConvDb(conv);
  const b = db?.get<{ id: number }>("SELECT id FROM learned_batches b WHERE msg_ts IS NULL AND at > ? AND EXISTS (SELECT 1 FROM learned_asks WHERE batch = b.id) ORDER BY id DESC LIMIT 1", now - withinMs);
  if (!db || !b) return undefined;
  const items = db.all<{ n: number }>("SELECT n FROM learned_asks WHERE batch = ? ORDER BY n", b.id).map((r) => askOf(conv, b.id, r.n)).filter((a): a is Ask => !!a && a.change.outcome === undefined && (a.change.source !== "inferred" || isStillInferred(dir, a.change.file))).map((a) => ({ ...a.change, n: a.n }));
  return items.length ? items : undefined;
}

/** The brief's section (the `memory_changes_since_brief` tool): the changes not yet told, as the lines and the hint, written down as told. Asked again within REDO_MS (the brief was redone) the same list is handed out again. Empty: nothing to tell. */
const REDO_MS = 6 * 3_600_000;
export function briefLearned(conv: ConvId, dir: string, now: number): string {
  if (isGroupConv(conv)) return "";
  const batch = planBatch(conv, dir, now);
  if (batch) commitBatch(conv, batch, now); // (a batch of changes that no longer hold is settled without a word)
  if (batch?.items.length) return learnedBody(batch.items);
  const again = recentBriefBatch(conv, dir, now, REDO_MS);
  return again ? learnedBody(again) : "";
}
