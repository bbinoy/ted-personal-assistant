import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerCorruptError, NewerSchemaError, OlderSchemaError, openDb, type Migration } from "../src/core/db.ts";

// core/db.ts: the one module every SQLite database of the assistant opens through (pragmas, numbered migrations, tx, corrupt-file handling, several processes).

const dir = mkdtempSync(join(tmpdir(), "db-test-"));
let n = 0;
const fresh = (name = "x"): string => join(dir, `${name}-${++n}`, "t.db");
const STEPS: readonly Migration[] = [
  { version: 1, name: "a", up: "CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT NOT NULL);" },
  { version: 2, name: "b", up: (db) => db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL REFERENCES a(id)); CREATE INDEX b_a ON b (a_id);") },
];

test("open: WAL, synchronous NORMAL, foreign keys on, a busy timeout, owner-only file and folder", () => {
  const path = fresh();
  const db = openDb(path, { migrations: STEPS });
  assert.equal(db.journalMode, "wal");
  assert.equal(db.num("PRAGMA synchronous"), 1, "NORMAL");
  assert.equal(db.num("PRAGMA foreign_keys"), 1);
  assert.equal(db.num("PRAGMA busy_timeout"), 5000);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
  db.run("INSERT INTO a (v) VALUES ('x')");
  for (const side of ["-wal", "-shm"]) if (existsSync(path + side)) assert.equal(statSync(path + side).mode & 0o777, 0o600, `${side} follows the file's mode`);
  assert.throws(() => db.run("INSERT INTO b (a_id) VALUES (99)"), /FOREIGN KEY/, "foreign keys are enforced");
  db.close();
  assert.throws(() => db.get("SELECT 1"), /closed/);
});

test("migrations: numbered steps, each applied once in its own transaction, the version in user_version; a reopen applies nothing; a failing step leaves the version below it", () => {
  const path = fresh();
  const db = openDb(path, { migrations: STEPS });
  assert.equal(db.version, 2);
  db.close();
  const again = openDb(path, { migrations: STEPS });
  assert.equal(again.version, 2);
  again.close();
  // a third step that fails half way: nothing of it stays, and the version is still 2
  const bad: readonly Migration[] = [...STEPS, { version: 3, name: "c", up: "CREATE TABLE c (x); INSERT INTO nowhere VALUES (1);" }];
  assert.throws(() => openDb(path, { migrations: bad }), /nowhere/);
  const check = openDb(path, { migrations: STEPS });
  assert.equal(check.version, 2);
  assert.equal(check.get("SELECT name FROM sqlite_master WHERE name = 'c'"), undefined, "the half-applied step was rolled back");
  check.close();
  // numbering is checked
  assert.throws(() => openDb(fresh(), { migrations: [{ version: 1, name: "x", up: "" }, { version: 3, name: "y", up: "" }] }), /numbered consecutively/);
});

test("a baseline: a fresh file gets it, a file at the baseline version is left as it is, a file older than it is refused untouched", () => {
  const base: Migration = { version: 5, name: "baseline", up: "CREATE TABLE b (id INTEGER PRIMARY KEY);" };
  const next: Migration = { version: 6, name: "next", up: "CREATE TABLE n (id INTEGER PRIMARY KEY);" };
  const path = fresh();
  const db = openDb(path, { migrations: [base] });
  assert.equal(db.version, 5);
  db.close();
  const up = openDb(path, { migrations: [base, next] });
  assert.deepEqual([up.version, up.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name)], [6, ["b", "n"]], "a later step runs on top of the baseline");
  up.close();
  const old = fresh();
  const o = openDb(old, { migrations: STEPS }); // (version 2)
  o.close();
  assert.throws(() => openDb(old, { migrations: [base] }), (e: unknown) => e instanceof OlderSchemaError && /version 2, older than the oldest this code upgrades \(5\)/.test((e as Error).message));
  const check = openDb(old, { migrations: STEPS });
  assert.equal(check.version, 2, "the refused file is untouched");
  check.close();
});

