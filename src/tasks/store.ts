import type { Source } from "../core/audit.ts";
import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { convIdOfKey } from "../core/convpaths.ts";
import { emit, type Why } from "../core/events.ts";
import { clean, oneLine } from "../core/sanitize.ts";
import type { Db } from "../core/db.ts";
import { nextDue, nextInstant, parseRepeat } from "./repeat.ts";
import { isZone, localOf, parseLocal, showInstant, showLocal, todayIn, wallToUtc } from "./when.ts";

// The tasks of ONE conversation: a typed API over the `items` and `task_events` tables of its assistant.db (core/convdb.ts migration 2, docs/ARCHITECTURE.md "Tasks"). Three kinds of item: a
// task, a promise the person made (i_owe) and something owed to them (owed_to_me). Every mutation is ONE transaction that changes the item AND appends a task_events row (before/after of the
// changed fields), then tells the event stream (a `task` event: the audit row and the journal line). Nothing is ever deleted: `dropped` is the end state (the tables have triggers that refuse a
// DELETE, and this file has no path to one). A conversation can only reach its own file: the key names it, there is no other connection (convdb.ts).
//
// Who may do what is decided here too, in code, below the tools: an `inferred` origin (a background look, the mail handler) can only ADD, and what it adds is a `suggested` item that the
// person confirms or rejects; it can neither change nor finish nor drop anything. The tool layer and the permission floor say the same, this is the part that cannot be bypassed.
//
// Dates are LOCAL wall times in the conversation's zone ("2026-10-24" or "2026-10-24T14:30", with the zone it was set in); only remind_at and snooze_until are instants (UTC ms).

export const KINDS = ["task", "i_owe", "owed_to_me"] as const;
export const STATUSES = ["suggested", "open", "done", "dropped", "snoozed"] as const;
export const ORIGINS = ["owner", "member", "friend", "inferred"] as const;
export const SOURCE_KINDS = ["message", "mail", "meeting", "import", "other"] as const;
export const ACTIONS = ["added", "edited", "done", "reopened", "dropped", "snoozed", "suggested", "confirmed", "rejected", "reminded"] as const;
export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Origin = (typeof ORIGINS)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type Action = (typeof ACTIONS)[number];

export const LIMITS = { title: 200, details: 2000, person: 80, assignee: 80, ref: 300, open: 1000, suggestions: 20, list: 200 } as const;

export interface Item {
  id: number;
  kind: Kind;
  title: string;
  details?: string;
  due?: string; // local: YYYY-MM-DD or YYYY-MM-DDTHH:MM
  dueZone?: string;
  remindAt?: number; // UTC ms
  repeat?: string; // canonical rule text
  person?: string;
  assignee?: string;
  status: Status;
  snoozeUntil?: number;
  origin: Origin;
  sourceKind: SourceKind;
  sourceRef?: string;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
}

export interface TaskEvent {
  id: number;
  itemId: number;
  at: number;
  by: string;
  action: Action;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Who is acting, where, and in which clock. */
export interface Scope {
  key: string; // the Conversation.key: which conversation's file, and where the event is told
  zone: string; // the conversation's time zone
  by: string; // "owner", a member's or friend's name, "assistant (inferred)", "system"
  origin: Origin; // what a new item made by this actor is marked as
  source: Source; // the policy source of the run (the audit row)
  now?: number; // test clock
  why?: Why; // a journal line made outside a tool call (a command) says its own why; a tool's comes from the run's provenance (journalrender.ts)
  viaTool?: boolean; // a tool call: the journal line is the call's own (done event), this task event goes to the audit log only
}

/** What went wrong, in words for the person or the model. */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

const nowOf = (s: Scope): number => s.now ?? Date.now();

// ---- rows ----

interface Row {
  id: number;
  kind: Kind;
  title: string;
  details: string | null;
  due: string | null;
  due_zone: string | null;
  remind_at: number | null;
  repeat: string | null;
  person: string | null;
  assignee: string | null;
  status: Status;
  snooze_until: number | null;
  origin: Origin;
  source_kind: SourceKind;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
}
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);
const toItem = (r: Row): Item => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  ...(r.details !== null ? { details: r.details } : {}),
  ...(r.due !== null ? { due: r.due } : {}),
  ...(r.due_zone !== null ? { dueZone: r.due_zone } : {}),
  ...(r.remind_at !== null ? { remindAt: r.remind_at } : {}),
  ...(r.repeat !== null ? { repeat: r.repeat } : {}),
  ...(r.person !== null ? { person: r.person } : {}),
  ...(r.assignee !== null ? { assignee: r.assignee } : {}),
  status: r.status,
  ...(r.snooze_until !== null ? { snoozeUntil: r.snooze_until } : {}),
  origin: r.origin,
  sourceKind: r.source_kind,
  ...(r.source_ref !== null ? { sourceRef: r.source_ref } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(opt(r.done_at) !== undefined ? { doneAt: r.done_at! } : {}),
});

