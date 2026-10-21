import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// instance.db: the spend ledger (budget.ts), the notices (capnotice.ts), the heartbeat looks, the intake marks and the kv rows, in the ONE database the agent and the intake page share.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "instancedb-"));

const { settings } = await import("../src/core/settings.ts");
const { groupConvId, friendConvId, instancePaths } = await import("../src/core/convpaths.ts");
const { instanceDb, kvGet, kvSet, kvDelete, openInstanceDbAt } = await import("../src/core/instancedb.ts");
const B = await import("../src/core/budget.ts");
const N = await import("../src/core/capnotice.ts");
const { localDay } = await import("../src/core/pause.ts");
const I = await import("../src/intake/intakelinks.ts");
const R = await import("../src/heartbeat/rows.ts");
const { dbCheck } = await import("../src/doctor.ts");

const GROUP = "Zm9yLXRoZS1kYi10ZXN0";
const ANNA = friendConvId("anna-1a2b");
const BO = friendConvId("bo-3c4d");
const DAY_MS = 86_400_000;
const reset = () => {
  for (const t of ["spend", "notices", "looks", "intake", "kv"]) instanceDb().run(`DELETE FROM ${t}`);
};

test("the file is instance/instance.db of the data folder, in WAL mode, schema 2, and the doctor's check reads it", () => {
  assert.equal(instanceDb().path, instancePaths().db);
  assert.equal(instanceDb().journalMode, "wal");
  assert.equal(instanceDb().version, 2);
  const lines: [unknown, string, string][] = [];
  assert.equal(dbCheck((ok, what, detail) => void lines.push([ok, what, detail ?? ""])), true);
  assert.equal(lines[0]![0], true);
  assert.match(lines[0]![2], /wal mode, schema 2, integrity_check ok; \d+ spend, \d+ payment, \d+ look row/);
  const broken = mkdtempSync(join(tmpdir(), "instancedb-broken-"));
  const bad: [unknown, string, string][] = [];
  assert.equal(dbCheck((ok, what, detail) => void bad.push([ok, what, detail ?? ""]), join(broken, "nope", "x.db")), true, "a database that does not exist yet is made (a new folder)");
  openInstanceDbAt(join(broken, "nope", "x.db")).close();
});

test("spend: the owner's day is every login run (her chat, background work and the groups); a group's day is its own rows; the key's day is every friend's; a friend's day is hers", () => {
  reset();
  B.recordCost(1.5); // the owner
  B.recordSpend({ usd: 2, conv: groupConvId(GROUP), payer: "login", kind: "chat" });
  B.recordSpend({ usd: 0.25, conv: ANNA, payer: "key", kind: "look" });
  B.recordSpend({ usd: 0.75, conv: BO, payer: "key", kind: "chat" });
  B.recordSpend({ usd: 0.5, conv: ANNA, payer: "key", kind: "dream" });
  assert.equal(B.spentToday(), 3.5, "owner today: login only");
  assert.equal(B.spentToday("owner"), 3.5);
  assert.equal(B.groupSpentToday(GROUP), 2);
  assert.equal(B.spentToday(ANNA), 0.75);
  assert.equal(B.spentToday(BO), 0.75);
  assert.equal(B.keySpentToday(), 1.5, "the key's day: all friends together");
  // the ceilings are those sums against the settings
  const s = settings as unknown as Record<string, number>;
  const was = [s.dailyBudgetUsd, s.groupDailyBudgetUsd, s.instanceKeyDailyUsd];
  try {
    s.dailyBudgetUsd = 3.5;
    s.groupDailyBudgetUsd = 2.01;
    s.instanceKeyDailyUsd = 1.5;
    assert.equal(B.budgetSpent(), true);
    assert.equal(B.groupOverBudget(GROUP), false);
    assert.equal(B.instanceKeyOverBudget(), true);
    assert.equal(B.tenantOverBudget(ANNA, 0.75), true);
    assert.equal(B.tenantOverBudget(ANNA, 0.76), false);
    s.groupDailyBudgetUsd = 2;
    assert.equal(B.groupOverBudget(GROUP), true);
  } finally {
    [s.dailyBudgetUsd, s.groupDailyBudgetUsd, s.instanceKeyDailyUsd] = was as [number, number, number];
  }
  // each row says who, which payer, what kind, which local day
  const row = instanceDb().get<{ day: string; conv: string; payer: string; kind: string; at: number }>("SELECT * FROM spend WHERE kind = 'dream'")!;
  assert.deepEqual([row.day, row.conv, row.payer, row.kind], [localDay(new Date()), ANNA, "key", "dream"]);
  assert.ok(Math.abs(row.at - Date.now()) < 5000);
  // nothing is recorded for a charge that is not money
  B.recordCost(0);
  B.recordCost(-1);
  B.recordCost(Number.NaN);
  assert.equal(instanceDb().num("SELECT COUNT(*) FROM spend"), 5);
});