test("a file from a newer version of the code is refused, untouched", () => {
  const path = fresh();
  const newer = openDb(path, { migrations: STEPS });
  newer.close();
  assert.throws(() => openDb(path, { migrations: STEPS.slice(0, 1) }), (e: unknown) => e instanceof NewerSchemaError && /schema version 2, newer than this code knows \(1\)/.test((e as Error).message));
});

test("tx: all or nothing, a throw rolls back and rethrows, a nested one is a savepoint, durable restores NORMAL", () => {
  const db = openDb(fresh(), { migrations: STEPS });
  db.tx(() => {
    db.run("INSERT INTO a (v) VALUES ('one')");
    db.run("INSERT INTO a (v) VALUES ('two')");
  });
  assert.equal(db.num("SELECT COUNT(*) FROM a"), 2);
  assert.throws(() => db.tx(() => (db.run("INSERT INTO a (v) VALUES ('three')"), db.run("INSERT INTO a (v) VALUES (NULL)"))), /NOT NULL/);
  assert.equal(db.num("SELECT COUNT(*) FROM a"), 2, "the first insert of the failed tx is gone");
  assert.equal(db.inTx, false);
  db.tx(() => {
    db.run("INSERT INTO a (v) VALUES ('outer')");
    assert.throws(() => db.tx(() => (db.run("INSERT INTO a (v) VALUES ('inner')"), (() => { throw new Error("inner failed"); })())), /inner failed/);
    assert.equal(db.inTx, true, "the outer tx goes on");
  });
  assert.deepEqual(db.all<{ v: string }>("SELECT v FROM a ORDER BY id").map((r) => r.v), ["one", "two", "outer"], "only the inner part was undone");
  const seen = db.tx(() => db.num("PRAGMA synchronous"), { durable: true });
  assert.equal(seen, 2, "FULL inside a durable commit");
  assert.equal(db.num("PRAGMA synchronous"), 1, "and NORMAL again after");
  assert.equal(db.tx(() => 42), 42, "the value of fn is returned");
  db.close();
});

test("prepared statements are cached by text", () => {
  const db = openDb(fresh(), { migrations: STEPS });
  assert.equal(db.prepare("SELECT 1 AS x"), db.prepare("SELECT 1 AS x"));
  assert.notEqual(db.prepare("SELECT 1 AS x"), db.prepare("SELECT 2 AS x"));
  db.close();
});

test("a damaged REBUILDABLE database is moved aside and started empty; a damaged LEDGER is never reset: the start stops with a message and the file is left as it is", () => {
  const garbage = "this is not a database, it is a lot of text. ".repeat(200);
  const cache = fresh("cache");
  openDb(cache, { migrations: STEPS }).close();
  writeFileSync(cache, garbage);
  const err = console.error;
  const said: string[] = [];
  console.error = (m: string) => void said.push(m);
  try {
    const db = openDb(cache, { migrations: STEPS, rebuildable: true, label: "the cache" });
    assert.equal(db.num("SELECT COUNT(*) FROM a"), 0, "empty, schema in place");
    db.close();
  } finally {
    console.error = err;
  }
  const kept = readdirSync(join(cache, "..")).filter((f) => f.startsWith("t.db.corrupt-"));
  assert.equal(kept.length, 1, "moved aside like readJson does");
  assert.equal(readFileSync(join(cache, "..", kept[0]!), "utf8"), garbage, "byte for byte");
  assert.match(said.join(" "), /the cache is damaged.*moved aside/);

  const ledger = fresh("ledger");
  openDb(ledger, { migrations: STEPS }).close();
  writeFileSync(ledger, garbage);
  assert.throws(() => openDb(ledger, { migrations: STEPS, label: "the ledger" }), (e: unknown) => e instanceof LedgerCorruptError && /will NOT start with an empty one/.test((e as Error).message) && /the ledger/.test((e as Error).message));
  assert.equal(readFileSync(ledger, "utf8"), garbage, "left exactly as it is");
  assert.deepEqual(readdirSync(join(ledger, "..")).filter((f) => f.includes("corrupt")), [], "not even moved aside");
  // a truncated real database is damaged too
  const real = fresh("trunc");
  const d = openDb(real, { migrations: STEPS });
  for (let i = 0; i < 500; i++) d.run("INSERT INTO a (v) VALUES (?)", `row ${i} ${"y".repeat(100)}`);
  d.checkpoint();
  d.close();
  const bytes = readFileSync(real);
  writeFileSync(real, Buffer.concat([bytes.subarray(0, 4096), Buffer.alloc(8192, 7)])); // header page kept, the rest overwritten
  assert.throws(() => openDb(real, { migrations: STEPS }), LedgerCorruptError);
});