const writeDb = (key: string): Db => {
  const db = liveConvDb(convIdOfKey(key));
  if (!db) throw new TaskError("Tasks cannot be changed right now: this conversation's database is being repaired (the owner has been told).");
  return db;
};
const readDb = (key: string): Db | undefined => peekConvDb(convIdOfKey(key));

export function getItem(key: string, id: number): Item | undefined {
  const r = readDb(key)?.get<Row>("SELECT * FROM items WHERE id = ?", id);
  return r && toItem(r);
}

export function eventsOf(key: string, id: number): TaskEvent[] {
  const rows = readDb(key)?.all<{ id: number; item_id: number; at: number; by: string; action: Action; before: string | null; after: string | null }>("SELECT * FROM task_events WHERE item_id = ? ORDER BY id", id) ?? [];
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, at: r.at, by: r.by, action: r.action, ...(r.before ? { before: JSON.parse(r.before) as Record<string, unknown> } : {}), ...(r.after ? { after: JSON.parse(r.after) as Record<string, unknown> } : {}) }));
}

// ---- validation: strict, in words the model can act on ----

const oneText = (label: string, v: string, max: number): string => {
  const t = oneLine(`task ${label}`, v, 100_000).trim();
  if (!t) throw new TaskError(`${label} is empty.`);
  if (t.length > max) throw new TaskError(`${label} is too long (${max} characters at most): shorten it${label === "title" ? " and put the rest in details" : ""}.`);
  return t;
};
const optText = (label: string, v: string | null | undefined, max: number): string | null | undefined => (v === undefined ? undefined : v === null || !v.trim() ? null : oneText(label, v, max));
const cleanDetails = (v: string | null | undefined): string | null | undefined => {
  if (v === undefined) return undefined;
  const t = v === null ? "" : clean("task details", v, { max: 100_000 }).trim();
  if (t.length > LIMITS.details) throw new TaskError(`details is too long (${LIMITS.details} characters at most).`);
  return t || null;
};
function checkDue(due: string | null | undefined): string | null | undefined {
  if (due === undefined || due === null) return due;
  if (!parseLocal(due)) throw new TaskError(`due "${due.slice(0, 40)}" is not a local date: write YYYY-MM-DD or YYYY-MM-DDTHH:MM (24-hour clock, the person's time zone, no zone suffix), resolving words like "friday" or "tomorrow" from today's date.`);
  return due;
}
function checkRepeat(r: string | null | undefined): string | null | undefined {
  if (r === undefined || r === null) return r;
  const p = parseRepeat(r);
  if (!p.ok) throw new TaskError(p.error);
  return p.text;
}
function checkInstant(label: string, v: number | null | undefined): number | null | undefined {
  if (v === undefined || v === null) return v;
  if (!Number.isInteger(v) || v < 946_684_800_000 || v > 4_102_444_800_000) throw new TaskError(`${label} is not a sensible time.`);
  return v;
}

// ---- what an event says ----

