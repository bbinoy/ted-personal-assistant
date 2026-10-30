import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spend warnings (budget.ts): nothing is paused for money; the owner's next run gets a fact once per threshold per day.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "spendwarn-test-"));

const { settings } = await import("../src/core/settings.ts");
const B = await import("../src/core/budget.ts");
const { instanceDb } = await import("../src/core/instancedb.ts");
const { owner } = await import("../src/conversation/conversationmodel.ts");
const { heldPosts, resetHeld } = await import("../src/heartbeat/notices.ts");
const T = await import("../src/tenants/tenants.ts");
const { mayRun } = await import("../src/tenants/payer.ts");

const on = settings as unknown as Record<string, number | boolean | string>;
const DAY1 = new Date("2026-03-10T12:00:00Z");
const DAY2 = new Date("2026-03-11T12:00:00Z");
const facts = (): string[] => heldPosts(owner()).map((h) => h.text);

beforeEach(() => {
  on.dailyBudgetUsd = 20;
  on.instanceKeyDailyUsd = 10;
  instanceDb().run("DELETE FROM spend");
  instanceDb().run("DELETE FROM told");
  resetHeld(owner());
  B.recordSpend({ usd: 0.01, conv: "owner", now: new Date("2020-01-01T12:00:00Z") }); // (the first check after a deploy only seeds)
  resetHeld(owner());
});

test("the login: 20 warns once, 22 does not, 25 warns again, the next day starts over", () => {
  B.recordSpend({ usd: 20, conv: "owner", now: DAY1 });
  assert.equal(facts().length, 1);
  assert.match(facts()[0]!, /passed \$20.*Nothing is paused.*\$25/);
  B.recordSpend({ usd: 2, conv: "owner", now: DAY1 });
  assert.equal(facts().length, 1, "22: no new warning");
  B.recordSpend({ usd: 3, conv: "owner", now: DAY1 });
  assert.equal(facts().length, 2);
  assert.match(facts()[1]!, /passed \$25/);
  resetHeld(owner()); // (the same words still waiting would be held once)
  B.recordSpend({ usd: 20, conv: "owner", now: DAY2 });
  assert.equal(facts().length, 1, "a new day warns at 20 again");
  assert.match(facts()[0]!, /passed \$20/);
  assert.equal(B.nextWarning(22, 20), 25);
  assert.equal(B.nextWarning(3, 20), 20);
});

test("a deploy onto an inflated day stays silent once, then warns on the next level", () => {
  instanceDb().run("DELETE FROM told");
  B.recordSpend({ usd: 88, conv: "owner", now: DAY1 });
  assert.deepEqual(facts(), [], "the levels already crossed are recorded silently");
  B.recordSpend({ usd: 1, conv: "owner", now: DAY1 });
  assert.deepEqual(facts(), [], "still the same level");
  B.recordSpend({ usd: 2, conv: "owner", now: DAY1 });
  assert.equal(facts().length, 1);
  assert.match(facts()[0]!, /passed \$90/);
});

test("nothing pauses on the login, and a friend and the key warn the owner by id and amount only, never refusing", () => {
  const rec = T.addTenant({ aci: "00000000-0000-4000-8000-000000000001", name: "Ann" })!;
  T.provision(rec);
  T.setStatus(rec.id, "active");
  const ledger = T.tenantContext(rec).ledger;
  B.recordSpend({ usd: 500, conv: "owner", now: new Date() });
  assert.ok(!("refused" in mayRun({ kind: "owner" }, "brief")), "the owner's background work runs");
  assert.ok(!("refused" in mayRun({ kind: "group", groupId: "g" }, "heartbeat")), "so does a group on the login");
  resetHeld(owner());
  on.tenantApiKey = "k";
  B.recordSpend({ usd: 11, conv: ledger, payer: "key", now: new Date() });
  const told = facts();
  assert.equal(told.length, 2, "the shared key's day and the friend's own day");
  assert.ok(told.some((t) => /shared key.*\$10/.test(t)));
  assert.ok(told.some((t) => t.includes(ledger) && /\$10/.test(t)));
  assert.ok(!told.some((t) => /Ann/.test(t)), "an id, not her name or words");
  assert.ok(!("refused" in mayRun({ kind: "tenant", tenantId: rec.id }, "chat", { chat: true, key: () => "k" })), "she is neither warned nor refused");
  B.recordSpend({ usd: 1, conv: ledger, payer: "key", now: new Date() });
  assert.equal(facts().length, 2, "same level, once");
});
