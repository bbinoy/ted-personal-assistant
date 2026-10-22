import { randomBytes } from "node:crypto";
import { KINDS, LIMITS, TaskError, checkDue, cleanDetails, insertImported, lineOf, nowOf, oneText, optText, readDb, told, writeDb, type ImportRow, type Item, type Scope } from "./store.ts";
import { addDays, parseLocal, todayIn, wallToUtc } from "./when.ts";

// The one-time import of tasks from another tool (the owner's Notion table) into the list, in TWO steps with the owner's yes between them. The model reads the other tool in chat (a connector only a model
// run can reach) and maps each row; `previewImport` has CODE check every row, drop what is already imported (by source_ref), set aside old finished rows and store the checked batch as pending in
// assistant.db (migration 4) with a code-written preview; only after the owner says yes does `commitImport(batchId)` insert exactly that batch, atomically, as the owner's own items (origin owner,
// source_kind import), each with its "added" history row and ONE journal line for the whole batch. Re-running is harmless: a source_ref already imported is never imported again. Nothing is deleted.

export const MAX_ROWS = 500;
const PENDING_MS = 48 * 3_600_000; // a preview older than this is stale: look again
const SHOWN = 15; // rows named in the preview
const OLD_DONE_DAYS = 30;

export const DONE_MODES = ["recent", "all", "none"] as const;
export type DoneMode = (typeof DONE_MODES)[number]; // recent: finished rows from the last 30 days (default); all: keep the history; none: open rows only

/** One row as the model maps it from the other tool. */
export interface RawRow {
  title?: unknown;
  kind?: unknown;
  due?: unknown;
  person?: unknown;
  status?: unknown;
  details?: unknown;
  source_ref?: unknown;
  done_on?: unknown;
}

interface Stored extends ImportRow {
  n: number; // the row's place in what the model sent (1-based): what a reason points at
}
export interface Summary {
  total: number;
  open: number;
  done: number;
  byKind: Record<string, number>;
  rejected: { n: number; title: string; reason: string }[];
  alreadyImported: number;
  skippedDone: number;
  doneMode: DoneMode;
}
export interface Preview {
  batchId: string;
  text: string; // the code-written preview, shown to the owner as is
  summary: Summary;
}

const rejectText = (e: unknown): string => (e instanceof TaskError ? e.message : "not a usable row");

function checkRow(raw: RawRow, n: number, zone: string): Stored {
  if (typeof raw !== "object" || raw === null) throw new TaskError("not an object");
  const str = (label: string, v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new TaskError(`${label} must be text`);
    return v;
  };
  const title = oneText("title", str("title", raw.title) ?? "", LIMITS.title);
  const sourceRef = oneText("source_ref", str("source_ref", raw.source_ref) ?? "", LIMITS.ref);
  const kind = (str("kind", raw.kind) ?? "task") as ImportRow["kind"];
  if (!KINDS.includes(kind)) throw new TaskError(`kind must be one of ${KINDS.join(", ")}`);
  const status = str("status", raw.status) ?? "open";
  if (status !== "open" && status !== "done") throw new TaskError("status must be open or done");
  const person = optText("person", str("person", raw.person), LIMITS.person) ?? null;
  const details = cleanDetails(str("details", raw.details)) ?? null;
  const due = checkDue(str("due", raw.due)?.trim() || undefined) ?? null;
  const doneOn = str("done_on", raw.done_on)?.trim() || undefined;
  if (doneOn && !/^\d{4}-\d{2}-\d{2}$/.test(doneOn)) throw new TaskError("done_on must be a day, YYYY-MM-DD");
  if (doneOn && !parseLocal(doneOn)) throw new TaskError("done_on is not a real date");
  const doneAt = status === "done" && doneOn ? wallToUtc(zone, doneOn, "12:00") : null;
  return { n, title, kind, details, due, person, status, doneAt, sourceRef };
}

