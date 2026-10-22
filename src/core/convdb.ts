import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { conversationsDir, convPaths, isConvId, layout, type ConvId, type ConvPaths, type ConvRef } from "./convpaths.ts";
import { Db, LedgerCorruptError, moveCorruptAside, openDb, type Migration } from "./db.ts";
import { DatabaseSync } from "node:sqlite";
import { isInside } from "./contain.ts";
import { writeFileAtomic } from "./state.ts";

// <conversation>/assistant.db: the small mutable state of ONE conversation, one SQLite file in its folder (docs/ARCHITECTURE.md "assistant.db"). It replaced one little JSON file per kind of
// state (layout 4): the resumed session, the dream's day, the posts held for quiet hours, the mail ids already worked through, /quiet, the approval inbox, the voice notes received, a friend's bookkeeping.
// A conversation's state is in ITS file and nowhere else: a query cannot reach another conversation's rows because it has no connection to them (test/convdb.test.ts), and forgetting a conversation is
// still deleting its folder (the connection is closed first: forgetConv / closeConvDb).
//
//   session / dream / hold / quiet / friend / pending_state   ONE row each (id = 1): a CHECK keeps it so
//   held_posts       the posts quiet hours or the day's cap kept back, oldest first (bounded where they are written)
//   seen_mail        the mail ids the heartbeat has worked through, oldest first: seq orders them, the bound (2000) is a query (trimSeenMail), also a retention rule
//   pending_*        the approval inbox: items (numbered, never reused), the ones expired and not yet told, the calls not to park again for a while
//   voice_notes / voice_quotes   the voice notes received in this conversation and the messages that quote them
//   friend_notices   a friend's fixed notices (kind -> last time)
//   legacy_imports   which layout-3 files were imported (core/convimport.ts): a file is imported once, however often the migration runs
//   items / task_events   the tasks (src/tasks/store.ts): a to-do, a promise either way, a suggestion; nothing is deleted (triggers), every change is a task_events row. User data: no retention.
//   suggestion_asks / group_remind_noted   which suggested items each "💡 ..." message listed (message ts -> number -> item: a 👍 or "1 yes" quoting it answers for them), and which group members were told once that
//                    a reminder said in the group is the group's (src/tasks/suggest.ts). Small, pruned after 60 days.
//
// NOT rebuildable. Losing the approval inbox or the session pointer is bad (not financial), and losing seen_mail re-triages the whole inbox, so a damaged file is never quietly replaced by an empty
// one like a cache would be. What happens instead (the policy, tested): the file is SET ASIDE (assistant.db.corrupt-<time>, its -wal and -shm with it), a marker (assistant.db.damaged) is written,
// and a fresh empty database starts, so CHAT KEEPS WORKING (a fresh session; the person can still talk to it). While the marker is there that conversation's BACKGROUND work is refused (payer.ts mayRun:
// the heartbeat look, the dream, quiet compaction, approved actions), the owner is told once a day (heartbeat/notices.ts) and the doctor fails with the file's name. A person restores the set-aside file
// (or `sqlite3 .recover`) and deletes the marker; deleting only the marker accepts the fresh start. The other conversations are not affected: each has its own file.
//
// How to add state (version 3, the tasks, is the example): append ONE numbered step to CONV_SCHEMA below (version n+1, `CREATE TABLE ...`). Steps run in order, each in
// its own transaction, at the first open of each conversation's file; a step is never edited once shipped. Then a small store module over convDb(conv), and, if the table grows, a retention rule (heartbeat/convretention.ts).