const NOUN: Record<Kind, string> = { task: "task", i_owe: "promise", owed_to_me: "item owed to you" };
const VERB: Record<Action, string> = { added: "Added", edited: "Edited", done: "Completed", reopened: "Reopened", dropped: "Dropped", snoozed: "Snoozed", suggested: "Suggested", confirmed: "Confirmed the suggested", rejected: "Rejected the suggested", reminded: "Reminded about" };
const FIELD_NAMES: Record<string, string> = { title: "title", details: "details", due: "due", remind_at: "reminder", repeat: "repeat", person: "person", assignee: "assignee", kind: "kind" };

/** The line for the journal and the tool's reply: "Added task #4 'Call Sam' (due Fri 24 Oct)". `zone` and `now` put dates in the conversation's clock. */
export function lineOf(action: Action, it: Item, o: { zone: string; now: number; changed?: readonly string[]; next?: string }): string {
  const today = todayIn(o.now, o.zone);
  const title = it.title.length > 70 ? `${it.title.slice(0, 69)}…` : it.title;
  const bits: string[] = [];
  if (action === "snoozed" && it.snoozeUntil !== undefined) bits.push(`until ${showInstant(it.snoozeUntil, o.zone, o.now)}`);
  else if (action === "edited" && o.changed?.length) bits.push(`changed ${o.changed.map((f) => FIELD_NAMES[f] ?? f).join(", ")}`);
  else if (action === "done" && o.next) bits.push(`next: ${showLocal(o.next, today)}`);
  else if (it.due && (action === "added" || action === "suggested" || action === "confirmed" || action === "reopened")) bits.push(`due ${showLocal(it.due, today)}`);
  if ((action === "added" || action === "suggested") && it.person) bits.push(it.kind === "i_owe" ? `you owe ${it.person}` : it.kind === "owed_to_me" ? `${it.person} owes you` : `with ${it.person}`);
  if ((action === "added" || action === "suggested") && it.assignee) bits.push(`for ${it.assignee}`);
  return `${VERB[action]} ${NOUN[it.kind]} #${it.id} '${title}'${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

// ---- mutations ----

interface Change {
  action: Action;
  set: Partial<Record<keyof Row, string | number | null>>;
  next?: string;
}

/** One transaction: the item's changed columns and the history row; then the event. Returns the item as it is now and the line. */
function commit(scope: Scope, id: number, c: Change): { item: Item; line: string } {
  const db = writeDb(scope.key);
  const now = nowOf(scope);
  const out = db.tx(() => {
    const row = db.get<Row>("SELECT * FROM items WHERE id = ?", id);
    if (!row) throw new TaskError(`There is no item #${id} on this list.`);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.set)) {
      const was = row[k as keyof Row];
      if (was === v) continue;
      before[k] = was;
      after[k] = v;
    }
    db.run(`UPDATE items SET ${[...Object.keys(c.set), "updated_at"].map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...([...Object.values(c.set), now] as (string | number | null)[]), id);
    db.run("INSERT INTO task_events (item_id, at, by, action, before, after) VALUES (?, ?, ?, ?, ?, ?)", id, now, scope.by, c.action, Object.keys(before).length ? JSON.stringify(before) : null, Object.keys(after).length ? JSON.stringify(after) : null);
    return { item: toItem(db.get<Row>("SELECT * FROM items WHERE id = ?", id)!), changed: Object.keys(after).filter((k) => k !== "status" && k !== "updated_at" && k !== "snooze_until" && k !== "done_at") };
  });
  const line = lineOf(c.action, out.item, { zone: scope.zone, now, changed: out.changed, next: c.next });
  told(scope, out.item.id, c.action, line);
  return { item: out.item, line };
}

function told(scope: Scope, id: number, action: Action, line: string): void {
  try {
    emit({ type: "task", id: String(id), state: action, text: line, source: scope.source, conv: scope.key, ...(scope.why ? { why: scope.why } : {}), ...(scope.viaTool ? { viaTool: true } : {}) });
  } catch (e) {
    console.error(`tasks: the event for #${id} (${action}) could not be told (${(e as Error)?.message ?? "error"})`); // (the change is made and in the history; the audit log is a record of it)
  }
}