const rowLine = (r: Stored): string => `- ${r.status === "done" ? "[done] " : ""}${r.title}${r.kind === "i_owe" ? ` (you owe ${r.person ?? "someone"})` : r.kind === "owed_to_me" ? ` (${r.person ?? "someone"} owes you)` : r.person ? ` (with ${r.person})` : ""}${r.due ? `, due ${r.due}` : ""}`;

/** Checks the model's mapped rows and stores the batch as pending. Writes nothing to the list. */
export function previewImport(scope: Scope, input: { source?: string; rows: readonly RawRow[]; done?: DoneMode }): Preview {
  const rows = input.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new TaskError("There are no rows to import: read the table first and pass every row.");
  if (rows.length > MAX_ROWS) throw new TaskError(`${rows.length} rows is more than one import takes (${MAX_ROWS}): import the open rows first, the history in a second run.`);
  const doneMode = input.done ?? "recent";
  if (!DONE_MODES.includes(doneMode)) throw new TaskError(`done must be one of ${DONE_MODES.join(", ")}.`);
  const source = oneText("source", input.source ?? "Notion", 40);
  const db = writeDb(scope.key);
  const now = nowOf(scope);
  const today = todayIn(now, scope.zone);
  const known = new Set(db.all<{ source_ref: string }>("SELECT source_ref FROM items WHERE source_kind = 'import' AND source_ref IS NOT NULL").map((r) => r.source_ref));
  const seen = new Set<string>();
  const keep: Stored[] = [];
  const rejected: Summary["rejected"] = [];
  let already = 0;
  let skippedDone = 0;
  const cutoff = wallToUtc(scope.zone, addDays(today, -OLD_DONE_DAYS), "00:00");
  rows.forEach((raw, i) => {
    const n = i + 1;
    let r: Stored;
    try {
      r = checkRow(raw, n, scope.zone);
    } catch (e) {
      rejected.push({ n, title: typeof raw?.title === "string" ? raw.title.slice(0, 60) : `row ${n}`, reason: rejectText(e) });
      return;
    }
    if (known.has(r.sourceRef)) return void already++;
    if (seen.has(r.sourceRef)) return void rejected.push({ n, title: r.title.slice(0, 60), reason: "the same source_ref appears twice in this batch" });
    seen.add(r.sourceRef);
    if (r.status === "done" && (doneMode === "none" || (doneMode === "recent" && (r.doneAt === null || r.doneAt < cutoff)))) return void skippedDone++;
    keep.push(r);
  });
  const open = keep.filter((r) => r.status === "open").length;
  const byKind: Record<string, number> = {};
  for (const r of keep) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const summary: Summary = { total: keep.length, open, done: keep.length - open, byKind, rejected, alreadyImported: already, skippedDone, doneMode };
  const live = db.num("SELECT COUNT(*) FROM items WHERE status IN ('suggested', 'open', 'snoozed')");
  const batchId = `imp-${randomBytes(3).toString("hex")}`;
  db.tx(() => {
    db.run("UPDATE pending_imports SET state = 'discarded' WHERE state = 'pending'"); // (a newer preview replaces an older one)
    db.run("INSERT INTO pending_imports (batch_id, source, state, created, rows, summary) VALUES (?, ?, 'pending', ?, ?, ?)", batchId, source, now, JSON.stringify(keep), JSON.stringify(summary));
  });
  const kinds = Object.entries(byKind).map(([k, c]) => `${c} ${k.replace(/_/g, " ")}`).join(", ");
  const lines = [
    `Import preview ${batchId} from ${source}: ${keep.length} item${keep.length === 1 ? "" : "s"} to import (${open} open, ${summary.done} done${kinds ? `; ${kinds}` : ""}). Today is ${today}.`,
    ...keep.slice(0, SHOWN).map(rowLine),
    ...(keep.length > SHOWN ? [`... and ${keep.length - SHOWN} more`] : []),
    ...(already ? [`Already imported earlier, left out: ${already}.`] : []),
    ...(skippedDone ? [`Finished rows left out: ${skippedDone} (${doneMode === "none" ? "open rows only" : `older than ${OLD_DONE_DAYS} days or undated`}). Preview again with done=all to keep that history.`] : []),
    ...(rejected.length ? [`Rejected (${rejected.length}):`, ...rejected.slice(0, SHOWN).map((x) => `- row ${x.n} '${x.title}': ${x.reason}`), ...(rejected.length > SHOWN ? [`... and ${rejected.length - SHOWN} more`] : [])] : []),
    ...(live + open > LIMITS.open ? [`Too many: the list holds ${LIMITS.open} open items at most and has ${live}; this batch cannot be imported as it is.`] : []),
    keep.length ? `Nothing has been imported yet. If the owner says yes, call import_tasks_commit with ${batchId}.` : "Nothing to import.",
  ];
  return { batchId, text: lines.join("\n"), summary };
}