export const CONV_SCHEMA: readonly Migration[] = [
  {
    version: 1,
    name: "session, dream, held posts, seen mail, quiet, approval inbox, voice notes, friend bookkeeping",
    up: `
      CREATE TABLE session (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        session_id          TEXT,                                   -- the SDK session this conversation resumes
        cost_usd            REAL NOT NULL DEFAULT 0,                -- total_cost_usd is cumulative across a resumed session
        last_turn_at        TEXT,                                   -- ISO
        last_context_tokens INTEGER,
        compact_failed_at   TEXT,
        base_tokens         INTEGER,
        seen_at             TEXT,                                   -- the newest log line the session has been shown (groups)
        untrusted_in        TEXT                                    -- the session that has read raw mail or a web page ("pending": the one this turn starts)
      );

      CREATE TABLE dream (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        day         TEXT,                                           -- local day of the last attempt
        last_run_at TEXT                                            -- ISO: when the last real run started
      );

      CREATE TABLE hold (
        id     INTEGER PRIMARY KEY CHECK (id = 1),
        day    TEXT NOT NULL,                                       -- the conversation's own day the count belongs to
        posted INTEGER NOT NULL                                     -- unprompted posts so far that day
      );
      CREATE TABLE held_posts (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,                -- oldest first
        text      TEXT NOT NULL,
        why       TEXT NOT NULL,                                    -- quiet, cap
        notice    INTEGER,
        needs_you INTEGER,
        at        INTEGER,
        day       TEXT,
        same_day  INTEGER
      );

      CREATE TABLE seen_mail (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,                      -- oldest first: the bound drops the lowest
        id  TEXT NOT NULL UNIQUE
      );

      CREATE TABLE quiet (
        id    INTEGER PRIMARY KEY CHECK (id = 1),                   -- a row = /quiet is set
        until TEXT NOT NULL                                         -- '' = until /unquiet, else an ISO time
      );

      CREATE TABLE pending_state (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        next INTEGER NOT NULL                                       -- the next number to hand out: only counts up, never reused
      );
      CREATE TABLE pending_items (
        n            INTEGER PRIMARY KEY,
        tool         TEXT NOT NULL,
        input        TEXT NOT NULL,                                 -- JSON: exactly as the run called it
        label        TEXT NOT NULL,
        question     TEXT NOT NULL,
        footer       TEXT NOT NULL,
        scope        TEXT NOT NULL,                                 -- the conversation key: only an answer there applies
        source       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        urgent       INTEGER,
        details_hash TEXT,
        deferred     INTEGER,
        executing_at INTEGER,                                       -- approved and running (a crash in between is noticed: recoverStuck)
        retry_told   INTEGER,                                       -- NOT NULL = approved but the run gate refused it; 1 = the owner has been told
        interrupted  INTEGER,
        sent_at      INTEGER,
        sent_ts      INTEGER,
        sent_held    INTEGER
      );
      CREATE TABLE pending_expired (
        seq   INTEGER PRIMARY KEY AUTOINCREMENT,                    -- dropped on expiry and not yet told to the owner
        n     INTEGER NOT NULL,
        label TEXT NOT NULL
      );
      CREATE TABLE pending_blocked (
        seq   INTEGER PRIMARY KEY AUTOINCREMENT,                    -- a call that must not be parked again for a while
        key   TEXT NOT NULL,
        n     INTEGER NOT NULL,
        at    INTEGER NOT NULL,
        until INTEGER NOT NULL,
        kind  TEXT NOT NULL                                         -- done, expired
      );
      CREATE INDEX pending_blocked_key ON pending_blocked (key);

      CREATE TABLE voice_notes (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,                  -- oldest first: the bound keeps the newest
        ts      INTEGER NOT NULL UNIQUE,                            -- the voice message's timestamp: its id in the conversation
        id      TEXT NOT NULL,                                      -- attachment id
        size    INTEGER NOT NULL,
        by      TEXT NOT NULL,
        by_name TEXT,
        snippet TEXT NOT NULL,
        kind    TEXT,                                               -- voice (default), file
        name    TEXT,
        seconds REAL
      );
      CREATE TABLE voice_quotes (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,                -- oldest first
        message_ts INTEGER NOT NULL UNIQUE,
        quoted_ts  INTEGER NOT NULL
      );

      CREATE TABLE friend (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        paused_until INTEGER,                                       -- her cooldown (for npm run doctor, a separate process)
        disclosed_at TEXT                                           -- when she had her first reply
      );
      CREATE TABLE friend_notices (
        kind TEXT PRIMARY KEY,
        at   TEXT NOT NULL
      );

      CREATE TABLE reset (
        id INTEGER PRIMARY KEY CHECK (id = 1),                      -- a row = this database REPLACED a damaged one: the first look marks every mail in the inbox as seen (never a re-triage)
        at TEXT NOT NULL
      );
      CREATE TABLE pending_lost (
        seq   INTEGER PRIMARY KEY AUTOINCREMENT,                    -- approvals that could not be restored: the owner can ask again
        n     INTEGER NOT NULL,
        label TEXT NOT NULL,
        why   TEXT NOT NULL,                                        -- damaged, late-file
        at    TEXT NOT NULL
      );

      CREATE TABLE legacy_imports (
        name        TEXT NOT NULL,                                  -- the layout-3 file, relative to the data folder
        sha256      TEXT NOT NULL,                                  -- of its bytes: the same name with other bytes is a new file
        rows        INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        backup      TEXT,                                           -- where the original was copied before it was removed
        note        TEXT,
        PRIMARY KEY (name, sha256)
      );
    `,
  },
  {
    version: 2,
    name: "feedback offers and thumbs-up signals (conversation/feedback.ts)",
    up: `
      CREATE TABLE feedback_offers (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        on_ts       INTEGER NOT NULL,                               -- the unprompted message the feedback was about: it is offered about once
        offer_ts    INTEGER,                                        -- the offer message we sent (what a 👍 or a quoted yes points at); NULL: no offer went out
        state       TEXT NOT NULL,                                  -- offered, saved, declined, none (the model had no usable rule: counts for nothing)
        file        TEXT,
        description TEXT,
        body        TEXT,                                           -- the proposed note, exactly as shown
        at          INTEGER NOT NULL
      );
      CREATE INDEX feedback_offers_on ON feedback_offers (on_ts);
      CREATE INDEX feedback_offers_offer ON feedback_offers (offer_ts);
      CREATE TABLE feedback_signals (
        key     TEXT PRIMARY KEY,                                   -- a note file, or cat:<journal category>: what the 👍 was on
        up      INTEGER NOT NULL,
        last_at TEXT NOT NULL                                       -- ISO
      );
    `,
  },
  {
    version: 3,
    name: "tasks: items and their append-only history",
    up: `
      CREATE TABLE items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,              -- numbered, never reused (AUTOINCREMENT): the number the person and the model say
        kind        TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'i_owe', 'owed_to_me')),
        title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
        details     TEXT,
        due         TEXT CHECK (due IS NULL OR due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),  -- LOCAL wall time: YYYY-MM-DD or YYYY-MM-DDTHH:MM, in due_zone
        due_zone    TEXT,                                           -- the conversation's zone when the due was set
        remind_at   INTEGER,                                        -- UTC ms; NULL: no reminder
        repeat      TEXT,                                           -- the canonical rule text (src/tasks/repeat.ts); NULL: once
        person      TEXT,                                           -- who it is with (free text)
        assignee    TEXT,                                           -- a group member's name or id
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('suggested', 'open', 'done', 'dropped', 'snoozed')),
        snooze_until INTEGER,                                       -- UTC ms; with status snoozed
        origin      TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner', 'member', 'friend', 'inferred')),
        source_kind TEXT NOT NULL DEFAULT 'message' CHECK (source_kind IN ('message', 'mail', 'meeting', 'import', 'other')),
        source_ref  TEXT,                                           -- a message ts, a mail id, a url
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        done_at     INTEGER
      );
      CREATE INDEX items_status ON items (status, due);
      -- Nothing is ever deleted: dropped is the end state. The database says so itself, so no code path can (a test greps for one as well).
      CREATE TRIGGER items_no_delete BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT, 'tasks are never deleted: drop them'); END;

      CREATE TABLE task_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items (id),
        at      INTEGER NOT NULL,                                   -- UTC ms
        by      TEXT NOT NULL,                                      -- owner, a member's or friend's name, assistant (inferred), system
        action  TEXT NOT NULL CHECK (action IN ('added', 'edited', 'done', 'reopened', 'dropped', 'snoozed', 'suggested', 'confirmed', 'rejected', 'reminded')),
        before  TEXT,                                               -- JSON: the changed fields as they were
        after   TEXT                                                -- JSON: ... and as they are
      );
      CREATE INDEX task_events_item ON task_events (item_id, id);
      CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'the task history is append-only'); END;
      CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT, 'the task history is append-only'); END;
    `,
  },
  {
    version: 4,
    name: "reminders: the urgent flag and the ledger of reminders fired (src/tasks/remind.ts)",
    up: `
      ALTER TABLE items ADD COLUMN urgent INTEGER CHECK (urgent IS NULL OR urgent IN (0, 1));  -- 1: the reminder may break quiet hours
      CREATE TABLE reminders (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items (id),
        key     TEXT NOT NULL,                                      -- which reminder: at:<remind_at>, due:<date>, snooze:<until>
        state   TEXT NOT NULL CHECK (state IN ('held', 'claimed', 'sent', 'retry', 'folded')),  -- held: due in quiet hours; claimed: marked BEFORE the send (at most once); sent; retry: the send failed; folded: too late, left to the brief
        fire_at INTEGER NOT NULL,                                   -- UTC ms: when it was meant to go
        at      INTEGER NOT NULL,                                   -- the last change of state
        late    INTEGER NOT NULL DEFAULT 0,                         -- 1: it went out late (the doctor counts these)
        tries   INTEGER NOT NULL DEFAULT 0,
        ts      INTEGER,                                            -- the reminder message's timestamp: what a quote or a reaction points at
        UNIQUE (item_id, key)
      );
      CREATE INDEX reminders_ts ON reminders (ts);
    `,
  },
  {
    version: 5,
    name: "task suggestions: which message listed which suggested items; group members told once about reminders",
    up: `
      CREATE TABLE suggestion_asks (
        msg_ts  INTEGER NOT NULL,                                   -- the timestamp of the "💡 ..." message that listed the item (a reply that quotes it, or a 👍 on it, answers for its items)
        n       INTEGER NOT NULL,                                   -- the number it had in that message (1, 2, ...)
        item_id INTEGER NOT NULL REFERENCES items (id),
        at      INTEGER NOT NULL,                                   -- UTC ms
        PRIMARY KEY (msg_ts, n)
      );
      CREATE INDEX suggestion_asks_item ON suggestion_asks (item_id);
      CREATE TABLE group_remind_noted (
        member TEXT PRIMARY KEY,                                    -- a group member's name: told once that a reminder said here is the group's, not private
        at     INTEGER NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "tasks: pending imports (a preview waiting for the owner's yes, tasks/import.ts)",
    up: `
      CREATE TABLE pending_imports (
        batch_id  TEXT PRIMARY KEY,
        source    TEXT NOT NULL,                                    -- where the rows came from, as the owner says it ("Notion")
        state     TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'committed', 'discarded')),
        created   INTEGER NOT NULL,                                 -- UTC ms
        rows      TEXT NOT NULL,                                    -- JSON: the checked rows exactly as the preview showed them
        summary   TEXT NOT NULL,                                    -- JSON: counts, rejected rows, skipped rows
        committed INTEGER                                           -- UTC ms; with state committed
      );
    `,
  },
];

// ---- the connections: one per conversation, opened at first use, closed when idle, when the conversation is forgotten, and at exit ----

interface Entry {
  db: Db;
  conv: ConvId;
  used: number;
}
const open = new Map<string, Entry>(); // by the file's path
const IDLE_MS = 10 * 60_000;

export interface Damage {
  at: string; // ISO
  keptAs: string; // the set-aside file
  pendingLost?: { n: number; label: string }[]; // approvals that were waiting in the damaged file and are NOT copied (a damaged page could replay damaged arguments): the owner can ask again
  salvaged?: { seenMail: number; session: boolean }; // what was copied out of the damaged file into the fresh one
}

const CORRUPT = "assistant.db.corrupt-";
/** The damage of a conversation's database: its marker, or (a marker lost to a crash or a hand) a set-aside file next to the database. Undefined: none. */
export const convDamage = (c: ConvRef | ConvPaths): Damage | undefined => {
  const p = typeof c === "object" && "dbDamaged" in c ? c : convPaths(c);
  try {
    const m = JSON.parse(readFileSync(p.dbDamaged, "utf8")) as Partial<Damage>;
    return {
      at: typeof m.at === "string" ? m.at : "",
      keptAs: typeof m.keptAs === "string" ? m.keptAs : "",
      ...(Array.isArray(m.pendingLost) ? { pendingLost: m.pendingLost } : {}),
      ...(m.salvaged ? { salvaged: m.salvaged } : {}),
    };
  } catch {
    if (existsSync(p.dbDamaged)) return { at: "", keptAs: "" }; // (a marker nobody can read still stops the background work)
  }
  try {
    const kept = readdirSync(p.dir).find((f) => f.startsWith(CORRUPT) && !/-(wal|shm)$/.test(f));
    return kept ? { at: "", keptAs: join(p.dir, kept) } : undefined; // (the file was set aside and the marker never written, or lost)
  } catch {
    return undefined;
  }
};
/** The conversations whose database was set aside and not yet looked at, from the markers on disk. Never opens a database. */
export function damagedConvs(root?: string): (Damage & { conv: ConvId })[] {
  const L = root ? layout(root) : undefined;
  const dir = L ? L.conversations : conversationsDir();
  const out: (Damage & { conv: ConvId })[] = [];
  try {
    for (const conv of readdirSync(dir)) {
      if (!isConvId(conv)) continue;
      const d = convDamage(L ? L.conv(conv) : conv);
      if (d) out.push({ conv, ...d });
    }
  } catch {
    /* no conversations yet */
  }
  return out;
}
/** A person has looked: the conversation's background work may run again (the fresh database stays; restore the set-aside file first if its state matters). */
export function clearDamage(c: ConvRef): void {
  const p = convPaths(c);
  rmSync(p.dbDamaged, { force: true });
  try {
    for (const f of readdirSync(p.dir)) if (f.startsWith(CORRUPT)) renameSync(join(p.dir, f), join(p.dir, f.replace(CORRUPT, "assistant.db.reviewed-"))); // (kept for a human, no longer "damaged")
  } catch {
    /* no folder */
  }
}

/** The damage policy belongs to the AGENT. Any other process (a CLI, the intake page, a script) that finds a damaged file must not rename it under the agent's open handle: it gets this error and the file stays. */
export class ConvDbDamagedError extends Error {
  constructor(path: string, why: string) {
    super(`${path} is damaged (${why}); only the running agent sets a conversation database aside (restart it, or run npm run doctor)`);
    this.name = "ConvDbDamagedError";
  }
}
let agentMode = false;
/** The agent process says so once at start (migrateatstart.ts): only then may a damaged database be set aside and replaced. */
export const useConvDbAgentMode = (on = true): void => void (agentMode = on);

function attempt(p: ConvPaths, conv: ConvId): Db {
  // verify: the full integrity check once per open (a few small tables: cheap); a page SQLite cannot read shows here, not at the first query in the middle of a turn
  return openDb(p.db, { migrations: CONV_SCHEMA, rebuildable: false, verify: true, label: `${conv}'s assistant.db` });
}