const mayChange = (scope: Scope): void => {
  if (scope.origin === "inferred") throw new TaskError("A background look can only suggest a task; the person changes, finishes and drops them.");
};

export interface NewItem {
  title: string;
  kind?: Kind;
  details?: string;
  due?: string;
  remindAt?: number;
  repeat?: string;
  person?: string;
  assignee?: string;
  status?: Status; // open (default) or suggested; an inferred origin is always suggested
  sourceKind?: SourceKind;
  sourceRef?: string;
}

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();

/** The item this one repeats, if any: the same source (a mail, a message), or the same title, kind and due among the live ones. A repeat is not added again. */
function duplicateOf(db: Db, title: string, kind: Kind, due: string | undefined, ref: { kind: SourceKind; ref?: string }): Item | undefined {
  if (ref.ref) {
    const r = db.get<Row>("SELECT * FROM items WHERE source_kind = ? AND source_ref = ? AND kind = ? ORDER BY id DESC LIMIT 1", ref.kind, ref.ref, kind);
    if (r) return toItem(r);
  }
  const rows = db.all<Row>("SELECT * FROM items WHERE kind = ? AND status IN ('suggested', 'open', 'snoozed')", kind);
  const hit = rows.find((r) => norm(r.title) === norm(title) && (r.due ?? "") === (due ?? ""));
  return hit && toItem(hit);
}

export interface Added {
  item: Item;
  line: string;
  duplicate?: boolean; // it was already there: nothing was added
}

export function addItem(scope: Scope, n: NewItem): Added {
  const db = writeDb(scope.key);
  const now = nowOf(scope);
  const kind = n.kind ?? "task";
  if (!KINDS.includes(kind)) throw new TaskError(`kind must be one of ${KINDS.join(", ")}.`);
  const inferred = scope.origin === "inferred";
  const status: Status = inferred ? "suggested" : (n.status ?? "open");
  if (status !== "open" && status !== "suggested") throw new TaskError("A new item is open or suggested.");
  const sourceKind = n.sourceKind ?? "message";
  if (!SOURCE_KINDS.includes(sourceKind)) throw new TaskError(`source_kind must be one of ${SOURCE_KINDS.join(", ")}.`);
  const title = oneText("title", n.title, LIMITS.title);
  const details = cleanDetails(n.details) ?? null;
  const due = checkDue(n.due) ?? null;
  const repeat = checkRepeat(n.repeat) ?? null;
  const remindAt = checkInstant("remind_at", n.remindAt) ?? null;
  if (repeat && !due && remindAt === null) throw new TaskError("A repeating task needs a due date or a reminder time to start from.");
  if (!isZone(scope.zone)) throw new TaskError("This conversation has no usable time zone.");
  const person = optText("person", n.person, LIMITS.person) ?? null;
  const assignee = optText("assignee", n.assignee, LIMITS.assignee) ?? null;
  const ref = n.sourceRef === undefined ? null : oneText("source_ref", n.sourceRef, LIMITS.ref);
  const dup = duplicateOf(db, title, kind, due ?? undefined, { kind: sourceKind, ref: ref ?? undefined });
  if (dup) return { item: dup, line: `Already on the list: #${dup.id} '${dup.title}' (${dup.status})`, duplicate: true };
  const live = db.num("SELECT COUNT(*) FROM items WHERE status IN ('suggested', 'open', 'snoozed')");
  if (live >= LIMITS.open) throw new TaskError(`The list is full (${LIMITS.open} open items): finish or drop some first.`);
  if (status === "suggested" && db.num("SELECT COUNT(*) FROM items WHERE status = 'suggested'") >= LIMITS.suggestions) throw new TaskError(`${LIMITS.suggestions} suggestions are already waiting for an answer; no more until they are confirmed or rejected.`);
  const id = db.tx(() => {
    const r = db.run(
      "INSERT INTO items (kind, title, details, due, due_zone, remind_at, repeat, person, assignee, status, origin, source_kind, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      kind, title, details, due, due ? scope.zone : null, remindAt, repeat, person, assignee, status, scope.origin, sourceKind, ref, now, now,
    );
    const after = { kind, title, ...(details ? { details } : {}), ...(due ? { due } : {}), ...(remindAt !== null ? { remind_at: remindAt } : {}), ...(repeat ? { repeat } : {}), ...(person ? { person } : {}), ...(assignee ? { assignee } : {}), status };
    db.run("INSERT INTO task_events (item_id, at, by, action, before, after) VALUES (?, ?, ?, ?, NULL, ?)", r.lastInsertRowid, now, scope.by, status === "suggested" ? "suggested" : "added", JSON.stringify(after));
    return r.lastInsertRowid;
  });
  const item = toItem(db.get<Row>("SELECT * FROM items WHERE id = ?", id)!);
  const line = lineOf(status === "suggested" ? "suggested" : "added", item, { zone: scope.zone, now });
  told(scope, id, status === "suggested" ? "suggested" : "added", line);
  return { item, line };
}

