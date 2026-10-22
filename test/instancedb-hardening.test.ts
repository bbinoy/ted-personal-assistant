import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Review fixes for instance.db: a removed friend leaves nothing in the ledger or the import's backups, a damaged INDEX is found at open, a busy/full database never takes a timer, a look or
// the intake page down, a payment's latest row is by time, and the ledger's rows() show what they used to.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "instancedb-hard-"));

const { friendConvId, layout, dataRoot } = await import("../src/core/convpaths.ts");
const { instanceDb, kvGet, kvSet, openInstanceDbAt } = await import("../src/core/instancedb.ts");
const { openDb, LedgerCorruptError } = await import("../src/core/db.ts");
const B = await import("../src/core/budget.ts");
const N = await import("../src/core/capnotice.ts");
const R = await import("../src/core/looks.ts");
const { removeTenant } = await import("../src/tenants/removal.ts");
const { importItems, importLegacy } = await import("../src/core/dbimport.ts");
const { Ledger } = await import("../src/modules/browse/payments.ts");
const { noteDone } = await import("../src/intake/intakeserver.ts");
const I = await import("../src/intake/intakelinks.ts");

const ANNA = "anna-1a2b";
const BO = "bo-3c4d";

test("removing a friend unnames her spend rows (the totals stay), drops her cost file and her name from the import's backups, and the notes of the import no longer name her folder", async () => {
  const L = layout(dataRoot());
  const conv = friendConvId(ANNA);
  B.recordSpend({ usd: 1, conv, payer: "key" });
  B.recordSpend({ usd: 2, conv: friendConvId(BO), payer: "key" });
  const stamp = join(L.instance.migrationBackup, "2026-10-21T08-00-00-000Z");
  const put = (rel: string, text: string) => (mkdirSync(dirname(join(stamp, rel)), { recursive: true }), writeFileSync(join(stamp, rel), text));
  put(`conversations/${conv}/cost.json`, '{"day":"2026-10-20","usd":1}');
  put(`conversations/${friendConvId(BO)}/cost.json`, '{"day":"2026-10-20","usd":2}');
  put("instance/intake-status.json", JSON.stringify({ [ANNA]: { notion: { at: "x", stored: [] } }, [BO]: { notion: { at: "y", stored: [] } } }));
  put("instance/intake-problems.json", JSON.stringify({ [ANNA]: { notion: "z" } }));
  put("instance/cap-notices.json", JSON.stringify({ day: "2026-10-20", keys: [`friend:${ANNA}`, `friend:${BO}`, "owner:instance"], at: { [`warn:${conv}`]: 1, "warn:owner": 2 } }));
  const db = instanceDb();
  db.run("INSERT INTO legacy_imports (name, sha256, rows, imported_at, backup) VALUES (?, 'a', 1, 'x', ?)", `conversations/${conv}/cost.json`, `instance/migration-backup/x/conversations/${conv}/cost.json`);
  db.run("INSERT INTO legacy_imports (name, sha256, rows, imported_at, backup) VALUES (?, 'b', 1, 'x', 'y')", `conversations/${friendConvId(BO)}/cost.json`);
  const keyBefore = B.keySpentToday();
  const out = await removeTenant(ANNA);
  assert.deepEqual(out!.failed, []);
  assert.ok(out!.removed.some((x) => x.includes("spend rows")));
  assert.equal(B.spentToday(conv), 0, "a friend with the same id, added again today, starts at nothing");
  assert.equal(B.keySpentToday(), keyBefore, "the key's day did not shrink");
  assert.equal(db.num("SELECT COUNT(*) FROM spend WHERE conv = ?", conv), 0, "no row names her");
  assert.equal(B.spentToday(friendConvId(BO)), 2, "another friend is untouched");
  assert.equal(existsSync(join(stamp, "conversations", conv)), false, "her cost file in the backup is gone");
  assert.equal(existsSync(join(stamp, "conversations", friendConvId(BO), "cost.json")), true);
  const all = readdirSync(join(stamp, "instance")).map((f) => readFileSync(join(stamp, "instance", f), "utf8")).join("\n");
  assert.ok(!all.includes(ANNA) && !all.includes(conv), "her id is in none of the backups of the files that named every friend");
  assert.ok(all.includes(BO) && all.includes("owner:instance"), "and theirs still are");
  assert.equal(db.num("SELECT COUNT(*) FROM legacy_imports WHERE name LIKE ? OR backup LIKE ?", `%${conv}%`, `%${conv}%`), 0);
  assert.equal(db.num("SELECT COUNT(*) FROM legacy_imports WHERE name = ?", `conversations/${friendConvId(BO)}/cost.json`), 1);
  assert.deepEqual((await removeTenant(ANNA))!.failed, [], "idempotent");
});

