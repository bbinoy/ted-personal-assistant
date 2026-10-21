import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { friendConvId, groupConvId, layout, LAYOUT_VERSION } from "../src/core/convpaths.ts";
import { describeImport, hasLegacyFiles, importItems, importLegacy } from "../src/core/dbimport.ts";
import { migrate, readVersion } from "../src/core/migrate.ts";
import { migrateSafely } from "../src/core/migrateservices.ts";
import { openInstanceDbAt } from "../src/core/instancedb.ts";
import { LedgerCorruptError } from "../src/core/db.ts";
import { registerDbRules } from "../src/heartbeat/dbretention.ts";
import { clearRetention, retentionRules } from "../src/core/retention.ts";
import { Ledger } from "../src/modules/browse/payments.ts";

// Layout 3: the small files of layout 2 are imported into instance.db once (core/dbimport.ts), with a backup, and removed.

const DAY = "2026-10-20";
const GA = groupConvId("import-group-a");
const GB = groupConvId("import-group-b");
const pay = (id: string, ts: string, status = "confirmed", totalMinor = 1000) => JSON.stringify({ id, ts, merchant: "shop", totalMinor, currency: "EUR", last4: "4242", cartHash: `h-${id}`, status });
const look = (at: string, extra = {}) => JSON.stringify({ at, kind: "owner", night: false, message: true, sent: 1, nextCheckMinutes: 30, costUsd: 0.5, toolCalls: 2, archived: 1, delegations: 0, outcome: "posted", ...extra });

function layout2Folder(): string {
  const root = mkdtempSync(join(tmpdir(), "dbimport-"));
  const put = (rel: string, text: string) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), text));
  put("instance/layout-version", "2\n");
  put("instance/tenants.json", '{"tenants":[{"id":"anna-1a2b"},{"id":"bo-3c4d"}]}');
  put("instance/registrations.json", "{}");
  // the ledger: two yearly archives (the second year's second archive too), the live file repeats the open and recent rows of the archive
  put("instance/payments-2025.jsonl", [pay("a0000001", "2025-03-01T10:00:00.000Z", "approved"), pay("a0000001", "2025-03-01T10:01:00.000Z", "clicked"), pay("a0000001", "2025-03-01T10:02:00.000Z"), "{torn line"].join("\n") + "\n");
  put("instance/payments-2025-2.jsonl", pay("a0000002", "2025-11-01T10:00:00.000Z", "failed") + "\n");
  put("instance/payments-2026.jsonl", [pay("b0000001", "2026-02-01T10:00:00.000Z"), pay("b0000002", "2026-09-30T10:00:00.000Z", "approved")].join("\n") + "\n");
  put("instance/payments.jsonl", [pay("b0000002", "2026-09-30T10:00:00.000Z", "approved"), pay("b0000002", "2026-09-30T10:05:00.000Z", "clicked"), pay("c0000001", "2026-10-20T08:00:00.000Z")].join("\n") + "\n");
  put("instance/heartbeat.jsonl.2", look("2026-10-18T10:00:00.000Z") + "\n");
  put("instance/heartbeat.jsonl.1", look("2026-10-19T10:00:00.000Z", { kind: "group", sent: undefined }) + "\n");
  put("instance/heartbeat.jsonl", [look("2026-10-20T10:00:00.000Z"), "not json", look("2026-10-20T11:00:00.000Z", { outcome: "silent", message: false })].join("\n") + "\n");
  put("instance/heartbeat.json", '{"lastTickAt":"2026-10-20T11:00:00.000Z"}');
  put("instance/connectors.json", '{"at":"2026-10-20T11:00:00.000Z","notion":false,"calendar":true}');
  put("instance/tools-seen.json", '["mcp__notion__x"]');
  put("instance/cost.json", JSON.stringify({ day: DAY, usd: 6, notifiedDay: DAY }));
  put("instance/group-cost.json", JSON.stringify({ day: DAY, usd: { [GA]: 1.5, [GB]: 0.5 } }));
  put("instance/key-cost.json", JSON.stringify({ day: DAY, usd: 1 }));
  put("conversations/friend-anna-1a2b/cost.json", JSON.stringify({ day: DAY, usd: 0.4 }));
  put("conversations/friend-bo-3c4d/cost.json", JSON.stringify({ day: DAY, usd: 0.3 }));
  put("instance/cap-notices.json", JSON.stringify({ day: DAY, keys: ["owner:instance", `group:${GA}`], at: { "warn:owner": 1_700_000_000_000 } }));
  put("instance/intake-status.json", JSON.stringify({ "anna-1a2b": { notion: { at: "2026-10-01T10:00:00.000Z", stored: [{ name: "token", chars: 40 }] } } }));
  put("instance/intake-problems.json", JSON.stringify({ "anna-1a2b": { notion: "2026-10-10T10:00:00.000Z" }, "bo-3c4d": { calendar: "2026-10-11T10:00:00.000Z" } }));
  return root;
}
const bytesOf = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");
const FILES = ["instance/payments-2025.jsonl", "instance/payments-2025-2.jsonl", "instance/payments-2026.jsonl", "instance/payments.jsonl", "instance/heartbeat.jsonl.2", "instance/heartbeat.jsonl.1", "instance/heartbeat.jsonl",
  "instance/heartbeat.json", "instance/connectors.json", "instance/tools-seen.json", "instance/cost.json", "instance/group-cost.json", "instance/key-cost.json", "conversations/friend-anna-1a2b/cost.json",
  "conversations/friend-bo-3c4d/cost.json", "instance/cap-notices.json", "instance/intake-status.json", "instance/intake-problems.json"];

