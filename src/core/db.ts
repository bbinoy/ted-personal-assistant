import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// ONE small module over node:sqlite (Node 24's built-in SQLite; no dependency) that every database of the assistant opens through: instance/instance.db today, a conversation's
// assistant.db later. It owns the things that must be the same everywhere and easy to get wrong:
//   * the pragmas: WAL (readers never block the writer, and the intake page, a separate process, and the agent share a file safely), synchronous=NORMAL (a power cut can lose the
//     last moments of a commit, never corrupt the file; a ledger asks for FULL on the commits that must survive: tx(fn, { durable: true })), foreign_keys=ON, a busy_timeout so a
//     second process waits for the writer instead of failing, and an owner-only file (0600; SQLite gives the -wal and -shm files the same mode);
//   * numbered schema steps, each applied in its own transaction with the version in PRAGMA user_version, so a crash mid-upgrade leaves the old version, and two processes that start
//     at the same moment cannot both apply one (the version is read again after the write lock is taken);
//   * tx(fn): BEGIN IMMEDIATE (the write lock is taken up front, so a read-then-write inside it can never be upgraded into a deadlock), ROLLBACK when fn throws; nested calls are savepoints;
//   * a cache of prepared statements (a hot query like the budget check is parsed once);
//   * a database that is damaged: a REBUILDABLE one (a cache) is moved aside as <name>.corrupt-<time> and started empty, like state.ts readJson does for a file; one that holds a LEDGER
//     (payments, spend) is NEVER reset: opening it throws a LedgerCorruptError that says what happened, and the file is left exactly as it is for a human or `sqlite3 .recover`.
// It imports nothing of the app (not even the paths: callers give the path, from core/convpaths.ts), so a script or a test can use it alone.

export type Param = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface Migration {
  version: number; // 1, 2, 3 ...: consecutive, never edited once shipped (add a new step)
  name: string;
  up: string | ((db: Db) => void); // SQL (several statements are fine) or code; runs inside the step's transaction
}

export interface OpenOptions {
  migrations: readonly Migration[];
  /** true: the data can be derived again (a cache); a damaged file is moved aside and the database starts empty. false (default): a ledger; a damaged file stops the start. */
  rebuildable?: boolean;
  busyTimeoutMs?: number; // how long a second process waits for the writer (default 5000)
  label?: string; // what to call it in a message ("instance.db")
  verify?: boolean; // run PRAGMA integrity_check once the schema is in place; anything but "ok" is corruption (a damaged page opens fine and only a check finds it)
}

/** A database that holds a ledger could not be opened because the file is damaged. Never swallowed into an empty database. */
export class LedgerCorruptError extends Error {
  readonly path: string;
  constructor(path: string, label: string, cause: string) {
    super(
      `${label} (${path}) is damaged (${cause}). It holds the payment and spend ledgers, so the agent will NOT start with an empty one. The file has been left exactly as it is. ` +
        `Restore it from your backup (copy back instance/instance.db while the agent is stopped), or try: sqlite3 ${path} ".recover" | sqlite3 recovered.db and put recovered.db in its place. ` +
        `If you really want to start from nothing, move the file (and its -wal and -shm) away yourself.`,
    );
    this.name = "LedgerCorruptError";
    this.path = path;
  }
}
/** The file was made by a newer version of the code (its user_version is above the last step known here). Writing to it could break it. */
export class NewerSchemaError extends Error {
  constructor(path: string, found: number, known: number) {
    super(`${path} has schema version ${found}, newer than this code knows (${known}): update the code; it will not touch the file.`);
    this.name = "NewerSchemaError";
  }
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
/** Is this the error of a file that is not a (healthy) database? By SQLite's own result code, with the message as a fallback for builds that do not give one. */
export function isCorruption(e: unknown): boolean {
  const err = e as { errcode?: number; message?: string };
  if (err.errcode === SQLITE_CORRUPT || err.errcode === SQLITE_NOTADB) return true;
  return /malformed|not a database|disk image is malformed|file is encrypted/i.test(err.message ?? "");
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");
const STATEMENTS_MAX = 300; // (a bound on the cache of prepared statements: callers with dynamic SQL cannot grow it without end)
const open = new Set<Db>();
let exitHooked = false;
const closeAllAtExit = (): void => {
  for (const d of [...open]) d.close();
};

export class Db {
  readonly path: string;
  readonly label: string;
  private raw: DatabaseSync | undefined;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  /** @internal use openDb */
  constructor(path: string, label: string, raw: DatabaseSync) {
    this.path = path;
    this.label = label;
    this.raw = raw;
  }

  private get h(): DatabaseSync {
    if (!this.raw) throw new Error(`${this.label} is closed`);
    return this.raw;
  }
  get isOpen(): boolean {
    return this.raw !== undefined;
  }

  /** A prepared statement for this text, made once. */
  prepare(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size >= STATEMENTS_MAX) this.cache.clear();
      s = this.h.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
  exec(sql: string): void {
    this.h.exec(sql);
  }
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }
  /** One number from a query that returns one row with one column (a SUM, a COUNT); 0 when there is no row or it is NULL. */
  num(sql: string, ...params: Param[]): number {
    const r = this.prepare(sql).get(...params) as Row | undefined;
    const v = r ? Object.values(r)[0] : 0;
    return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0;
  }

  get inTx(): boolean {
    return this.depth > 0;
  }

  /**
   * All of fn's writes or none. The write lock is taken at the start (BEGIN IMMEDIATE) and waits busy_timeout for another process's commit. A throw rolls back and rethrows.
   * Inside another tx it is a savepoint (a failed inner part undoes only itself when the caller catches it).
   * `durable`: this commit is fsynced even in WAL mode (synchronous=FULL for it): for a ledger row that must survive a power cut.
   */
  tx<T>(fn: () => T, o: { durable?: boolean } = {}): T {
    const h = this.h;
    if (this.depth > 0) {
      const sp = `sp${this.depth}`;
      h.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn();
        h.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        h.exec(`ROLLBACK TO ${sp}`);
        h.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.depth--;
      }
    }
    if (o.durable) h.exec("PRAGMA synchronous=FULL"); // (cannot change inside a transaction: set before BEGIN)
    h.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const r = fn();
      h.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        h.exec("ROLLBACK");
      } catch {
        /* already rolled back by SQLite (e.g. after a full disk) */
      }
      throw e;
    } finally {
      this.depth = 0;
      if (o.durable) h.exec("PRAGMA synchronous=NORMAL");
    }
  }

  get version(): number {
    return this.num("PRAGMA user_version");
  }
  /** PRAGMA quick_check (default) or integrity_check: "ok", or what SQLite found (the first lines). */
  check(full = false): string {
    const rows = this.h.prepare(full ? "PRAGMA integrity_check" : "PRAGMA quick_check").all() as Row[];
    return rows.map((r) => String(Object.values(r)[0])).slice(0, 5).join("; ");
  }
  get journalMode(): string {
    return String(Object.values(this.h.prepare("PRAGMA journal_mode").get() as Row)[0]);
  }
  /** Fold the write-ahead log into the main file (a backup copy of the .db alone is then complete). */
  checkpoint(): void {
    this.h.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (!this.raw) return;
    open.delete(this);
    try {
      this.cache.clear();
      this.raw.close();
    } catch {
      /* closing is best effort */
    } finally {
      this.raw = undefined;
    }
  }
}