/** Copies what can still be read out of the damaged copy into the fresh database, table by table, each in its own try/catch: the mail ids (so the inbox is not triaged again) and the session pointer. Approvals are NOT copied: they are listed. */
function salvage(kept: string, fresh: Db, damage: Damage): void {
  let raw: DatabaseSync | undefined;
  try {
    raw = new DatabaseSync(kept, { readOnly: true });
  } catch {
    return; // not even a database
  }
  try {
    const ids: string[] = [];
    try {
      for (const r of raw.prepare("SELECT id FROM seen_mail ORDER BY seq").all() as { id: unknown }[]) if (typeof r.id === "string") ids.push(r.id);
    } catch {
      /* this table is not readable */
    }
    const keep = ids.slice(-2000);
    fresh.tx(() => {
      for (const id of keep) fresh.run("INSERT OR IGNORE INTO seen_mail (id) VALUES (?)", id);
    });
    let session = false;
    try {
      const r = raw.prepare("SELECT session_id, cost_usd, last_turn_at, last_context_tokens, compact_failed_at, base_tokens, seen_at, untrusted_in FROM session WHERE id = 1").get() as Record<string, string | number | null> | undefined;
      if (r) {
        fresh.run(
          "INSERT OR REPLACE INTO session (id, session_id, cost_usd, last_turn_at, last_context_tokens, compact_failed_at, base_tokens, seen_at, untrusted_in) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
          ...([r.session_id, typeof r.cost_usd === "number" ? r.cost_usd : 0, r.last_turn_at, r.last_context_tokens, r.compact_failed_at, r.base_tokens, r.seen_at, r.untrusted_in].map((v) => (typeof v === "string" || typeof v === "number" ? v : null)) as (string | number | null)[]),
        );
        session = true;
      }
    } catch {
      /* not readable */
    }
    const lost: { n: number; label: string }[] = [];
    try {
      for (const r of raw.prepare("SELECT n, label FROM pending_items ORDER BY n").all() as { n: unknown; label: unknown }[]) if (typeof r.n === "number") lost.push({ n: r.n, label: typeof r.label === "string" ? r.label.slice(0, 120) : "" });
    } catch {
      /* not readable */
    }
    damage.salvaged = { seenMail: keep.length, session };
    if (lost.length) {
      damage.pendingLost = lost.slice(0, 40);
      for (const l of damage.pendingLost) fresh.run("INSERT INTO pending_lost (n, label, why, at) VALUES (?, ?, 'damaged', ?)", l.n, l.label, damage.at);
    }
  } finally {
    try { raw.close(); } catch { /* closed */ }
  }
}