export interface Patch {
  title?: string;
  kind?: Kind;
  details?: string | null;
  due?: string | null;
  remindAt?: number | null;
  repeat?: string | null;
  person?: string | null;
  assignee?: string | null;
}

const live = (it: Item, what: string): void => {
  if (it.status === "done" || it.status === "dropped") throw new TaskError(`#${it.id} is ${it.status}; reopen it before you ${what}.`);
};
const need = (scope: Scope, id: number): Item => {
  const it = getItem(scope.key, id);
  if (!it) throw new TaskError(`There is no item #${id} on this list.`);
  return it;
};

export function editItem(scope: Scope, id: number, p: Patch): { item: Item; line: string } {
  mayChange(scope);
  const it = need(scope, id);
  live(it, "change it");
  const set: Change["set"] = {};
  if (p.title !== undefined) set.title = oneText("title", p.title, LIMITS.title);
  if (p.kind !== undefined) {
    if (!KINDS.includes(p.kind)) throw new TaskError(`kind must be one of ${KINDS.join(", ")}.`);
    set.kind = p.kind;
  }
  const details = cleanDetails(p.details);
  if (details !== undefined) set.details = details;
  const due = checkDue(p.due);
  if (due !== undefined) (set.due = due), (set.due_zone = due ? scope.zone : null);
  const remind = checkInstant("remind_at", p.remindAt);
  if (remind !== undefined) set.remind_at = remind;
  const repeat = checkRepeat(p.repeat);
  if (repeat !== undefined) set.repeat = repeat;
  const person = optText("person", p.person, LIMITS.person);
  if (person !== undefined) set.person = person;
  const assignee = optText("assignee", p.assignee, LIMITS.assignee);
  if (assignee !== undefined) set.assignee = assignee;
  if (!Object.keys(set).length) throw new TaskError("Nothing to change: give at least one field to update.");
  const finalRepeat = set.repeat !== undefined ? set.repeat : (it.repeat ?? null);
  const finalDue = set.due !== undefined ? set.due : (it.due ?? null);
  const finalRemind = set.remind_at !== undefined ? set.remind_at : (it.remindAt ?? null);
  if (finalRepeat && !finalDue && finalRemind === null) throw new TaskError("A repeating task needs a due date or a reminder time to start from.");
  return commit(scope, id, { action: "edited", set });
}