function pragmas(h: DatabaseSync, busyMs: number): void {
  h.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyMs))}`); // FIRST: the next statements may have to wait for another process
  h.exec("PRAGMA journal_mode=WAL");
  h.exec("PRAGMA synchronous=NORMAL");
  h.exec("PRAGMA foreign_keys=ON");
}

function ownerOnly(path: string): void {
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600)); // (created with the mode; SQLite adds -wal and -shm with the same one)
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

function checkMigrations(ms: readonly Migration[]): void {
  ms.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`db: migration steps must be numbered 1, 2, 3 ... (step ${i + 1} is numbered ${m.version})`);
  });
}

/** Applies every step above the file's user_version, each in its own transaction (the version is read again under the lock: another process may have just done it). */
export function migrateDb(db: Db, ms: readonly Migration[]): number {
  checkMigrations(ms);
  const known = ms.length;
  const found = db.version;
  if (found > known) throw new NewerSchemaError(db.path, found, known);
  let applied = 0;
  for (const m of ms) {
    if (m.version <= found) continue;
    db.tx(() => {
      if (db.version >= m.version) return; // (another process got here first)
      if (typeof m.up === "string") db.exec(m.up);
      else m.up(db);
      db.exec(`PRAGMA user_version=${m.version}`);
      applied++;
    });
  }
  return applied;
}

function moveCorruptAside(path: string): string {
  const to = `${path}.corrupt-${stamp()}`;
  renameSync(path, to);
  for (const side of ["-wal", "-shm"]) {
    try {
      renameSync(path + side, to + side);
    } catch {
      /* none */
    }
  }
  return to;
}

function openOnce(path: string, o: OpenOptions): Db {
  const label = o.label ?? path;
  const busy = o.busyTimeoutMs ?? 5000;
  ownerOnly(path);
  const raw = new DatabaseSync(path);
  let db: Db | undefined;
  try {
    pragmas(raw, busy);
    db = new Db(path, label, raw);
    migrateDb(db, o.migrations);
    if (o.verify) {
      const verdict = db.check(true); // the FULL check: quick_check does not compare an index with its table, and a damaged index silently skews every sum
      if (verdict !== "ok") throw Object.assign(new Error(`integrity_check: ${verdict}`), { errcode: SQLITE_CORRUPT });
    }
    return db;
  } catch (e) {
    try {
      raw.close();
    } catch {
      /* already closed */
    }
    throw e;
  }
}

/**
 * Opens (creating it, owner-only, with its folder at 0700) and brings the schema up to date. A damaged file: rebuildable -> moved aside and started empty (said on stderr);
 * otherwise LedgerCorruptError. A file from a newer version of the code: NewerSchemaError. Closed at process exit.
 */
export function openDb(path: string, o: OpenOptions): Db {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let db: Db;
  try {
    db = openOnce(path, o);
  } catch (e) {
    if (!isCorruption(e)) throw e;
    const label = o.label ?? path;
    if (!o.rebuildable) throw new LedgerCorruptError(path, label, (e as Error).message);
    const kept = moveCorruptAside(path);
    console.error(`db: ${label} is damaged (${(e as Error).message}); moved aside to ${kept}, starting empty (it holds only what can be rebuilt)`);
    db = openOnce(path, o);
  }
  open.add(db);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", closeAllAtExit);
  }
  return db;
}