test("a damaged INDEX opens fine and only the integrity check finds it: a ledger database refuses to start, a rebuildable one is rebuilt", () => {
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  const make = (name: string) => {
    const path = join(dir, name);
    const db = openDb(path, { migrations: [{ version: 1, name: "t", up: "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT NOT NULL); CREATE INDEX t_a ON t (a);" }] });
    for (let i = 0; i < 300; i++) db.run("INSERT INTO t (a) VALUES (?)", `MARKER-VALUE-${String(i).padStart(4, "0")}`);
    db.checkpoint();
    db.close();
    // damage the index copy of the values (the last occurrences in the file are the index's pages), the table's own copy is intact
    const bytes = readFileSync(path);
    const at = bytes.lastIndexOf("MARKER-VALUE-0150");
    assert.ok(at > 0);
    bytes.write("MARKER-VALUE-9999", at);
    writeFileSync(path, bytes);
    return path;
  };
  const steps = [{ version: 1, name: "t", up: "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT NOT NULL); CREATE INDEX t_a ON t (a);" }];
  const plain = openDb(make("plain.db"), { migrations: steps });
  assert.match(plain.check(true), /index|row|missing|wrong/i, "the full check sees it");
  plain.close();
  assert.throws(() => openDb(make("ledger.db"), { migrations: steps, verify: true }), (e: unknown) => e instanceof LedgerCorruptError && /integrity_check/.test((e as Error).message));
  const err = console.error;
  console.error = () => {};
  try {
    const rebuilt = openDb(make("cache.db"), { migrations: steps, verify: true, rebuildable: true });
    assert.equal(rebuilt.num("SELECT COUNT(*) FROM t"), 0);
    rebuilt.close();
  } finally {
    console.error = err;
  }
  assert.equal(readdirSync(dir).filter((f) => f.startsWith("cache.db.corrupt-")).length, 1);
});

// ---- a busy, full or damaged database never takes a timer, a look or the intake page down ----

const failing = (): (() => void) => {
  const db = instanceDb() as unknown as Record<string, unknown>;
  const was = { run: db.run, get: db.get, num: db.num, all: db.all, tx: db.tx };
  const boom = () => {
    throw new Error("database is locked");
  };
  Object.assign(db, { run: boom, get: boom, num: boom, all: boom, tx: boom });
  return () => Object.assign(db, was);
};

test("a failing database: the heartbeat tick, a look's record, a charge, a notice and a kv read are logged or answered, never thrown", () => {
  const restore = failing();
  const err = console.error;
  const said: string[] = [];
  console.error = (m: string) => void said.push(m);
  try {
    assert.doesNotThrow(() => kvSet("heartbeat", { lastTickAt: "now" }));
    assert.equal(kvGet("heartbeat", "fallback"), "fallback");
    assert.doesNotThrow(() => R.appendRow({ at: new Date().toISOString(), night: false, message: false, nextCheckMinutes: 30, costUsd: 0, toolCalls: 0, archived: 0, delegations: 0, outcome: "silent" }));
    assert.doesNotThrow(() => B.recordCost(1));
    assert.equal(B.budgetSpent(), true, "fail closed: no reading, no background work");
    assert.equal(B.instanceKeyOverBudget(), true);
    assert.equal(B.tenantOverBudget(friendConvId(BO), 5), true);
    assert.equal(N.takeCapNotice("x"), false);
    assert.equal(N.capNoticeDue("x"), false, "nobody is told twice or told for nothing");
    assert.doesNotThrow(() => (N.markNoticeAt("k"), N.markCapNotice("k"), N.clearNoticeAt("k")));
    assert.deepEqual(I.connectionState(BO, "notion"), { state: "none" });
    assert.doesNotThrow(() => I.markNeedsReconnect(BO, "notion"));
  } finally {
    console.error = err;
    restore();
  }
  assert.ok(said.some((l) => /could not store "heartbeat"/.test(l)) && said.some((l) => /could not record the look/.test(l)) && said.some((l) => /budget: .* failed/.test(l)));
});

test("intake: the secret is stored and the link burnt, then the status cannot be written: the page still says saved (noteDone logs, audits, does not throw)", () => {
  const restore = failing();
  const err = console.error;
  const said: string[] = [];
  console.error = (m: string) => void said.push(m);
  try {
    assert.doesNotThrow(() => noteDone(BO, "notion", [{ name: "token", chars: 3 }]));
  } finally {
    console.error = err;
    restore();
  }
  assert.match(said.join(" "), /saved notion for bo-3c4d, but the status could not be recorded/);
  assert.equal(I.readDone(BO, "notion"), undefined, "nothing was recorded");
  noteDone(BO, "notion", [{ name: "token", chars: 3 }]);
  assert.equal(I.readDone(BO, "notion")?.stored[0]?.chars, 3, "and with a working database it is");
});

