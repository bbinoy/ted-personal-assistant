import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Size-bounded files (a log a child holds open) and the tables that replaced the rotated ones: the heartbeat rows (age-pruned), the payment ledger (a financial record: never rotated or deleted).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "rotation-test-"));

const { settings } = await import("../src/core/settings.ts");
const { scratchDb } = await import("./scratch.ts");
const { rotateIfOver, copyTruncateIfOver } = await import("../src/core/rotate.ts");
const rows = await import("../src/heartbeat/rows.ts");
const { Ledger, capProblem } = await import("../src/modules/browse/payments.ts");

const dir = mkdtempSync(join(tmpdir(), "rot-files-"));

test("rotateIfOver: past the size the file moves to .1, older generations shift and the oldest goes", () => {
  const f = join(dir, "a.log");
  writeFileSync(f, "x".repeat(10));
  assert.equal(rotateIfOver(f, 100, 2), false);
  for (const gen of ["one", "two", "three"]) {
    writeFileSync(f, gen.repeat(50));
    assert.equal(rotateIfOver(f, 100, 2), true);
    assert.equal(existsSync(f), false);
  }
  assert.equal(readFileSync(`${f}.1`, "utf8"), "three".repeat(50));
  assert.equal(readFileSync(`${f}.2`, "utf8"), "two".repeat(50));
  assert.equal(existsSync(`${f}.3`), false, "two generations are kept");
});

test("copyTruncateIfOver: the original is cut to nothing (a child's append-mode fd keeps writing), the copy is .1", () => {
  const f = join(dir, "daemon.log");
  writeFileSync(f, "y".repeat(500));
  assert.equal(copyTruncateIfOver(f, 100, 2), true);
  assert.equal(readFileSync(f, "utf8"), "");
  assert.equal(readFileSync(`${f}.1`, "utf8"), "y".repeat(500));
  assert.equal(copyTruncateIfOver(join(dir, "missing.log"), 100, 2), false);
});

test("heartbeat rows: a table, oldest first, no size rotation; the report window and the age prune read it", () => {
  const base = Date.UTC(2026, 0, 1);
  const row = (i: number) => ({ at: new Date(base + i * 86_400_000).toISOString(), night: false, message: false, nextCheckMinutes: 30, costUsd: 0, toolCalls: 0, archived: i, delegations: 0, outcome: "silent" as const });
  for (let i = 0; i < 100; i++) rows.appendRow(row(i));
  const all = rows.readRows();
  assert.equal(all.length, 100, "nothing is rotated away by size");
  assert.deepEqual(all.map((r) => r.archived), [...all.map((r) => r.archived)].sort((a, b) => a - b), "oldest first");
  assert.equal(all.at(-1)!.archived, 99);
  assert.equal(rows.readRows(7, base + 99.5 * 86_400_000).length, 7, "the last 7 days");
  assert.equal(rows.lastLookAt(), row(99).at);
  assert.equal(rows.pruneLooks(30, base + 99.5 * 86_400_000), 70, "retention drops what is older than the window");
  assert.equal(rows.readRows().length, 30);
});

test("payment ledger: no rotation, nothing is ever deleted by volume, and the caps and the duplicate check read the same however many rows there are", () => {
  const l = new Ledger(scratchDb("payments-rot-test"));
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const fat = "m".repeat(200_000);
  l.add({ id: "old00001", merchant: `old-${fat}`, totalMinor: 9000, currency: "EUR", last4: "1111", cartHash: "h-old", status: "confirmed" }, days(400));
  l.add({ id: "open0001", merchant: "shop", totalMinor: 700, currency: "EUR", last4: "1111", cartHash: "h-open", status: "clicked" }, days(10));
  l.add({ id: "today001", merchant: "shop", totalMinor: 2500, currency: "EUR", last4: "1111", cartHash: "h-today", status: "confirmed" }, now);
  for (let i = 0; i < 300; i++) l.add({ id: `pad${String(i).padStart(5, "0")}`, merchant: `pad-${fat.slice(0, 5000)}`, totalMinor: 1, currency: "EUR", last4: "1111", cartHash: `h-pad-${i}`, status: "failed" }, now);
  assert.deepEqual([l.spentToday("EUR", now), !!l.duplicate("shop", "h-today", now)], [2500, true]);
  assert.equal(capProblem(1000, { purchaseMinor: 5000, dayMinor: 3000 } as never, l.spentToday("EUR", now)) !== undefined, true, "the daily cap still counts today's payment");
  assert.equal(l.rows().some((r) => r.id === "old00001"), true, "the old payment is still a row of the ledger");
  assert.equal(l.history("old00001").length, 1);
  assert.equal(l.setStatus("open0001", "unconfirmed", now), true);
  assert.equal(l.rows().find((r) => r.id === "open0001")?.status, "unconfirmed");
  assert.equal(l.history("open0001").map((r) => r.status).join(), "clicked,unconfirmed", "every status change is a row of its own");
});

test("payment ledger: prunePayments is off unless asked (0 years), never under 2 years, and spares open and unconfirmed payments", async () => {
  const { prunePayments } = await import("../src/modules/browse/payments.ts");
  const { instanceDb } = await import("../src/core/instancedb.ts");
  const l = new Ledger();
  const now = new Date();
  const years = (n: number) => new Date(now.getTime() - n * 365 * 86_400_000);
  const base = { merchant: "m", totalMinor: 100, currency: "EUR", last4: "1111" };
  l.add({ ...base, id: "settled1", cartHash: "a", status: "confirmed" }, years(3));
  l.add({ ...base, id: "unconf01", cartHash: "b", status: "unconfirmed" }, years(3));
  l.add({ ...base, id: "recent01", cartHash: "c", status: "confirmed" }, years(1));
  assert.equal(prunePayments(0, now), 0, "the default keeps everything");
  assert.equal(prunePayments(1, now), 1, "a policy of less than two years is two years: the 3-year-old settled payment goes, the 1-year-old stays");
  const ids = new Set(instanceDb().all<{ id: string }>("SELECT id FROM payments").map((r) => r.id));
  assert.deepEqual([ids.has("settled1"), ids.has("unconf01"), ids.has("recent01")], [false, true, true]);
});