test("the plan: every layout-2 file that is there, the ledgers' archives in year order, the friends' days before the totals they split; the dry run lists them", () => {
  const root = layout2Folder();
  const items = importItems(root).map((i) => i.name);
  assert.deepEqual(items.slice(0, 4), ["instance/payments-2025.jsonl", "instance/payments-2025-2.jsonl", "instance/payments-2026.jsonl", "instance/payments.jsonl"]);
  assert.deepEqual(items.slice(4, 7), ["instance/heartbeat.jsonl.2", "instance/heartbeat.jsonl.1", "instance/heartbeat.jsonl"]);
  assert.ok(items.indexOf("conversations/friend-anna-1a2b/cost.json") < items.indexOf("instance/key-cost.json") && items.indexOf("instance/group-cost.json") < items.indexOf("instance/cost.json"));
  assert.deepEqual([...items].sort(), [...FILES].sort(), "and nothing else (tenants.json and registrations.json stay files)");
  const lines = describeImport(root);
  assert.equal(lines.length, FILES.length + 1);
  assert.match(lines.at(-1)!, /18 file\(s\) to import/);
  assert.equal(hasLegacyFiles(root), true);
  assert.deepEqual(describeImport(mkdtempSync(join(tmpdir(), "dbimport-empty-"))), []);
});

