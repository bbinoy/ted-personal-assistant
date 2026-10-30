import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A damaged ledger database: the agent starts DEGRADED instead of exiting into a launchd crash loop. Chat works; everything that spends or pays fails closed; the owner is told; /status says so.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "degraded-"));

const { instancePaths } = await import("../src/core/convpaths.ts");
const { openAtStart, ledgerDamage, DAMAGED_NOTICE, kvGet } = await import("../src/core/instancedb.ts");
const B = await import("../src/core/budget.ts");
const { mayRun, isRefusal } = await import("../src/tenants/payer.ts");
const { statusText } = await import("../src/conversation/ownercommands.ts");
const { openCardAccess } = await import("../src/modules/browse/card.ts");
const { dbCheck } = await import("../src/doctor.ts");

const GARBAGE = "this is not a database. ".repeat(500);

test("a damaged instance.db: the start records it (and leaves the file as it is), nothing throws, and everything that spends or pays is refused", async () => {
  mkdirSync(instancePaths().dir, { recursive: true });
  writeFileSync(instancePaths().db, GARBAGE);
  assert.equal(ledgerDamage(), undefined);
  assert.equal(openAtStart(), false);
  assert.match(ledgerDamage()!, /will NOT start with an empty one/);
  assert.equal(readFileSync(instancePaths().db, "utf8"), GARBAGE, "untouched");
  assert.match(DAMAGED_NOTICE, /My ledger \(instance\/instance\.db\) is damaged, so background work and payments are off\. Your data is untouched; see npm run doctor/);

  // fail closed
  assert.equal(B.spentToday(), Number.POSITIVE_INFINITY);
  assert.doesNotThrow(() => B.recordCost(1));
  assert.equal(kvGet("anything", "fallback"), "fallback");

  // chat works (the owner's turn needs no budget), background work too: the login has no ceiling
  const chat = mayRun({ kind: "owner" }, "chat", { chat: true, paused: () => false });
  assert.equal(isRefusal(chat), false, "the owner's chat goes on");
  assert.equal(isRefusal(mayRun({ kind: "owner" }, "heartbeat look", { paused: () => false })), false, "no ceiling on the login, even unreadable");

  // payments: no card is opened without a ledger
  const problems: string[] = [];
  const fakeStore = { peek: async () => ({ last4: "4242", currency: "CHF" }) } as never;
  assert.equal(await openCardAccess({ store: fakeStore, kill: { off: () => undefined } as never, caps: { purchaseMinor: 5000, dayMinor: 5000 }, onProblem: (r) => void problems.push(r) }), undefined);
  assert.match(problems.join(), /payment ledger.*damaged/);

  // /status and the doctor say it
  assert.match(statusText({ spentUsd: Infinity, limitUsd: 20, approvals: 0, down: [], damaged: true }), /Ledger damaged \(instance\/instance\.db\): background work and payments are off, chat works\. See `npm run doctor`\./);
  const lines: [unknown, string, string][] = [];
  assert.equal(dbCheck((ok, what, detail) => void lines.push([ok, what, detail ?? ""])), false);
  assert.equal(lines[0]![0], false);
  assert.match(lines[0]![2], /is damaged/);
});
