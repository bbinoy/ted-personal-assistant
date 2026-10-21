import type { Source } from "../core/audit.ts";
import { convDb } from "../core/convdb.ts";
import { convIdOfKey } from "../core/convpaths.ts";
import type { Db } from "../core/db.ts";
import { settings } from "../core/settings.ts";
import { callKey } from "./permissions.ts";

// The approval inbox's STATE: the calls an unattended run wanted to make that need the owner's yes, parked instead of blocking the run (pendingflow.ts says how they are asked,
// answered and run). Its tables are in the conversation's own assistant.db (pending_state, pending_items, pending_expired, pending_blocked: core/convdb.ts); every operation is ONE transaction (load, change, write back), so a crash leaves the inbox as it was or as it became, never half, and a restart loses nothing.
// A pending action is the EXACT call (tool name and arguments as the run made them), the code-rendered label and footer, the model's one-line question and where it came from;
// it is never rebuilt from words. Numbers (#N) are per conversation, only ever count up and are never reused, so "2" in an old message cannot mean a newer item.

export interface Pending {
  n: number;
  tool: string;
  input: Record<string, unknown>; // exactly as the run called it: what runs on a yes
  label: string; // the first line of the code-built details ("✉️ Reply to ..."), never model text
  question: string; // the model's one-line question (validated against the arguments, approvalmodel.ts)
  footer: string; // code-rendered from the details (questionfooter.ts), one line
  scope: string; // the conversation (Conversation.key): only an answer there applies
  source: Source;
  createdAt: number;
  urgent?: boolean; // the run marked it time-critical: sent at once, even in quiet hours (nothing sets it yet)
  detailsHash?: string; // the code-rendered details at asking time (pendingbatch.ts detailsHash): the follow-up run re-reads them and runs nothing if they differ (a draft edited meanwhile)
  deferred?: true; // quiet hours (or /quiet) kept its batch back: it is asked, as its own message, as soon as they end (pendingflow.ts)
  executing?: { at: number }; // approved and its follow-up run started: kept until the run ends, so a crash in between is noticed (recoverStuck)
  retry?: { told: boolean }; // approved, but the run gate refused it (paused, budget, cooldown...): it waits approved and is run by the tick when it can; `told`: the owner has been told
  interrupted?: true; // it was executing when the process stopped and no audit row says it finished: asked about again, never retried by itself
  sent?: { at: number; ts?: number; held?: true }; // asked in a batch: when, and the batch message's timestamp (absent when it was held for quiet hours and went out with the morning release)
}

// A call that must not be parked again for a while: one that was done (7 days: the next look would propose it anew) or that expired unanswered (24 hours: not asked again on every look).
export interface Blocked {
  key: string;
  n: number;
  at: number;
  until: number;
  kind: "done" | "expired";
}

export interface Dropped {
  n: number;
  label: string;
}

interface PendingFile {
  next: number; // the next number to hand out
  items: Pending[];
  expired: Dropped[]; // dropped on expiry and not yet told to the owner
  blocked: Blocked[];
}

const MAX_ITEMS = 40; // a flood is refused, not queued without end
export const MAX_BLOCKED = 100;

// ---- the rows <-> the records (the same shapes the file held) ----

interface ItemRow {
  n: number;
  tool: string;
  input: string;
  label: string;
  question: string;
  footer: string;
  scope: string;
  source: string;
  created_at: number;
  urgent: number | null;
  details_hash: string | null;
  deferred: number | null;
  executing_at: number | null;
  retry_told: number | null;
  interrupted: number | null;
  sent_at: number | null;
  sent_ts: number | null;
  sent_held: number | null;
}
const COLS = "n, tool, input, label, question, footer, scope, source, created_at, urgent, details_hash, deferred, executing_at, retry_told, interrupted, sent_at, sent_ts, sent_held";