function openFor(p: ConvPaths, conv: ConvId): Db {
  const have = open.get(p.db);
  if (have?.db.isOpen) {
    have.used = Date.now();
    return have.db;
  }
  let db: Db;
  try {
    db = attempt(p, conv);
  } catch (e) {
    const corrupt = e instanceof LedgerCorruptError || (e as { errcode?: number }).errcode === 11;
    if (!corrupt) throw e;
    const why = (e as Error).message.slice(0, 200);
    if (!agentMode) throw new ConvDbDamagedError(p.db, why); // (not the agent: the file stays where it is, the agent may hold it open)
    const at = new Date().toISOString();
    const to = `${p.db}.corrupt-${at.replace(/[:.]/g, "-")}`;
    const damage: Damage & { why: string } = { at, keptAs: to, why };
    writeFileAtomic(p.dbDamaged, JSON.stringify(damage)); // FIRST: the marker, so a crash between the two steps still leaves the conversation marked
    moveCorruptAside(p.db, to);
    console.error(`convdb: ${conv}'s assistant.db is damaged (${why}); set aside as ${to}. Chat goes on with a fresh start; its background work is stopped until a person looks (npm run doctor).`);
    db = attempt(p, conv);
    db.run("INSERT OR REPLACE INTO reset (id, at) VALUES (1, ?)", at); // the first look after this skips every mail in the inbox: a fresh database never means "triage it all again"
    salvage(to, db, damage);
    writeFileAtomic(p.dbDamaged, JSON.stringify(damage));
  }
  open.set(p.db, { db, conv, used: Date.now() });
  return db;
}

