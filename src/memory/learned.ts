import { existsSync } from "node:fs";
import { join } from "node:path";
import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { OWNER_CONV, type ConvId } from "../core/convpaths.ts";
import type { Db } from "../core/db.ts";
import type { Plan } from "./dreamplan.ts";

// "What I learned overnight": the notes change without the person being asked (the nightly dream tidies and adds, a background look saves a note), and this makes that VISIBLE
// without nagging. CODE records each such change where it happens (recordDream, recordLook: a row in the conversation's assistant.db, learned_changes), and later ONE short list is built from
// the rows not yet told (planBatch / commitBatch): every conversation gets it as a fact in its next run (learnedFact, heartbeat/facts.ts),
// which says it in its own words (and so keeps quiet hours); the owner's daily brief gets it in its expert's context like any look. A row is told once (its `batch`), so nothing repeats. Taking one back is an ordinary chat turn (forget_note, undo_dream).
// Groups are off: their notes are shared, and what they keep stays as it was (nothing is recorded for one).

export const MAX_LISTED = 9; // one list holds at most this many (the rest go in the next one)
const STALE_MS = 7 * 86_400_000; // a change older than this unsummarised (no brief ran) is dropped, not told as news
const KEEP_MS = 60 * 86_400_000;
const GIST_MAX = 90;

