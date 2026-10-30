import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { conversationsDir, convPaths, isConvId, layout, type ConvId, type ConvPaths, type ConvRef } from "./convpaths.ts";
import { Db, LedgerCorruptError, moveCorruptAside, openDb, schemaVersion, type Migration } from "./db.ts";
import { DatabaseSync } from "node:sqlite";
import { isInside } from "./contain.ts";
import { writeFileAtomic } from "./state.ts";

// <conversation>/assistant.db: the small mutable state of ONE conversation, one SQLite file in its folder (docs/ARCHITECTURE.md "assistant.db"). It replaced one little JSON file per kind of
// state (layout 4): the resumed session, the dream's day, the posts held for quiet hours, the mail ids already worked through, /quiet, the voice notes received, a friend's bookkeeping.
// A conversation's state is in ITS file and nowhere else: a query cannot reach another conversation's rows because it has no connection to them (test/convdb.test.ts), and forgetting a conversation is
// still deleting its folder (the connection is closed first: forgetConv / closeConvDb).
//
//   session / dream / hold / quiet / friend   ONE row each (id = 1): a CHECK keeps it so
//   held_posts       the posts quiet hours or the day's cap kept back, oldest first (bounded where they are written)
//   seen_mail        the mail ids the heartbeat has worked through, oldest first: seq orders them, the bound (2000) is a query (trimSeenMail), also a retention rule
//   voice_notes / voice_quotes   the voice notes received in this conversation and the messages that quote them
//   meetings / meeting_calls   the upcoming meetings the heartbeat look recorded, the prep sent for each, and when the look last reported (tasks/meetings.ts)
//   routine_runs     the last period of each routine (a routine note): once per occurrence, retries, skips (src/tasks/routines.ts)
//   items / task_events   the tasks (src/tasks/store.ts): a to-do, a promise either way; nothing is deleted (triggers), every change is a task_events row. User data: no retention.
//   lapsed_approvals background approvals nobody answered in time, until a look is told (7 days at most, a retention rule)
//   told             what was told once, or at most once a day / in a while, about this conversation: `group-reminder:<member>` = a group member told that a reminder said in the group is the group's (core/told.ts, src/tasks/grouptasks.ts).
//
// NOT rebuildable. Losing the tasks or the session pointer is bad (not financial), and losing seen_mail re-triages the whole inbox, so a damaged file is never quietly replaced by an empty
// one like a cache would be. What happens instead (the policy, tested): the file is SET ASIDE (assistant.db.corrupt-<time>, its -wal and -shm with it), a marker (assistant.db.damaged) is written,
// and a fresh empty database starts, so CHAT KEEPS WORKING (a fresh session; the person can still talk to it). While the marker is there that conversation's BACKGROUND work is refused (payer.ts mayRun:
// the heartbeat look, the dream, quiet compaction, approved archives), the owner is told once a day (heartbeat/notices.ts) and the doctor fails with the file's name. A person restores the set-aside file
// (or `sqlite3 .recover`) and deletes the marker; deleting only the marker accepts the fresh start. The other conversations are not affected: each has its own file.
//
// How to add state: append ONE numbered step to CONV_SCHEMA below (the last version + 1, `CREATE TABLE ...`). Steps run in order, each in
// its own transaction, at the first open of each conversation's file; a step is never edited once shipped. The first step is the BASELINE (the whole shape; steps before 22 are collapsed into it):
// a file older than it is refused (core/db.ts OlderSchemaError), a fresh file gets the baseline and every step after it. Then a small store module over convDb(conv), and, if the table grows, a retention rule (heartbeat/convretention.ts).