test("spend: yesterday's rows are not today's; the day is the local one at the moment of the charge", () => {
  reset();
  const yesterday = new Date(Date.now() - DAY_MS);
  B.recordSpend({ usd: 9, now: yesterday });
  B.recordSpend({ usd: 1 });
  assert.equal(B.spentToday(), 1);
  assert.equal(B.spentToday(undefined, yesterday), 9);
  assert.equal(B.pruneSpend(1, new Date()), 0, "a day old is inside a 1-day window");
  assert.equal(B.pruneSpend(1, new Date(Date.now() + 2 * DAY_MS)), 2);
});

test("spend: forgetting a conversation unnames its rows but the owner's and the key's day do not shrink", () => {
  reset();
  B.recordSpend({ usd: 2, conv: groupConvId(GROUP), payer: "login" });
  B.recordSpend({ usd: 1, conv: ANNA, payer: "key" });
  assert.equal(B.forgetSpend(groupConvId(GROUP)), true);
  assert.equal(B.forgetSpend(groupConvId(GROUP)), false, "idempotent");
  assert.equal(B.groupSpentToday(GROUP), 0);
  assert.equal(B.spentToday(), 2, "the owner's day still holds what the group cost");
  B.forgetSpend(ANNA);
  assert.equal(B.spentToday(ANNA), 0);
  assert.equal(B.keySpentToday(), 1, "and the key's day what she cost");
});

test("the budget check is fast: well under a millisecond with a year of rows", () => {
  reset();
  const db = instanceDb();
  const day = localDay(new Date());
  db.tx(() => {
    for (let d = 0; d < 365; d++) for (let i = 0; i < 60; i++) db.run("INSERT INTO spend (at, day, conv, payer, kind, usd) VALUES (?, ?, ?, ?, 'chat', 0.01)", 1, `2025-${String(1 + (d % 12)).padStart(2, "0")}-${String(1 + (d % 28)).padStart(2, "0")}`, i % 5 === 0 ? ANNA : "owner", i % 5 === 0 ? "key" : "login");
  });
  for (let i = 0; i < 50; i++) db.run("INSERT INTO spend (at, day, conv, payer, kind, usd) VALUES (1, ?, 'owner', 'login', 'chat', 0.01)", day);
  B.budgetSpent(); // (the statements are prepared on the first call)
  B.instanceKeyOverBudget();
  B.groupOverBudget(GROUP);
  B.tenantOverBudget(ANNA, 1);
  const N_CALLS = 2000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N_CALLS; i++) B.budgetSpent();
  const owner = Number(process.hrtime.bigint() - t0) / 1e6 / N_CALLS;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < N_CALLS; i++) (B.instanceKeyOverBudget(), B.groupOverBudget(GROUP), B.tenantOverBudget(ANNA, 1));
  const others = Number(process.hrtime.bigint() - t1) / 1e6 / N_CALLS;
  assert.ok(owner < 1, `owner-today check took ${owner.toFixed(3)} ms`);
  assert.ok(others < 1, `key + group + friend checks took ${others.toFixed(3)} ms`);
  assert.equal(B.spentToday(), 0.5);
  // the plans use the covering indexes (no table scan)
  for (const sql of ["SELECT SUM(usd) FROM spend WHERE payer = 'login' AND day = ?", "SELECT SUM(usd) FROM spend WHERE conv = ? AND payer = ? AND day = ?"]) {
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(sql.includes("conv") ? ["x", "key", day] : [day])).map((r) => r.detail).join(" | ");
    assert.match(plan, /USING COVERING INDEX spend_/, plan);
  }
});

test("notices: once a day per key, interval stamps beside them, forgetting by key, clearing by prefix, pruning what means nothing any more", () => {
  reset();
  const now = Date.now();
  assert.equal(N.takeCapNotice("friend:anna", now), true);
  assert.equal(N.takeCapNotice("friend:anna", now), false, "not again today");
  assert.equal(N.capNoticeDue("friend:anna", now + DAY_MS), true, "tomorrow it is due again");
  assert.equal(N.capNoticeDue("friend:bo", now), true, "marking is per key");
  N.markNoticeAt("warn:g1", now);
  N.markNoticeAt("key:refused", now);
  assert.equal(N.lastNoticeAt("warn:g1"), now);
  assert.equal(N.capNoticeDue("warn:g1", now), true, "a stamp is not a day mark");
  N.markCapNotice("warn:g1", now);
  assert.equal(N.lastNoticeAt("warn:g1"), now, "and a day mark leaves the stamp");
  N.clearNoticeAt("key:");
  assert.equal(N.lastNoticeAt("key:refused"), undefined);
  assert.equal(N.lastNoticeAt("warn:g1"), now, "only the prefix");
  assert.equal(N.forgetNotices((k) => k.startsWith("warn:") || k.startsWith("friend:")), 3, "friend:anna's day, warn:g1's day and its stamp");
  assert.equal(N.capNoticeDue("friend:anna", now), true);
  N.markNoticeAt("old", now - 3 * DAY_MS);
  N.markCapNotice("oldday", now - 3 * DAY_MS);
  N.markCapNotice("today", now);
  assert.equal(N.pruneNotices(now), 2, "the old stamp and the old day mark");
  assert.equal(N.capNoticeDue("today", now), false);
});