export interface Change {
  seq: number;
  at: number;
  source: "dream" | "look";
  action: "add" | "update" | "merge" | "delete" | "undone";
  file: string;
  gist: string;
  merged: string[];
  outcome?: "undone" | "gone";
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

/** A look (an unattended run) saved or changed a note. One pending row per note: a second write before the list replaces the first. The note itself carries no mark. */
export function recordLook(conv: ConvId, file: string, created: boolean, gist: string, now: number): void {
  if (isGroupConv(conv)) return;
  const db = liveConvDb(conv);
  if (!db) return;
  db.tx(() => {
    const before = db.get<{ action: string }>("SELECT action FROM learned_changes WHERE source = 'look' AND file = ? AND batch IS NULL AND outcome IS NULL", file);
    db.run("DELETE FROM learned_changes WHERE source = 'look' AND file = ? AND batch IS NULL AND outcome IS NULL", file);
    db.run("INSERT INTO learned_changes (at, source, action, file, gist) VALUES (?, 'look', ?, ?, ?)", now, created || before?.action === "add" ? "add" : "update", file, oneLineGist(gist)); // (new tonight stays new)
  });
}

// ---- the list ----

export interface Batch {
  items: Change[];
  notes: string[]; // lines without a number (a dream that was undone)
  seqs: number[]; // every row this list settles (the stale ones too)
}

/** The rows not yet told, as a numbered list (at most MAX_LISTED), without writing anything. Changes that are no longer true (a note gone since) are skipped. */
export function planBatch(conv: ConvId, dir: string, now: number): Batch | undefined {
  if (isGroupConv(conv)) return undefined;
  const db = peekConvDb(conv);
  if (!db) return undefined;
  const rows = db.all<Row>("SELECT seq, at, source, action, file, gist, merged, outcome FROM learned_changes WHERE batch IS NULL AND outcome IS NULL ORDER BY seq");
  const items: Change[] = [];
  const notes: string[] = [];
  const seqs: number[] = [];
  for (const r of rows) {
    const c = changeOf(r);
    if (c.action === "undone") {
      notes.push(`the dream of ${c.gist} was undone (what it changed was put back)`);
      seqs.push(c.seq);
      continue;
    }
    const fresh = now - c.at < STALE_MS;
    const true_ = c.action === "delete" ? !existsSync(join(dir, c.file)) : existsSync(join(dir, c.file));
    if (!fresh || !true_) {
      seqs.push(c.seq); // settled without a word
      continue;
    }
    if (items.length >= MAX_LISTED) continue;
    items.push(c);
    seqs.push(c.seq);
  }
  return items.length || seqs.length ? { items, notes, seqs } : undefined;
}

/** Writes down that `batch` was told: its rows will not be listed again. Returns the batch id. */
export function commitBatch(conv: ConvId, batch: Batch, now: number): number | undefined {
  const db = liveConvDb(conv);
  if (!db) return undefined;
  return db.tx(() => {
    const id = db.run("INSERT INTO learned_batches (at) VALUES (?)", now).lastInsertRowid;
    const listed = new Set(batch.items.map((i) => i.seq));
    for (const seq of batch.seqs) db.run(listed.has(seq) ? "UPDATE learned_changes SET batch = ? WHERE seq = ?" : "UPDATE learned_changes SET batch = ?, outcome = 'gone' WHERE seq = ?", id, seq);
    prune(db, now);
    return id;
  });
}

function prune(db: Db, now: number): void {
  const old = "(SELECT id FROM learned_batches WHERE at < ?)";
  db.run(`DELETE FROM learned_changes WHERE batch IN ${old}`, now - KEEP_MS);
  db.run("DELETE FROM learned_batches WHERE at < ?", now - KEEP_MS);
}

// ---- the words ----

const name = (file: string) => file.replace(/\.md$/, "");
const verb = (i: Change): string =>
  i.action === "merge" ? `merged ${i.merged.length} note${i.merged.length === 1 ? "" : "s"}` : i.action === "delete" ? "forgotten" : i.action === "add" ? "saved" : "updated";

/** One line: "- people-anna: Anna moved to Lisbon (saved)". */
export const lineOf = (i: Change): string => `- ${name(i.file)}: ${i.gist} (${verb(i)})`;

/** The list as data for a run that says it in its own words. */
export const learnedBody = (items: readonly Change[], notes: readonly string[] = []): string => [...items.map(lineOf), ...notes.map((t) => `- ${t}`)].join("\n");

/** What changed in a conversation's notes on its own and it has not been told, as a fact block for a run's prompt (the owner's, a friend's), and `told` to call once the run spoke. undefined: nothing to tell (a group has none). */
export function learnedFact(conv: ConvId, dir: string, now: number): { text: string; told: () => void } | undefined {
  const batch = planBatch(conv, dir, now);
  if (!batch) return undefined;
  if (!batch.items.length && !batch.notes.length) return void commitBatch(conv, batch, now); // (only changes that no longer hold: settled without a word)
  return {
    text: `Notes of the person's that changed on their own since you last said so (the nightly dream's tidy-up, and what you saved while looking):\n${learnedBody(batch.items, batch.notes)}\nIn this message, tell the person about these changes, briefly and in your own voice: one short line each, or one line for several (in the daily brief, under its 🧠 Learned overnight section). Say how to undo one: "forget <note>", or "undo the dream" for the night's tidy-up. If you say nothing, it stays for the next run.`,
    told: () => void commitBatch(conv, batch, now),
  };
}

// ---- a whole-dream undo ----

/** The latest dream was undone (undo_dream, dreamapply.ts undoLatest). Its lines not yet told are never listed; if they were told, the next list says once that it was undone. The run is the latest dream's `at` (one run, one time). */
export function dreamUndone(conv: ConvId, now: number): void {
  if (isGroupConv(conv)) return;
  const db = liveConvDb(conv);
  if (!db) return;
  db.tx(() => {
    const run = db.get<{ at: number | null }>("SELECT MAX(at) AS at FROM learned_changes WHERE source = 'dream' AND action != 'undone' AND outcome IS NULL")?.at;
    if (run == null) return;
    const told = db.num("SELECT COUNT(*) FROM learned_changes WHERE source = 'dream' AND at = ? AND batch IS NOT NULL AND outcome IS NULL", run);
    db.run("UPDATE learned_changes SET outcome = 'undone' WHERE source = 'dream' AND at = ? AND outcome IS NULL", run);
    if (told > 0) db.run("INSERT INTO learned_changes (at, source, action, file, gist) VALUES (?, 'dream', 'undone', '', ?)", now, new Date(run).toISOString().slice(0, 10));
  });
}