/** Done. A repeating item is not finished: it moves to its next due (and reminder) and stays open; done_at records this completion and the history says 'done'. */
export function completeItem(scope: Scope, id: number): { item: Item; line: string; next?: string } {
  mayChange(scope);
  const it = need(scope, id);
  if (it.status === "done") throw new TaskError(`#${id} is already done.`);
  if (it.status === "dropped") throw new TaskError(`#${id} was dropped; reopen it first if it should be done.`);
  if (it.status === "suggested") throw new TaskError(`#${id} is only a suggestion: confirm it (confirm_suggestion) or reject it first.`);
  const now = nowOf(scope);
  const rule = it.repeat ? parseRepeat(it.repeat) : undefined;
  if (rule?.ok && (it.due || it.remindAt !== undefined)) {
    const zone = it.dueZone ?? scope.zone;
    const today = todayIn(now, scope.zone);
    const set: Change["set"] = { status: "open", snooze_until: null, done_at: now };
    let next: string | undefined;
    if (it.due) {
      next = nextDue(rule.rule, it.due, today);
      set.due = next;
      if (it.remindAt !== undefined) {
        const p = parseLocal(it.due)!;
        const gap = it.remindAt - wallToUtc(zone, p.date, p.time ?? "00:00"); // the reminder keeps its distance from the due
        const q = parseLocal(next)!;
        set.remind_at = wallToUtc(zone, q.date, q.time ?? "00:00") + gap;
      }
    } else {
      const at = nextInstant(rule.rule, Math.max(now, it.remindAt!), scope.zone, localOf(it.remindAt!, scope.zone).date);
      set.remind_at = at;
      next = `${localOf(at, scope.zone).date}T${localOf(at, scope.zone).time}`;
    }
    const r = commit(scope, id, { action: "done", set, next });
    return { ...r, next };
  }
  return commit(scope, id, { action: "done", set: { status: "done", done_at: now, snooze_until: null } });
}

export function reopenItem(scope: Scope, id: number): { item: Item; line: string } {
  mayChange(scope);
  const it = need(scope, id);
  if (it.status !== "done" && it.status !== "dropped" && it.status !== "snoozed") throw new TaskError(`#${id} is ${it.status}, not done or dropped.`);
  return commit(scope, id, { action: "reopened", set: { status: "open", done_at: null, snooze_until: null } });
}

/** The end state: the item stays in the history, off every list. */
export function dropItem(scope: Scope, id: number): { item: Item; line: string } {
  mayChange(scope);
  const it = need(scope, id);
  if (it.status === "dropped") throw new TaskError(`#${id} is already dropped.`);
  return commit(scope, id, { action: "dropped", set: { status: "dropped", snooze_until: null } });
}

/** Out of the way until an instant (UTC ms): it is not open, not overdue and not reminded until then. */
export function snoozeItem(scope: Scope, id: number, until: number): { item: Item; line: string } {
  mayChange(scope);
  const it = need(scope, id);
  live(it, "snooze it");
  if (it.status === "suggested") throw new TaskError(`#${id} is only a suggestion: confirm or reject it first.`);
  const t = checkInstant("until", until)!;
  if (t <= nowOf(scope)) throw new TaskError("Snooze until a time in the future.");
  return commit(scope, id, { action: "snoozed", set: { status: "snoozed", snooze_until: t } });
}

/** The person accepts a suggestion (optionally corrected): it becomes an open item. */
export function confirmSuggestion(scope: Scope, id: number, p: Patch = {}): { item: Item; line: string } {
  mayChange(scope);
  const it = need(scope, id);
  if (it.status !== "suggested") throw new TaskError(`#${id} is not a suggestion (it is ${it.status}).`);
  if (Object.values(p).some((v) => v !== undefined)) editItem(scope, id, p);
  return commit(scope, id, { action: "confirmed", set: { status: "open" } });
}

/** The person turns a suggestion down: dropped, kept in the history so the same mail is not suggested again. */
export function rejectSuggestion(scope: Scope, id: number): { item: Item; line: string } {
  mayChange(scope);
  const it = need(scope, id);
  if (it.status !== "suggested") throw new TaskError(`#${id} is not a suggestion (it is ${it.status}).`);
  return commit(scope, id, { action: "rejected", set: { status: "dropped" } });
}

/** A reminder was sent for this item (the history says so; T2). */
export function noteReminded(scope: Scope, id: number, remindAt: number | null = null): void {
  commit(scope, id, { action: "reminded", set: { remind_at: remindAt } });
}

/** Snoozes whose time has come are open again (the history says so). Returns the items woken. */
export function wakeSnoozed(scope: Scope): Item[] {
  const db = readDb(scope.key);
  if (!db) return [];
  const now = nowOf(scope);
  return db.all<Row>("SELECT * FROM items WHERE status = 'snoozed' AND snooze_until <= ? ORDER BY id", now).map((r) => commit(scope, r.id, { action: "reopened", set: { status: "open", snooze_until: null } }).item);
}