test("migrate from layout 2: every file imported in one transaction, counts verified, originals copied to migration-backup/<time>/ and removed, version 3 last", () => {
  const root = layout2Folder();
  const before = Object.fromEntries(FILES.map((f) => [f, bytesOf(root, f)]));
  const L = layout(root);
  const log: string[] = [];
  const r = migrate(root, { log: (l) => log.push(l), now: () => new Date("2026-10-21T08:00:00.000Z") });
  assert.equal(r.already, false);
  assert.equal(readVersion(root), LAYOUT_VERSION);
  for (const f of FILES) assert.equal(existsSync(join(root, f)), false, `${f} is imported and removed`);
  assert.equal(existsSync(join(root, "instance/tenants.json")), true, "the registry stays a file");
  assert.equal(existsSync(join(root, "instance/registrations.json")), true);
  const backup = join(L.instance.migrationBackup, "2026-10-21T08-00-00-000Z");
  for (const f of FILES) assert.equal(readFileSync(join(backup, f), "utf8"), before[f], `${f} is in the backup, byte for byte`);
  assert.ok(log.some((l) => /18 file\(s\) imported into instance\/instance\.db/.test(l)));
  const db = openInstanceDbAt(L.instance.db);

  // payments: every historical row, the live file's repeats once; a torn line is not a row
  const pays = db.all<{ id: string; status: string }>("SELECT id, status FROM payments ORDER BY seq").map((p) => `${p.id}:${p.status}`);
  assert.deepEqual(pays, ["a0000001:approved", "a0000001:clicked", "a0000001:confirmed", "a0000002:failed", "b0000001:confirmed", "b0000002:approved", "b0000002:clicked", "c0000001:confirmed"]);
  const ledger = new Ledger(db);
  assert.deepEqual(ledger.rows().map((p) => `${p.id}:${p.status}`), ["a0000001:confirmed", "a0000002:failed", "b0000001:confirmed", "b0000002:clicked", "c0000001:confirmed"], "latest status per payment, oldest payment first");
  assert.equal(ledger.recover(new Date("2026-10-21T09:00:00.000Z")), 1, "the open payment is recovered as before");
  assert.equal(ledger.history("a0000001").length, 3);

  // looks: 4 valid rows in generation order, the junk line skipped
  assert.deepEqual(db.all<{ at: string; kind: string; sent: number | null }>("SELECT at, kind, sent FROM looks ORDER BY id").map((r) => ({ ...r })), [
    { at: "2026-10-18T10:00:00.000Z", kind: "owner", sent: 1 }, { at: "2026-10-19T10:00:00.000Z", kind: "group", sent: null }, { at: "2026-10-20T10:00:00.000Z", kind: "owner", sent: 1 }, { at: "2026-10-20T11:00:00.000Z", kind: "owner", sent: 1 },
  ]);

  // spend: the day's totals read as before (owner 6, key 1), split into the finer rows
  const sum = (sql: string, ...p: string[]) => Math.round(db.num(sql, ...p) * 1e6) / 1e6;
  assert.equal(sum("SELECT SUM(usd) FROM spend WHERE payer = 'login' AND day = ?", DAY), 6, "owner today = cost.json");
  assert.equal(sum("SELECT SUM(usd) FROM spend WHERE conv = ? AND payer = 'login'", GA), 1.5);
  assert.equal(sum("SELECT SUM(usd) FROM spend WHERE conv = 'owner' AND payer = 'login'"), 4, "the owner's own part: the total minus the groups");
  assert.equal(sum("SELECT SUM(usd) FROM spend WHERE payer = 'key' AND day = ?", DAY), 1, "key today = key-cost.json");
  assert.equal(sum("SELECT SUM(usd) FROM spend WHERE conv = ?", friendConvId("anna-1a2b")), 0.4);
  assert.equal(sum("SELECT SUM(usd) FROM spend WHERE conv = ''  AND payer = 'key'"), 0.3, "what no friend's file explains is unnamed, still counted");

  // notices, kv, intake
  assert.equal(db.get<{ day: string }>("SELECT day FROM notices WHERE key = 'budget:owner'")?.day, DAY, "cost.json's notifiedDay");
  assert.deepEqual(db.all<{ key: string }>("SELECT key FROM notices WHERE day = ? ORDER BY key", DAY).map((n) => n.key), ["budget:owner", `group:${GA}`, "owner:instance"]);
  assert.equal(db.get<{ last_at: number }>("SELECT last_at FROM notices WHERE key = 'warn:owner'")?.last_at, 1_700_000_000_000);
  assert.deepEqual(JSON.parse(db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'heartbeat'")!.value), { lastTickAt: "2026-10-20T11:00:00.000Z" });
  assert.equal(JSON.parse(db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'connectors'")!.value).notion, false);
  assert.deepEqual(JSON.parse(db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'tools-seen'")!.value), ["mcp__notion__x"]);
  assert.deepEqual(db.all("SELECT tenant, purpose, done_at, problem_at FROM intake ORDER BY tenant").map((r) => ({ ...r })), [
    { tenant: "anna-1a2b", purpose: "notion", done_at: "2026-10-01T10:00:00.000Z", problem_at: "2026-10-10T10:00:00.000Z" }, { tenant: "bo-3c4d", purpose: "calendar", done_at: null, problem_at: "2026-10-11T10:00:00.000Z" },
  ]);
  // one note per file
  assert.equal(db.num("SELECT COUNT(*) FROM legacy_imports"), 18);
  assert.equal(db.num("SELECT rows FROM legacy_imports WHERE name = 'instance/payments.jsonl'"), 2, "of its 3 lines, 1 repeats the archive's open payment");
});

test("idempotent: a second migrate, a start, and the importer itself change nothing and import nothing twice", () => {
  const root = layout2Folder();
  migrate(root);
  const db = openInstanceDbAt(layout(root).instance.db);
  const counts = () => ["spend", "payments", "looks", "notices", "kv", "intake", "legacy_imports"].map((t) => db.num(`SELECT COUNT(*) FROM ${t}`));
  const first = counts();
  assert.equal(migrate(root).already, true);
  assert.equal(migrateSafely(root, { agentLabel: "x", mode: "agent", services: { running: () => false, stop: () => {}, start: () => {}, agentPids: () => [] } }).already, true);
  assert.deepEqual(importLegacy(root), { files: 0, skipped: 0, rows: 0 });
  assert.deepEqual(counts(), first);
});

test("the same file put back (a crash after the commit, before the removal) is not imported again: only the leftover is removed", () => {
  const root = layout2Folder();
  const L = layout(root);
  mkdirSync(L.instance.dir, { recursive: true });
  assert.throws(() => importLegacy(root, { crashAfterCommit: 1 }), /simulated crash/);
  const db = openInstanceDbAt(L.instance.db);
  assert.equal(db.num("SELECT COUNT(*) FROM legacy_imports"), 1, "the first file is committed");
  assert.equal(existsSync(join(root, "instance/payments-2025.jsonl")), true, "its original was not yet removed");
  const rows = db.num("SELECT COUNT(*) FROM payments");
  const r = importLegacy(root);
  assert.equal(r.skipped, 1);
  assert.equal(r.files, 17);
  assert.equal(existsSync(join(root, "instance/payments-2025.jsonl")), false);
  assert.equal(db.num("SELECT COUNT(*) FROM payments") - rows, 5, "the rest of the ledger, nothing of the first file twice");
  assert.equal(db.num("SELECT COUNT(*) FROM legacy_imports"), 18);
});

test("crash anywhere, resume: after a crash at every file the finished result is the same as an uninterrupted run", () => {
  const snapshotOf = (root: string) => {
    const db = openInstanceDbAt(layout(root).instance.db);
    return JSON.stringify(["SELECT id, ts, status FROM payments ORDER BY seq", "SELECT at, kind FROM looks ORDER BY id", "SELECT day, conv, payer, ROUND(usd, 6) AS usd FROM spend ORDER BY day, conv, payer, usd", "SELECT key, day, last_at FROM notices ORDER BY key", "SELECT key, value FROM kv ORDER BY key", "SELECT * FROM intake ORDER BY tenant, purpose"].map((q) => db.all(q)));
  };
  const whole = layout2Folder();
  migrate(whole);
  const expected = snapshotOf(whole);
  for (const k of [1, 2, 5, 9, 13, 17]) {
    const root = layout2Folder();
    assert.throws(() => importLegacy(root, { crashAfter: k }), /simulated crash/, `crash after ${k}`);
    assert.equal(readVersion(root), 2, "not stamped 3 yet");
    assert.equal(migrateSafely(root, { agentLabel: "x", mode: "agent", services: { running: () => false, stop: () => {}, start: () => {}, agentPids: () => [] } }).already, false);
    assert.equal(readVersion(root), LAYOUT_VERSION);
    assert.equal(snapshotOf(root), expected, `resumed after ${k}`);
    assert.equal(hasLegacyFiles(root), false);
  }
});

test("a file that does not parse is backed up and noted with 0 rows (the old reader moved it aside and used defaults); the rest still imports", () => {
  const root = layout2Folder();
  writeFileSync(join(root, "instance/cost.json"), "{broken");
  writeFileSync(join(root, "instance/connectors.json"), '"a string"');
  migrate(root);
  const db = openInstanceDbAt(layout(root).instance.db);
  assert.equal(db.num("SELECT rows FROM legacy_imports WHERE name = 'instance/cost.json'"), 0);
  assert.equal(readFileSync(join(layout(root).instance.migrationBackup, readdirSync(layout(root).instance.migrationBackup)[0]!, "instance/cost.json"), "utf8"), "{broken");
  assert.equal(db.get("SELECT 1 FROM kv WHERE key = 'connectors'"), undefined);
  assert.equal(db.num("SELECT COUNT(*) FROM payments"), 8);
  assert.equal(readVersion(root), LAYOUT_VERSION);
});

test("a damaged instance.db stops the migration before anything is imported or removed: the ledgers are never started empty", () => {
  const root = layout2Folder();
  const L = layout(root);
  writeFileSync(L.instance.db, "this is not a database. ".repeat(500));
  assert.throws(() => migrate(root), LedgerCorruptError);
  assert.equal(readVersion(root), 2);
  for (const f of FILES) assert.equal(existsSync(join(root, f)), true, `${f} is where it was`);
  assert.equal(readFileSync(L.instance.db, "utf8").startsWith("this is not a database."), true, "and the damaged file untouched");
});

test("a late file of an old version (same name, other bytes) is imported as new; a re-run of the same bytes is not", () => {
  const root = layout2Folder();
  migrate(root);
  const L = layout(root);
  const db = openInstanceDbAt(L.instance.db);
  const before = db.num("SELECT COUNT(*) FROM looks");
  writeFileSync(join(L.instance.dir, "heartbeat.jsonl"), look("2026-10-22T10:00:00.000Z") + "\n");
  migrate(root);
  assert.equal(db.num("SELECT COUNT(*) FROM looks"), before + 1);
  assert.equal(existsSync(join(L.instance.dir, "heartbeat.jsonl")), false);
});

test("retention rules for the tables: looks, spend and notices are pruned by age, a dry run only counts, and payments are kept unless PAYMENTS_KEEP_YEARS is set (and then never under two years, never an open payment)", async () => {
  const { settings } = await import("../src/core/settings.ts");
  const { instanceDb } = await import("../src/core/instancedb.ts");
  const { recordSpend } = await import("../src/core/budget.ts");
  const { appendRow } = await import("../src/heartbeat/rows.ts");
  const { markCapNotice } = await import("../src/core/capnotice.ts");
  const db = instanceDb();
  for (const t of ["spend", "looks", "notices", "payments"]) db.run(`DELETE FROM ${t}`);
  const now = new Date("2026-10-21T12:00:00.000Z");
  const old = new Date(now.getTime() - 500 * 86_400_000);
  recordSpend({ usd: 1, now: old });
  recordSpend({ usd: 1, now });
  const row = (at: Date) => ({ at: at.toISOString(), night: false, message: false, nextCheckMinutes: 30, costUsd: 0, toolCalls: 0, archived: 0, delegations: 0, outcome: "silent" as const });
  appendRow(row(old));
  appendRow(row(now));
  markCapNotice("old-day", old.getTime());
  markCapNotice("today", now.getTime());
  const l = new Ledger();
  const base = { merchant: "m", totalMinor: 1, currency: "EUR", last4: "1", cartHash: "c" };
  l.add({ ...base, id: "settled1", status: "confirmed" }, new Date(now.getTime() - 3 * 365 * 86_400_000));
  l.add({ ...base, id: "unconf01", status: "unconfirmed" }, new Date(now.getTime() - 3 * 365 * 86_400_000));
  clearRetention();
  registerDbRules();
  const rules = Object.fromEntries(retentionRules().map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(rules).sort(), ["db-looks", "db-notices", "db-payments", "db-spend"]);
  const counts = () => ["spend", "looks", "notices", "payments"].map((t) => db.num(`SELECT COUNT(*) FROM ${t}`));
  assert.deepEqual(counts(), [2, 2, 2, 2]);
  for (const r of Object.values(rules)) r.run(now, { dryRun: true });
  assert.deepEqual(counts(), [2, 2, 2, 2], "a dry run removes nothing");
  assert.equal(rules["db-looks"]!.run(now, { dryRun: true }).removed, 1);
  assert.equal(rules["db-spend"]!.run(now, { dryRun: true }).removed, 1);
  assert.equal(rules["db-payments"]!.run(now, { dryRun: true }).removed, 0, "kept for ever by default");
  for (const r of Object.values(rules)) r.run(now, { dryRun: false });
  assert.deepEqual(counts(), [1, 1, 1, 2], "old looks, spend and notices went; every payment stayed");
  assert.equal(settings.paymentsKeepYears, 0);
  const s = settings as unknown as Record<string, number>;
  try {
    s.paymentsKeepYears = 1;
    assert.equal(rules["db-payments"]!.run(now, { dryRun: true }).removed, 1);
    assert.equal(rules["db-payments"]!.run(now, { dryRun: false }).removed, 1);
  } finally {
    s.paymentsKeepYears = 0;
  }
  assert.deepEqual(db.all<{ id: string }>("SELECT id FROM payments").map((p) => p.id), ["unconf01"], "the settled one only; an unconfirmed payment is never pruned");
});
