import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Size-bounded files: the heartbeat rows, the payment ledger (a financial record: archived by year, never deleted), and a log a child holds open.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "rotation-test-"));

const { settings } = await import("../src/core/settings.ts");
const { instancePaths } = await import("../src/core/convpaths.ts");
const { rotateIfOver, copyTruncateIfOver } = await import("../src/core/rotate.ts");
const rows = await import("../src/heartbeat/rows.ts");
const { Ledger, MAX_BYTES: LEDGER_MAX, capProblem } = await import("../src/modules/browse/payments.ts");

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

test("heartbeat rows: rotated by size, and the report still reads every generation in order", () => {
  const file = join(instancePaths().dir, "hb-rotation.jsonl");
  const row = (i: number) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), night: false, message: false, nextCheckMinutes: 30, costUsd: 0, toolCalls: 0, archived: i, delegations: 0, outcome: "silent" as const, pad: "p".repeat(100_000) });
  for (let i = 0; i < 100; i++) rows.appendRow(row(i) as never, file);
  assert.equal(existsSync(`${file}.1`), true);
  assert.equal(existsSync(`${file}.3`), false);
  const read = rows.readRows(file);
  assert.ok(read.length < 100 && read.length >= 20, "the oldest generation was dropped");
  assert.deepEqual(read.map((r) => r.archived), read.map((r) => r.archived).slice().sort((a, b) => a - b), "oldest first across generations");
  assert.equal(read.at(-1)!.archived, 99);
  assert.equal(rows.readRows(`${file}`).length, read.length);
  const current = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(JSON.parse(current.at(-1)!).archived, 99, "the newest row is always in the CURRENT file (rotation happens before the append)");
});

test("payment ledger: rotation archives the year, never deletes, and the caps and the duplicate check give the same answers before and after", () => {
  const file = join(instancePaths().dir, "payments-rot-test.jsonl");
  const l = new Ledger(file);
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const fat = "m".repeat(LEDGER_MAX / 2);
  l.add({ id: "old00001", merchant: `old-${fat}`, totalMinor: 9000, currency: "EUR", last4: "1111", cartHash: "h-old", status: "confirmed" }, days(400));
  l.add({ id: "open0001", merchant: "shop", totalMinor: 700, currency: "EUR", last4: "1111", cartHash: "h-open", status: "clicked" }, days(10));
  const before = (): [number, boolean] => [l.spentToday("EUR", now), !!l.duplicate("shop", "h-today", now)];
  l.add({ id: "today001", merchant: "shop", totalMinor: 2500, currency: "EUR", last4: "1111", cartHash: "h-today", status: "confirmed" }, now);
  assert.deepEqual(before(), [2500, true]);
  const archivesBefore = existsSync(join(instancePaths().dir, `payments-rot-test-2025.jsonl`));
  assert.equal(archivesBefore, false);
  l.add({ id: "pad00001", merchant: `pad-${fat}`, totalMinor: 1, currency: "EUR", last4: "1111", cartHash: "h-pad", status: "failed" }, now); // crosses the size
  const archive = readdirArchive();
  assert.equal(archive.length, 1, "one archive");
  assert.match(archive[0]!, /payments-rot-test-\d{4}\.jsonl$/);
  const archived = readFileSync(join(instancePaths().dir, archive[0]!), "utf8");
  assert.match(archived, /old00001/, "the old payment is kept in the archive");
  assert.deepEqual(before(), [2500, true], "today's cap and the duplicate window read the same after the rotation");
  assert.equal(capProblem(1000, { purchaseMinor: 5000, dayMinor: 3000 } as never, l.spentToday("EUR", now)) !== undefined, true, "the daily cap still counts today's payment");
  assert.equal(l.rows().some((r) => r.id === "old00001"), false, "the current file holds only what the caps can still need");
  assert.equal(l.setStatus("open0001", "unconfirmed", now), true, "an open payment survives the rotation, so its status can still change");
  assert.equal(l.rows().find((r) => r.id === "open0001")?.status, "unconfirmed");
});

function readdirArchive(): string[] {
  return readdirSync(instancePaths().dir).filter((n) => /^payments-rot-test-\d{4}.*\.jsonl$/.test(n));
}

test("/status: the last look is found even when the current rows file is empty (it reads the rotated generations too)", async () => {
  const { lastOwnerLook, ROWS_FILE } = await import("../src/conversation/ownercommands.ts");
  const { readText } = await import("../src/core/state.ts");
  const line = JSON.stringify({ at: "2026-10-14T12:00:00.000Z", night: false, outcome: "silent" });
  writeFileSync(`${ROWS_FILE}.1`, `${line}\n`);
  writeFileSync(ROWS_FILE, "");
  const text = [`${ROWS_FILE}.2`, `${ROWS_FILE}.1`, ROWS_FILE].map((f) => readText(f) ?? "").join("\n");
  assert.deepEqual(lastOwnerLook(text), { at: new Date("2026-10-14T12:00:00.000Z"), outcome: "silent" });
});