test("a look's cost that is not a number is recorded as 0 (and said), not NULL into a NOT NULL column that would drop the record", () => {
  const err = console.error;
  const said: string[] = [];
  console.error = (m: string) => void said.push(m);
  try {
    R.appendRow({ at: "2026-10-21T09:00:00.000Z", night: false, message: false, nextCheckMinutes: 30, costUsd: Number.NaN, toolCalls: 0, archived: 0, delegations: 0, outcome: "failed" });
  } finally {
    console.error = err;
  }
  assert.equal(R.readRows().find((r) => r.at === "2026-10-21T09:00:00.000Z")?.costUsd, 0);
  assert.match(said.join(" "), /a look's cost was NaN/);
});

// ---- the ledger's latest row is by time ----

test("a payment's latest row is the newest by (ts, seq); archives are imported by the earliest row inside each, not by name", () => {
  const root = mkdtempSync(join(tmpdir(), "payorder-"));
  const L = layout(root);
  mkdirSync(L.instance.dir, { recursive: true });
  const row = (id: string, ts: string, status: string) => JSON.stringify({ id, ts, merchant: "m", totalMinor: 100, currency: "EUR", last4: "1", cartHash: id, status });
  // payments-2025-2 is NEWER than payments-2026 although its name sorts first; payment X moves from approved (in 2026) to confirmed (in 2025-2)
  writeFileSync(join(L.instance.dir, "payments-2026.jsonl"), [row("xxxxxxx1", "2026-01-05T10:00:00.000Z", "approved"), row("yyyyyyy1", "2026-01-06T10:00:00.000Z", "confirmed")].join("\n") + "\n");
  writeFileSync(join(L.instance.dir, "payments-2025-2.jsonl"), [row("xxxxxxx1", "2026-03-01T10:00:00.000Z", "clicked"), row("xxxxxxx1", "2026-03-01T10:01:00.000Z", "confirmed")].join("\n") + "\n");
  assert.deepEqual(importItems(root).map((i) => i.name), ["instance/payments-2026.jsonl", "instance/payments-2025-2.jsonl"]);
  // and even imported the wrong way round, the view says confirmed
  const db = openInstanceDbAt(L.instance.db);
  const insert = (id: string, ts: string, status: string) => db.run("INSERT INTO payments (id, ts, merchant, total_minor, currency, last4, cart_hash, status) VALUES (?, ?, 'm', 1, 'EUR', '1', 'c', ?)", id, ts, status);
  insert("zzzzzzz1", "2026-03-01T10:01:00.000Z", "confirmed");
  insert("zzzzzzz1", "2026-01-05T10:00:00.000Z", "approved"); // (a higher seq, an older time)
  const ledger = new Ledger(db);
  assert.equal(ledger.allRows().find((r) => r.id === "zzzzzzz1")?.status, "confirmed");
  importLegacy(root);
  assert.equal(ledger.allRows().find((r) => r.id === "xxxxxxx1")?.status, "confirmed");
  assert.deepEqual(ledger.history("xxxxxxx1").map((r) => r.status), ["approved", "clicked", "confirmed"]);
});

test("Ledger.rows() shows what it showed after a rotation: the last two days and every open or unconfirmed payment; allRows() is the whole ledger", () => {
  const db = openInstanceDbAt(join(mkdtempSync(join(tmpdir(), "rows-")), "x.db"));
  const l = new Ledger(db);
  const now = new Date("2026-10-21T12:00:00.000Z");
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const base = { merchant: "m", totalMinor: 1, currency: "EUR", last4: "1", cartHash: "c" };
  l.add({ ...base, id: "old00001", status: "confirmed" }, ago(30));
  l.add({ ...base, id: "unconf01", status: "unconfirmed" }, ago(30));
  l.add({ ...base, id: "open0001", status: "clicked" }, ago(10));
  l.add({ ...base, id: "recent01", status: "failed" }, ago(1));
  assert.deepEqual(l.rows(now).map((r) => r.id), ["unconf01", "open0001", "recent01"]);
  assert.deepEqual(l.allRows().map((r) => r.id), ["old00001", "unconf01", "open0001", "recent01"]);
});

test("money sums are rounded (no 0.30000000000000004), and an import's `at` is an integer", () => {
  const db = instanceDb();
  db.run("DELETE FROM spend");
  for (const usd of [0.1, 0.2]) B.recordCost(usd);
  assert.equal(B.spentToday(), 0.3);
  assert.equal(db.num("SELECT COUNT(*) FROM spend WHERE at != CAST(at AS INTEGER)"), 0);
});