function itemOf(r: ItemRow): Pending {
  return {
    n: r.n,
    tool: r.tool,
    input: JSON.parse(r.input) as Record<string, unknown>,
    label: r.label,
    question: r.question,
    footer: r.footer,
    scope: r.scope,
    source: r.source as Source,
    createdAt: r.created_at,
    ...(r.urgent !== null ? { urgent: !!r.urgent } : {}),
    ...(r.details_hash !== null ? { detailsHash: r.details_hash } : {}),
    ...(r.deferred ? { deferred: true as const } : {}),
    ...(r.executing_at !== null ? { executing: { at: r.executing_at } } : {}),
    ...(r.retry_told !== null ? { retry: { told: !!r.retry_told } } : {}),
    ...(r.interrupted ? { interrupted: true as const } : {}),
    ...(r.sent_at !== null ? { sent: { at: r.sent_at, ...(r.sent_ts !== null ? { ts: r.sent_ts } : {}), ...(r.sent_held ? { held: true as const } : {}) } } : {}),
  };
}

function load(db: Db): PendingFile {
  const next = db.get<{ next: number }>("SELECT next FROM pending_state WHERE id = 1")?.next;
  return {
    next: typeof next === "number" && next >= 1 ? next : 1,
    items: db.all<ItemRow>(`SELECT ${COLS} FROM pending_items ORDER BY n`).map(itemOf),
    expired: db.all<Dropped>("SELECT n, label FROM pending_expired ORDER BY seq"),
    blocked: db.all<Blocked>("SELECT key, n, at, until, kind FROM pending_blocked ORDER BY seq"),
  };
}