/** The conversation's database of the current data folder: opened at the first use (made, migrated, checked), the same connection after that. */
export const convDb = (conv: ConvRef): Db => openFor(convPaths(conv), typeof conv === "string" ? conv : conv.convId);
/** The same at an explicit data root (the migration and its tests). */
export const convDbAt = (root: string, conv: ConvId): Db => openFor(layout(root).conv(conv), conv);
/** Is the database there? (A reader that must not make one: the retention rules, the doctor.) */
export const hasConvDb = (conv: ConvRef): boolean => existsSync(convPaths(conv).db);
/** The database for a READ: undefined when the conversation has none yet (or was forgotten), so a read neither makes a folder nor brings a forgotten conversation back. The caller answers its default. */
export const peekConvDb = (conv: ConvRef): Db | undefined => (hasConvDb(conv) ? convDb(conv) : undefined);
/**
 * The database for a WRITE of a look or a follow-up run that started earlier: undefined when the conversation is (now) damaged. The open itself may be what finds the damage (an idle connection was closed
 * meanwhile); the check comes AFTER it, so the run's few rows are never written into the fresh database that replaced the damaged one.
 */
export function liveConvDb(conv: ConvRef): Db | undefined {
  const db = convDb(conv);
  return convDamage(conv) ? undefined : db;
}