test("the budget notice is once a day, and OVERBUDGET's first time uses the notices table", () => {
  reset();
  const s = settings as unknown as Record<string, number>;
  const was = s.dailyBudgetUsd;
  try {
    s.dailyBudgetUsd = 1;
    B.recordCost(2);
    assert.deepEqual(B.overBudget(), { over: true, firstTime: true, usd: 2 });
    assert.deepEqual(B.overBudget(), { over: true, firstTime: false, usd: 2 });
    assert.equal(instanceDb().get<{ day: string }>("SELECT day FROM notices WHERE key = ?", B.OWNER_BUDGET_NOTICE)?.day, localDay(new Date()));
  } finally {
    s.dailyBudgetUsd = was;
  }
});

test("looks: appended with the same fields, read oldest first, no words; kv rows hold the tick, the connectors and the tools seen", () => {
  reset();
  const row = (at: string, over: Partial<import("../src/heartbeat/rows.ts").HeartbeatRow> = {}) => ({ at, kind: "owner" as const, night: false, message: true, sent: 1, nextCheckMinutes: 45, costUsd: 0.02, toolCalls: 3, archived: 2, delegations: 0, outcome: "posted" as const, ...over });
  R.appendRow(row("2026-10-14T10:00:00.000Z"));
  R.appendRow(row("2026-10-14T11:00:00.000Z", { kind: "group", outcome: "failed", message: false }));
  const { sent: _unused, ...noSent } = row("2026-10-14T12:00:00.000Z", { kind: "tenant", night: true });
  R.appendRow(noSent);
  const all = R.readRows();
  assert.deepEqual(all.map((r) => [r.at, r.kind, r.night, r.message, r.outcome]), [["2026-10-14T10:00:00.000Z", "owner", false, true, "posted"], ["2026-10-14T11:00:00.000Z", "group", false, false, "failed"], ["2026-10-14T12:00:00.000Z", "tenant", true, true, "posted"]]);
  assert.equal("sent" in all[2]!, false, "a row without `sent` stays without it");
  assert.deepEqual(all[0], row("2026-10-14T10:00:00.000Z"));
  assert.equal(R.lastLookAt(), "2026-10-14T12:00:00.000Z");
  // kv
  assert.deepEqual(kvGet("heartbeat", {}), {});
  kvSet("heartbeat", { lastTickAt: "now" });
  kvSet("heartbeat", { lastTickAt: "later" });
  assert.deepEqual(kvGet("heartbeat", {}), { lastTickAt: "later" });
  kvDelete("heartbeat");
  assert.equal(kvGet("heartbeat", "none"), "none");
  instanceDb().run("INSERT INTO kv (key, value, updated_at) VALUES ('bad', '{not json', 0)");
  assert.equal(kvGet("bad", "fallback"), "fallback", "a value that does not parse is the fallback");
});

test("intake marks: done and needs-reconnect per tenant and purpose, a newer form clears the problem, forgetting a friend drops her rows", () => {
  reset();
  const t0 = new Date("2026-10-14T10:00:00.000Z");
  const t1 = new Date("2026-10-14T11:00:00.000Z");
  const t2 = new Date("2026-10-14T12:00:00.000Z");
  assert.deepEqual(I.connectionState("anna-1a2b", "notion"), { state: "none" });
  I.recordDone("anna-1a2b", "notion", [{ name: "token", chars: 40 }], t0);
  assert.deepEqual(I.connectionState("anna-1a2b", "notion"), { state: "connected", at: t0.toISOString() });
  assert.deepEqual(I.readDone("anna-1a2b", "notion"), { at: t0.toISOString(), stored: [{ name: "token", chars: 40 }] });
  I.markNeedsReconnect("anna-1a2b", "notion", t1);
  assert.deepEqual(I.connectionState("anna-1a2b", "notion"), { state: "reconnect", at: t1.toISOString() });
  I.recordDone("anna-1a2b", "notion", [{ name: "token", chars: 41 }], t2);
  assert.deepEqual(I.connectionState("anna-1a2b", "notion"), { state: "connected", at: t2.toISOString() }, "connecting again is newer than the problem");
  I.markNeedsReconnect("bo-3c4d", "calendar", t1);
  assert.deepEqual(I.connectionState("bo-3c4d", "calendar"), { state: "reconnect", at: t1.toISOString() }, "a problem with no form at all");
  assert.equal(I.readDone("bo-3c4d", "calendar"), undefined);
  assert.equal(I.forgetTenantConnections("anna-1a2b"), true);
  assert.equal(I.forgetTenantConnections("anna-1a2b"), false);
  assert.deepEqual(I.connectionState("anna-1a2b", "notion"), { state: "none" });
  assert.deepEqual(I.connectionState("bo-3c4d", "calendar").state, "reconnect", "another friend's is untouched");
});