function save(db: Db, f: PendingFile): void {
  db.run("INSERT INTO pending_state (id, next) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET next = excluded.next", f.next);
  db.run("DELETE FROM pending_items");
  for (const p of f.items) {
    db.run(
      `INSERT INTO pending_items (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.n, p.tool, JSON.stringify(p.input), p.label, p.question, p.footer, p.scope, p.source, p.createdAt,
      typeof p.urgent === "boolean" ? (p.urgent ? 1 : 0) : null, p.detailsHash ?? null, p.deferred ? 1 : null, p.executing?.at ?? null, p.retry ? (p.retry.told ? 1 : 0) : null, p.interrupted ? 1 : null,
      p.sent?.at ?? null, p.sent?.ts ?? null, p.sent?.held ? 1 : null,
    );
  }
  db.run("DELETE FROM pending_expired");
  for (const d of f.expired) db.run("INSERT INTO pending_expired (n, label) VALUES (?, ?)", d.n, d.label);
  db.run("DELETE FROM pending_blocked");
  for (const b of f.blocked) db.run("INSERT INTO pending_blocked (key, n, at, until, kind) VALUES (?, ?, ?, ?, ?)", b.key, b.n, b.at, b.until, b.kind);
}

/** One change of one conversation's inbox, atomically: loaded, handed to fn to change, written back when it changed. A throw rolls everything back. */
function edit<T>(scope: string, fn: (f: PendingFile) => T): T {
  const db = convDb(convIdOfKey(scope));
  return db.tx(() => {
    const f = load(db);
    const before = JSON.stringify(f);
    const r = fn(f);
    if (JSON.stringify(f) !== before) save(db, f);
    return r;
  });
}
const read = (scope: string): PendingFile => load(convDb(convIdOfKey(scope)));

// Pure: which items are older than `days` at `now`?
export function splitExpired(items: readonly Pending[], now: number, days: number): { keep: Pending[]; dropped: Pending[] } {
  const keep: Pending[] = [];
  const dropped: Pending[] = [];
  for (const p of items) (now - p.createdAt >= days * 86_400_000 && !p.executing && !p.retry ? dropped : keep).push(p);
  return { keep, dropped };
}

// Drop what has waited past PENDING_ACTION_DAYS; the drops are remembered until told (takeExpired), so an expiry is never silent.
export function sweepExpired(scope: string, now: number): Pending[] {
  return edit(scope, (f) => {
    const { keep, dropped } = splitExpired(f.items, now, settings.pendingActionDays);
    if (dropped.length === 0) return [];
    f.items = keep;
    f.expired.push(...dropped.map((p) => ({ n: p.n, label: p.label })));
    f.blocked.push(...dropped.map((p): Blocked => ({ key: callKey(p.tool, p.input), n: p.n, at: now, until: now + 86_400_000, kind: "expired" }))); // (the next look does not ask the same thing again at once)
    f.blocked = f.blocked.filter((b) => b.until > now).slice(-MAX_BLOCKED);
    return dropped;
  });
}
export const takeExpired = (scope: string): Dropped[] =>
  edit(scope, (f) => {
    const out = f.expired;
    f.expired = [];
    return out;
  });

// Put back what could not be told (the chat was down): the next flush says it.
export function addExpired(scope: string, told: readonly Dropped[]): void {
  edit(scope, (f) => void f.expired.push(...told));
}

export const openItems = (scope: string): Pending[] => read(scope).items;

// Park a call. The same call (tool and arguments) already parked keeps its number: a run that asks twice does not make two items.
export function addPending(scope: string, p: Omit<Pending, "n" | "createdAt" | "scope" | "sent">, now: number): { n: number; duplicate: boolean } | { full: true } | { blocked: Blocked } {
  return edit(scope, (f) => {
    const key = callKey(p.tool, p.input);
    const same = f.items.find((x) => callKey(x.tool, x.input) === key);
    if (same) return { n: same.n, duplicate: true };
    const blocked = f.blocked.find((b) => b.key === key && b.until > now);
    if (blocked) return { blocked };
    if (f.items.length >= MAX_ITEMS) return { full: true as const };
    const n = f.next++;
    f.items.push({ ...p, n, scope, createdAt: now });
    return { n, duplicate: false };
  });
}

export function markSent(scope: string, ns: readonly number[], sent: NonNullable<Pending["sent"]>): void {
  edit(scope, (f) => {
    for (const p of f.items) if (ns.includes(p.n) && !p.sent) p.sent = sent;
  });
}

// Remove and return the items with these numbers (answered).
export function takeItems(scope: string, ns: readonly number[]): Pending[] {
  return edit(scope, (f) => {
    const taken = f.items.filter((p) => ns.includes(p.n));
    if (taken.length === 0) return [];
    f.items = f.items.filter((p) => !ns.includes(p.n));
    return taken;
  });
}

export function markDeferred(scope: string, ns: readonly number[]): void {
  edit(scope, (f) => {
    for (const p of f.items) if (ns.includes(p.n)) p.deferred = true;
  });
}

// Approved: kept in the inbox, marked as running, until finishItem. Returns the ones that were open (not already running).
export function markExecuting(scope: string, ns: readonly number[], at: number): Pending[] {
  return edit(scope, (f) => {
    const marked = f.items.filter((p) => ns.includes(p.n) && !p.executing);
    for (const p of marked) {
      p.executing = { at };
      delete p.interrupted;
    }
    return marked;
  });
}
// It ran: gone from the list, and remembered as done so the next look cannot park the same call again.
export function recordDone(scope: string, tool: string, input: Record<string, unknown>, n: number, now: number): void {
  edit(scope, (f) => {
    f.blocked = [...f.blocked.filter((b) => b.until > now), { key: callKey(tool, input), n, at: now, until: now + 7 * 86_400_000, kind: "done" as const }].slice(-MAX_BLOCKED);
  });
}

// The run gate refused an approved item: it stays, approved, and the tick runs it when it can.
export function setRetry(scope: string, n: number, told: boolean): void {
  edit(scope, (f) => {
    for (const p of f.items) if (p.n === n) (delete p.executing, (p.retry = { told }));
  });
}

export const finishItem = (scope: string, n: number): void => void takeItems(scope, [n]);

// Back to waiting for a yes (the run never reported): marked so the list says so.
export function interrupt(scope: string, ns: readonly number[]): void {
  edit(scope, (f) => {
    for (const p of f.items) if (ns.includes(p.n)) (delete p.executing, delete p.retry, (p.interrupted = true));
  });
}

export const clearPending = (scope: string): Pending[] => takeItems(scope, openItems(scope).filter((p) => !p.executing && !p.retry).map((p) => p.n)); // (one that is running is not taken back)

// Retention (heartbeat/convretention.ts): the blocked list keeps only calls still inside their window, at most MAX_BLOCKED. Returns how many went (`dryRun`: how many would).
export function pruneBlocked(db: Db, now: number, dryRun = false): number {
  const old = db.num("SELECT COUNT(*) FROM pending_blocked WHERE until <= ?", now);
  const over = Math.max(0, db.num("SELECT COUNT(*) FROM pending_blocked WHERE until > ?", now) - MAX_BLOCKED);
  if (dryRun) return old + over;
  db.run("DELETE FROM pending_blocked WHERE until <= ?", now);
  if (over > 0) db.run("DELETE FROM pending_blocked WHERE seq IN (SELECT seq FROM pending_blocked ORDER BY seq LIMIT ?)", over);
  return old + over;
}