// ---- reading ----

export interface Filter {
  status?: Status | readonly Status[]; // default: open (a snooze that has run out counts as open)
  kind?: Kind;
  person?: string; // contains, case-insensitive
  assignee?: string;
  q?: string; // every word in the title, details, person or assignee
  dueFrom?: string; // local date, inclusive
  dueTo?: string;
  overdue?: boolean;
  noDate?: boolean;
  limit?: number;
}

/** The status the person sees: a snooze whose time has passed is open again, even before wakeSnoozed has written it down. */
export const effectiveStatus = (it: Item, now: number): Status => (it.status === "snoozed" && it.snoozeUntil !== undefined && it.snoozeUntil <= now ? "open" : it.status);

export type DueClass = "overdue" | "today" | "upcoming" | "none";
export function dueClass(it: Item, now: number, zone: string): DueClass {
  const p = it.due ? parseLocal(it.due) : undefined;
  if (!p) return "none";
  const today = todayIn(now, zone);
  if (p.time) {
    if (wallToUtc(it.dueZone ?? zone, p.date, p.time) < now) return "overdue";
  } else if (p.date < today) return "overdue";
  return p.date === today ? "today" : "upcoming";
}

const dueKey = (it: Item): string => (it.due ? (it.due.length === 10 ? `${it.due}T23:59` : it.due) : "9999-99-99T99:99"); // (an all-day due sorts after the timed ones of its day)

const allItems = (key: string, kind?: Kind): Item[] => readDb(key)?.all<Row>("SELECT * FROM items" + (kind ? " WHERE kind = ?" : ""), ...(kind ? [kind] : [])).map(toItem) ?? [];

export function listItems(key: string, f: Filter = {}, now = Date.now(), zone = "UTC"): Item[] {
  const want = f.status === undefined ? ["open"] : Array.isArray(f.status) ? f.status : [f.status];
  const words = norm(f.q ?? "").split(" ").filter(Boolean);
  const out = allItems(key, f.kind).filter((it) => {
    if (!want.includes(effectiveStatus(it, now))) return false;
    if (f.person && !norm(it.person ?? "").includes(norm(f.person))) return false;
    if (f.assignee && !norm(it.assignee ?? "").includes(norm(f.assignee))) return false;
    if (words.length) {
      const hay = norm(`${it.title} ${it.details ?? ""} ${it.person ?? ""} ${it.assignee ?? ""}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    const day = it.due?.slice(0, 10);
    if (f.dueFrom && !(day && day >= f.dueFrom)) return false;
    if (f.dueTo && !(day && day <= f.dueTo)) return false;
    if (f.overdue && dueClass(it, now, zone) !== "overdue") return false;
    if (f.noDate && it.due) return false;
    return true;
  });
  out.sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || a.id - b.id);
  return out.slice(0, Math.min(f.limit ?? 50, LIMITS.list));
}

export interface Counts {
  open: number;
  overdue: number;
  today: number;
  upcoming: number;
  noDate: number;
  waiting: number; // owed_to_me, open
  owe: number; // i_owe, open
  suggested: number;
  snoozed: number;
  done: number;
  dropped: number;
}

export function counts(key: string, now = Date.now(), zone = "UTC"): Counts {
  const c: Counts = { open: 0, overdue: 0, today: 0, upcoming: 0, noDate: 0, waiting: 0, owe: 0, suggested: 0, snoozed: 0, done: 0, dropped: 0 };
  for (const it of allItems(key)) {
    const s = effectiveStatus(it, now);
    if (s === "open") {
      c.open++;
      const d = dueClass(it, now, zone);
      if (d === "overdue") c.overdue++;
      else if (d === "today") c.today++;
      else if (d === "upcoming") c.upcoming++;
      else c.noDate++;
      if (it.kind === "owed_to_me") c.waiting++;
      if (it.kind === "i_owe") c.owe++;
    } else c[s]++;
  }
  return c;
}