test("two connections in one process see each other's commits", () => {
  const path = fresh();
  const a = openDb(path, { migrations: STEPS });
  const b = openDb(path, { migrations: STEPS });
  a.run("INSERT INTO a (v) VALUES ('from a')");
  assert.equal(b.num("SELECT COUNT(*) FROM a"), 1);
  b.run("INSERT INTO a (v) VALUES ('from b')");
  assert.equal(a.num("SELECT COUNT(*) FROM a"), 2);
  a.close();
  b.close();
});

// ---- several PROCESSES: the intake page and the agent ----

const DB_URL = new URL("../src/core/db.ts", import.meta.url).href;
const child = (path: string, tag: string, rows: number): Promise<number> =>
  new Promise((resolve) => {
    const code = `
      import { openDb } from ${JSON.stringify(DB_URL)};
      const db = openDb(${JSON.stringify(path)}, { migrations: [{ version: 1, name: "a", up: "CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT NOT NULL);" }, { version: 2, name: "b", up: "CREATE TABLE b (id INTEGER PRIMARY KEY)" }] });
      for (let i = 0; i < ${rows}; i++) db.tx(() => { const c = db.num("SELECT COUNT(*) FROM a"); db.run("INSERT INTO a (v) VALUES (?)", ${JSON.stringify(tag)} + ":" + c); });
      db.close();
    `;
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
    p.on("exit", (c) => resolve(c ?? -1));
  });

test("several processes open a fresh database at the same moment and write to it together: one schema, no lost row, no 'database is locked'", async () => {
  const path = fresh("multi");
  const parent = openDb(path, { migrations: STEPS.slice(0, 1) }); // (the parent holds its own connection open meanwhile, on an older schema step)
  parent.close();
  const codes = await Promise.all([child(path, "p1", 150), child(path, "p2", 150), child(path, "p3", 150)]);
  assert.deepEqual(codes, [0, 0, 0]);
  const db = openDb(path, { migrations: [...STEPS.slice(0, 1), { version: 2, name: "b", up: "CREATE TABLE b (id INTEGER PRIMARY KEY)" }] });
  assert.equal(db.version, 2);
  assert.equal(db.num("SELECT COUNT(*) FROM a"), 450, "every row of every process");
  for (const tag of ["p1", "p2", "p3"]) assert.equal(db.num("SELECT COUNT(*) FROM a WHERE v LIKE ?", `${tag}:%`), 150, tag);
  assert.equal(db.num("SELECT COUNT(DISTINCT v) FROM a"), 450, "each read-then-write inside a tx saw a different count: the write lock serialised them");
  assert.equal(db.check(), "ok");
  db.close();
});

test("the same file opened from this process and a child while this one holds a write transaction: the child waits (busy_timeout) and then succeeds", async () => {
  const path = fresh("wait");
  const db = openDb(path, { migrations: STEPS });
  const done = child(path, "late", 5);
  await new Promise<void>((resolve) => {
    db.tx(() => {
      db.run("INSERT INTO a (v) VALUES ('parent')");
      // hold the write lock for a moment (a synchronous wait: the child is another process)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    });
    resolve();
  });
  assert.equal(await done, 0);
  assert.equal(db.num("SELECT COUNT(*) FROM a"), 6);
  db.close();
});