export interface Committed {
  line: string; // the journal line: "Imported 42 tasks from Notion"
  text: string;
  imported: Item[];
  already?: boolean; // this batch was committed before: nothing happened now
}

/** Inserts the stored batch, all or none, and tells the journal once. A batch already committed does nothing; a source_ref imported in the meantime is skipped. */
export function commitImport(scope: Scope, batchId: string): Committed {
  const db = writeDb(scope.key);
  const now = nowOf(scope);
  const b = db.get<{ batch_id: string; source: string; state: string; created: number; rows: string; committed: number | null }>("SELECT * FROM pending_imports WHERE batch_id = ?", batchId);
  if (!b) throw new TaskError(`There is no import preview ${batchId.slice(0, 20)}: run import_tasks_preview first.`);
  if (b.state === "committed") return { line: `Already imported (preview ${b.batch_id})`, text: `Preview ${b.batch_id} was already imported; nothing was added again.`, imported: [], already: true };
  if (b.state === "discarded") throw new TaskError(`Preview ${b.batch_id} was replaced by a newer one: use the latest preview's number, or preview again.`);
  if (now - b.created > PENDING_MS) throw new TaskError(`Preview ${b.batch_id} is too old: run import_tasks_preview again.`);
  const rows = JSON.parse(b.rows) as Stored[];
  const out = db.tx(() => {
    const known = new Set(db.all<{ source_ref: string }>("SELECT source_ref FROM items WHERE source_kind = 'import' AND source_ref IS NOT NULL").map((r) => r.source_ref));
    const fresh = rows.filter((r) => !known.has(r.sourceRef));
    const live = db.num("SELECT COUNT(*) FROM items WHERE status IN ('suggested', 'open', 'snoozed')");
    if (live + fresh.filter((r) => r.status === "open").length > LIMITS.open) throw new TaskError(`The list holds ${LIMITS.open} open items at most: finish or drop some first, or import the open rows only.`);
    const items = fresh.map((r) => insertImported(db, { ...scope, viaTool: true }, r));
    db.run("UPDATE pending_imports SET state = 'committed', committed = ? WHERE batch_id = ?", now, batchId);
    return items;
  });
  for (const it of out) told({ ...scope, viaTool: true }, it.id, "added", lineOf("added", it, { zone: scope.zone, now })); // (audit rows only: the journal gets the one line below)
  const line = `Imported ${out.length} task${out.length === 1 ? "" : "s"} from ${b.source}`;
  const skipped = rows.length - out.length;
  const done = out.filter((i) => i.status === "done").length;
  return { line, imported: out, text: `${line}.\n${out.length - done} open, ${done} done.${skipped ? ` ${skipped} were already on the list and left alone.` : ""} From now on tasks live here; nothing is written back to ${b.source}.` };
}

/** The pending preview, if any (for a status line or a test). */
export function pendingImport(key: string): { batchId: string; source: string; created: number } | undefined {
  const r = readDb(key)?.get<{ batch_id: string; source: string; created: number }>("SELECT batch_id, source, created FROM pending_imports WHERE state = 'pending' ORDER BY created DESC LIMIT 1");
  return r && { batchId: r.batch_id, source: r.source, created: r.created };
}