/** Close this conversation's connection (and with it its -wal and -shm files): before its folder is deleted, and by the idle sweep. A later use opens it again. */
export function closeConvDb(conv: ConvRef): void {
  const p = convPaths(conv);
  const e = open.get(p.db);
  if (!e) return;
  e.db.close();
  open.delete(p.db);
}
export function closeConvDbAt(root: string, conv: ConvId): void {
  const e = open.get(layout(root).conv(conv).db);
  if (!e) return;
  e.db.close();
  open.delete(layout(root).conv(conv).db);
}
/** Close the connections nobody has used for `idleMs` (the tick does; a conversation that talks keeps its). Returns how many. A store never holds a Db across calls, so a closed one is simply opened again. */
export function closeIdleConvDbs(now = Date.now(), idleMs = IDLE_MS): number {
  let n = 0;
  for (const [path, e] of [...open]) {
    if (e.db.inTx || now - e.used < idleMs) continue;
    e.db.close();
    open.delete(path);
    n++;
  }
  return n;
}
export function closeAllConvDbs(): void {
  for (const e of open.values()) e.db.close();
  open.clear();
}
export const openConvDbCount = (): number => open.size;

/**
 * Forgetting a conversation: its connection is closed FIRST (a deleted folder under an open SQLite handle leaves the -wal and -shm files, or a handle that writes into nothing), then the whole folder goes.
 * Idempotent. Returns whether there was a folder. The one place the three removals (a friend, a group, a deleted tenant) delete a conversation's folder.
 */
export function removeConvDir(conv: ConvRef): boolean {
  const dir = convPaths(conv).dir;
  closeConvDb(conv);
  const had = existsSync(dir);
  if (isInside(dir, conversationsDir())) rmSync(dir, { recursive: true, force: true });
  return had;
}

/** The doctor's look at one conversation's database file WITHOUT opening it the normal way (which would set a damaged one aside): read-only, quick_check. "ok", or what is wrong. */
export function checkConvDbFile(path: string): string {
  let raw: DatabaseSync | undefined;
  try {
    raw = new DatabaseSync(path, { readOnly: true });
    const rows = raw.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
    const verdict = rows.map((r) => String(Object.values(r)[0])).slice(0, 3).join("; ");
    const v = Number(Object.values(raw.prepare("PRAGMA user_version").get() as Record<string, unknown>)[0]);
    return verdict !== "ok" ? verdict : v > CONV_SCHEMA.length ? `schema version ${v} is newer than this code knows (${CONV_SCHEMA.length})` : "ok";
  } catch (e) {
    return (e as Error).message;
  } finally {
    try { raw?.close(); } catch { /* already closed */ }
  }
}