export const CONV_SCHEMA: readonly Migration[] = [
  {
    version: 22,
    name: "baseline: the whole shape of a conversation's database (steps before 22 are collapsed)",
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
        at        INTEGER
      );

      CREATE TABLE seen_mail (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,                      -- oldest first: the bound drops the lowest
        id  TEXT NOT NULL UNIQUE
      );

      CREATE TABLE quiet (
        id    INTEGER PRIMARY KEY CHECK (id = 1),                   -- a row = /quiet is set
        until TEXT NOT NULL                                         -- '' = until /unquiet, else an ISO time
      );

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

      CREATE TABLE reset (
        id INTEGER PRIMARY KEY CHECK (id = 1),                      -- a row = this database REPLACED a damaged one: the first look marks every mail in the inbox as seen (never a re-triage)
        at TEXT NOT NULL
      );

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
        done_at     INTEGER,
        urgent      INTEGER CHECK (urgent IS NULL OR urgent IN (0, 1))  -- 1: the reminder may break quiet hours
      );
      CREATE INDEX items_status ON items (status, due);
      -- Nothing is ever deleted: dropped is the end state. The database says so itself, so no code path can (a test greps for one as well).
      CREATE TRIGGER items_no_delete BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT, 'tasks are never deleted: drop them'); END;

      CREATE TABLE task_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items (id),
        at      INTEGER NOT NULL,                                   -- UTC ms
        by      TEXT NOT NULL,                                      -- owner, a member's or friend's name, assistant (look), system
        action  TEXT NOT NULL CHECK (action IN ('added', 'edited', 'done', 'reopened', 'dropped', 'snoozed', 'suggested', 'confirmed', 'rejected', 'reminded')),
        before  TEXT,                                               -- JSON: the changed fields as they were
        after   TEXT                                                -- JSON: ... and as they are
      );
      CREATE INDEX task_events_item ON task_events (item_id, id);
      CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'the task history is append-only'); END;
      CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT, 'the task history is append-only'); END;

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

      CREATE TABLE group_remind_noted (
        member TEXT PRIMARY KEY,                                    -- a group member's name: told once that a reminder said here is the group's, not private
        at     INTEGER NOT NULL
      );

      CREATE TABLE learned_changes (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        at      INTEGER NOT NULL,                                   -- UTC ms
        source  TEXT NOT NULL CHECK (source IN ('dream', 'look')),
        action  TEXT NOT NULL CHECK (action IN ('add', 'update', 'merge', 'delete', 'undone')),  -- undone: not a change, the note that a whole dream (gist: its day) was undone after its lines were told
        file    TEXT NOT NULL,                                      -- the note's file name
        gist    TEXT NOT NULL,                                      -- its one-line description (or, for a delete, why)
        merged  TEXT,                                               -- JSON: the notes a merge replaced
        batch   INTEGER,                                            -- the summary that listed it; NULL: not yet summarised (so nothing is told twice)
        outcome TEXT CHECK (outcome IS NULL OR outcome IN ('confirmed', 'undone', 'gone'))  -- what a reply did with it; gone: no longer true by summary time, never listed
      );
      CREATE INDEX learned_changes_batch ON learned_changes (batch, seq);
      CREATE TABLE learned_batches (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,                                    -- UTC ms
        msg_ts INTEGER                                              -- the message that carried the list (a reply that quotes it answers for its numbers); NULL: it went in the brief
      );
      CREATE INDEX learned_batches_ts ON learned_batches (msg_ts);

      CREATE TABLE meetings (
        event_id  TEXT NOT NULL,                                    -- the calendar's id for the event, as the calendar tool returned it
        start_ms  INTEGER NOT NULL,                                 -- UTC ms: a moved event is a NEW row (its old pending row goes), so a reschedule gets its own prep
        end_ms    INTEGER,
        title     TEXT NOT NULL,
        attendees TEXT NOT NULL,                                    -- JSON: [{name?, email?, self?}], bounded
        link      TEXT,                                             -- a video-call link, https only
        all_day   INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
        response  TEXT,                                             -- the owner's own answer to the invite (accepted, tentative, needsAction, declined)
        private   INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
        noted     INTEGER NOT NULL,                                 -- UTC ms: when the look last recorded it
        state     TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'sent', 'retry', 'failed', 'skipped')),  -- claimed: marked BEFORE the run starts (at most once)
        why       TEXT,                                             -- skipped: the rule that said no
        tries     INTEGER NOT NULL DEFAULT 0,
        at        INTEGER,                                          -- the last change of state
        cost_usd  REAL,
        PRIMARY KEY (event_id, start_ms)
      );
      CREATE INDEX meetings_start ON meetings (start_ms);
      CREATE TABLE meeting_calls (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        at    INTEGER NOT NULL,                                     -- UTC ms: the look's last note_upcoming_meetings call (an empty list too: the doctor tells "the calendar is read" from "nothing ever arrives")
        count INTEGER NOT NULL                                      -- how many meetings that call held
      );

      CREATE TABLE routine_runs (
        name           TEXT PRIMARY KEY,                            -- the routine ("evening", "weekly"); the brief keeps its own status note
        since          INTEGER NOT NULL,                            -- UTC ms: when the planner first saw it (slots before are nobody's miss)
        period         TEXT,                                        -- the date of the slot the status is for
        status         TEXT CHECK (status IS NULL OR status IN ('started', 'delivered', 'failed', 'skipped')),
        at             INTEGER,                                     -- UTC ms of the last status change
        attempts       INTEGER NOT NULL DEFAULT 0,                  -- starts in this period
        told           INTEGER NOT NULL DEFAULT 1,                  -- 0: a skipped period the owner has not been told about yet
        last_delivered INTEGER                                      -- UTC ms of the last successful run (the doctor)
      );
    `,
  },
  {
    version: 23,
    name: "one record of what was told (core/told.ts): the group members told once about reminders become `told` rows",
    up: `
      CREATE TABLE told (
        key  TEXT PRIMARY KEY,
        at   INTEGER NOT NULL,                                      -- epoch ms it was last told
        once INTEGER NOT NULL DEFAULT 0                             -- 1: told once for good
      );
      INSERT INTO told (key, at, once) SELECT 'group-reminder:' || member, at, 1 FROM group_remind_noted;
      DROP TABLE group_remind_noted;
    `,
  },
  {
    version: 24,
    name: "background approvals that lapsed unanswered, until a look has been told (src/approvals/approvals.ts, heartbeat/facts.ts)",
    up: `
      CREATE TABLE lapsed_approvals (
        seq   INTEGER PRIMARY KEY AUTOINCREMENT,
        at    INTEGER NOT NULL,                                     -- epoch ms it lapsed
        label TEXT NOT NULL,                                        -- the action, first line of the approval details
        wait  TEXT NOT NULL                                         -- how long it waited, as text
      );
    `,
  },
  {
    version: 25,
    name: "no 'learned overnight' lists: the record is the journal (and the dream's snapshots), so the tables that fed the lists go",
    up: `
      DROP TABLE learned_changes;
      DROP TABLE learned_batches;
    `,
  },
  {
    version: 26,
    name: "a routine owes a channel its run did not deliver (the brief's email): the retry is told only that is owed",
    up: `
      ALTER TABLE routine_runs ADD COLUMN owes TEXT;                -- the channel the last run of this period did not deliver ("email"); NULL: nothing owed
      ALTER TABLE routine_runs ADD COLUMN chat_sent INTEGER NOT NULL DEFAULT 0; -- 1: that run did tell the chat, so the retry must not
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
/** The agent process says so once at start (agentstart.ts): only then may a damaged database be set aside and replaced. */
export const useConvDbAgentMode = (on = true): void => void (agentMode = on);

function attempt(p: ConvPaths, conv: ConvId): Db {
  // verify: the full integrity check once per open (a few small tables: cheap); a page SQLite cannot read shows here, not at the first query in the middle of a turn
  return openDb(p.db, { migrations: CONV_SCHEMA, rebuildable: false, verify: true, label: `${conv}'s assistant.db` });
}

/** Copies what can still be read out of the damaged copy into the fresh database, table by table, each in its own try/catch: the mail ids (so the inbox is not triaged again) and the session pointer. */
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
    damage.salvaged = { seenMail: keep.length, session };
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
/** The same at an explicit data root (tests and the doctor). */
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
    return verdict !== "ok" ? verdict : v > schemaVersion(CONV_SCHEMA) ? `schema version ${v} is newer than this code knows (${schemaVersion(CONV_SCHEMA)})` : v > 0 && v < CONV_SCHEMA[0]!.version ? `schema version ${v} is older than the oldest this code upgrades (${CONV_SCHEMA[0]!.version})` : "ok";
  } catch (e) {
    return (e as Error).message;
  } finally {
    try { raw?.close(); } catch { /* already closed */ }
  }
}
