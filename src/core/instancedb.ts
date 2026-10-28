import { instancePaths } from "./convpaths.ts";
import { Db, LedgerCorruptError, openDb, type Migration } from "./db.ts";

// instance/instance.db: the process-wide records, tables of ONE database (docs/ARCHITECTURE.md "instance.db"). The agent
// and the intake page (a separate process) both open it; WAL lets them share it. Opened lazily at the first use, once per path, closed at exit (core/db.ts).
//
//   spend      one row per charged run (budget.ts): who paid (the instance's login or the instance key), for which conversation, what kind of run, how many dollars, on which local day.
//              "Owner today", "the key today", "a group today", "a friend today" are indexed sums of it. A LEDGER: never reset, pruned only by age (retention).
//   notices    when each notice was last told, by key: the one "at most once per interval" throttle (capnotice.ts)
//   looks      one row per heartbeat look of any conversation, counts and flags only (core/looks.ts)
//   payments   the card payment ledger: one row per status change, never deleted (modules/browse/payments.ts). A LEDGER.
//   intake     what the intake page stored for a friend (names and counts, never a value) and when a connection stopped working, by tenant and purpose (intake/intakelinks.ts)
//   kv         small single values: "heartbeat" (the last tick), "connectors" (what the last run saw), "tools-seen"
// A database with a ledger in it is not rebuildable: a damaged file stops the start with a message (core/db.ts LedgerCorruptError).

export const INSTANCE_SCHEMA: readonly Migration[] = [
  {
    version: 4,
    name: "baseline: the whole shape of the instance database (the 4 steps before it are collapsed; a file older than this is refused)",
    up: `
      CREATE TABLE spend (
        id    INTEGER PRIMARY KEY,
        at    INTEGER NOT NULL,                                   -- epoch ms of the charge
        day   TEXT NOT NULL,                                      -- the local day (YYYY-MM-DD) the budgets count by
        conv  TEXT NOT NULL,                                      -- the convId the run was for ('' once forgotten)
        payer TEXT NOT NULL CHECK (payer IN ('login','key')),    -- the instance's own login, or the instance API key (a friend's run)
        kind  TEXT NOT NULL,                                      -- chat, look, dream, gate, helper, mail, ... (the run's profile)
        usd   REAL NOT NULL CHECK (usd > 0)
      );
      CREATE INDEX spend_payer_day ON spend (payer, day, usd);
      CREATE INDEX spend_conv_day ON spend (conv, payer, day, usd);

      CREATE TABLE notices (
        key     TEXT PRIMARY KEY,
        last_at INTEGER                                           -- interval-throttled notices: epoch ms of the last one
      );

      CREATE TABLE looks (
        id                 INTEGER PRIMARY KEY,
        at                 TEXT NOT NULL,                         -- ISO: when the look began
        at_ms              INTEGER NOT NULL,
        kind               TEXT NOT NULL DEFAULT 'owner',         -- owner, group, tenant
        night              INTEGER NOT NULL,
        message            INTEGER NOT NULL,
        sent               INTEGER,
        next_check_minutes INTEGER NOT NULL,
        cost_usd           REAL NOT NULL,
        tool_calls         INTEGER NOT NULL,
        archived           INTEGER NOT NULL,
        delegations        INTEGER NOT NULL,
        outcome            TEXT NOT NULL
      );
      CREATE INDEX looks_kind_id ON looks (kind, id);
      CREATE INDEX looks_at ON looks (at_ms);

      CREATE TABLE payments (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,            -- append order
        id          TEXT NOT NULL,                                -- the approval id
        ts          TEXT NOT NULL,                                -- ISO
        merchant    TEXT NOT NULL,
        total_minor INTEGER NOT NULL,
        currency    TEXT NOT NULL,
        last4       TEXT NOT NULL,
        cart_hash   TEXT NOT NULL,
        status      TEXT NOT NULL                                 -- approved, clicked, confirmed, failed, unconfirmed, cleared (no CHECK: a row must never be refused)
      );
      CREATE INDEX payments_id ON payments (id, seq);
      CREATE INDEX payments_cart ON payments (merchant, cart_hash);
      CREATE INDEX payments_ts ON payments (ts);
      -- a payment's latest row is the newest by (ts, seq)
      CREATE VIEW payments_latest AS
        SELECT p.*, g.first_ts AS first_ts, g.first_seq AS first_seq
        FROM payments p
        JOIN (SELECT id, MIN(ts) AS first_ts, MIN(seq) AS first_seq FROM payments GROUP BY id) g ON g.id = p.id
        WHERE NOT EXISTS (SELECT 1 FROM payments q WHERE q.id = p.id AND (q.ts > p.ts OR (q.ts = p.ts AND q.seq > p.seq)));

      CREATE TABLE intake (
        tenant     TEXT NOT NULL,
        purpose    TEXT NOT NULL,
        done_at    TEXT,                                          -- ISO: the last completed form
        stored     TEXT,                                          -- JSON [{name, chars}] of that form: names and lengths, never a value
        problem_at TEXT,                                          -- ISO: the service stopped accepting the connection (cleared by a newer form)
        PRIMARY KEY (tenant, purpose)
      );

      CREATE TABLE kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

const dbs = new Map<string, Db>();

/** Opens (or returns the open) database at an explicit path: for tests and the doctor. A ledger database: a damaged file is not replaced. */
export function openInstanceDbAt(path: string): Db {
  const have = dbs.get(path);
  if (have?.isOpen) return have;
  const db = openDb(path, { migrations: INSTANCE_SCHEMA, rebuildable: false, verify: true, label: "the instance database" });
  dbs.set(path, db);
  return db;
}
// DEGRADED MODE: a damaged ledger database does not crash-loop the agent under launchd with a message nobody reads. The start (agentstart.ts) records the damage, chat goes on, and everything
// that spends or pays fails closed (budget.ts answers "spent", the card is not opened, background work is refused as if over budget); the owner is told once per start, the doctor and /status say it.
let damage: LedgerCorruptError | undefined;
/** The message of the damage, or undefined when the ledger database is fine (or not opened yet). */
export const ledgerDamage = (): string | undefined => damage?.message;
export const DAMAGED_NOTICE = "My ledger (instance/instance.db) is damaged, so background work and payments are off. Your data is untouched; see npm run doctor.";
/** Opens the instance database at start; true when it is usable. A damaged one switches the degraded mode on (and is not touched). Any other failure still throws. */
export function openAtStart(): boolean {
  try {
    openInstanceDbAt(instancePaths().db);
    return true;
  } catch (e) {
    if (!(e instanceof LedgerCorruptError)) throw e;
    damage = e;
    return false;
  }
}
/** The instance database of the current data folder (the path comes from core/convpaths.ts). Throws the damage while the degraded mode is on. */
export function instanceDb(): Db {
  if (damage) throw damage;
  return openInstanceDbAt(instancePaths().db);
}

// ---- kv: small single values, JSON ----

// (a value that cannot be read is the fallback, one that cannot be written is logged: a timer or a run never dies of a busy, full or damaged database)
export function kvGet<T>(key: string, fallback: T): T {
  try {
    const r = instanceDb().get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
    return r ? (JSON.parse(r.value) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function kvSet(key: string, value: unknown, now = Date.now()): void {
  try {
    instanceDb().run("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, JSON.stringify(value), now);
  } catch (e) {
    console.error(`instance database: could not store "${key}" (${(e as Error).message})`);
  }
}
export const kvDelete = (key: string): void => void instanceDb().run("DELETE FROM kv WHERE key = ?", key);
