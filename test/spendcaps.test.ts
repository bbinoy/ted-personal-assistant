import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The two payers' days (budget.ts): the login's and the instance key's. Neither is a ceiling: nothing is refused for money.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "spendcaps-test-"));

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { charge, isRefusal, LOGIN, loginFor, mayRun } = await import("../src/tenants/payer.ts");
const { spentToday, keySpentToday } = await import("../src/core/budget.ts");
const { groupConvId } = await import("../src/core/convpaths.ts");
const { owner } = await import("../src/conversation/conversationmodel.ts");
const { resetHeld } = await import("../src/heartbeat/notices.ts");
const { resetCooldown } = await import("../src/core/cooldown.ts");
const { instanceDb } = await import("../src/core/instancedb.ts");

const on = settings as unknown as Record<string, unknown>;
const KEY = "instance-key-for-the-spend-tests";
let n = 0;
function friend(name: string) {
  const rec = T.addTenant({ aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
  T.provision(rec);
  T.setStatus(rec.id, "active");
  return T.tenantById(rec.id)!;
}
const inst = (rec: { id: string }, ledger: string) => ({ kind: "instance", id: rec.id, apiKey: KEY, ledger }) as const;

beforeEach(() => {
  on.tenants = true;
  resetCooldown();
  instanceDb().run("DELETE FROM told");
  resetHeld(owner());
});

test("defaults: the key's day is its own setting; a group and a friend have none of their own", () => {
  assert.equal(typeof settings.instanceKeyDailyUsd, "number");
  assert.equal("groupDailyBudgetUsd" in settings, false);
  assert.equal("tenantDailyBudgetUsd" in settings, false);
});

test("a noisy group has no day of its own: it spends the owner's login day, and nothing pauses on that day", () => {
  const noisy = { kind: "group", groupId: "group-noisy" } as const;
  assert.deepEqual(mayRun(noisy, "chat", { chat: true }), loginFor("group-noisy"), "the login, remembered as that group's");
  const before = spentToday();
  charge(loginFor("group-noisy"), settings.dailyBudgetUsd + 5.5);
  assert.equal(spentToday(groupConvId("group-noisy")), settings.dailyBudgetUsd + 5.5);
  assert.equal(spentToday() - before, settings.dailyBudgetUsd + 5.5, "and it is also the owner's day");
  assert.ok(!isRefusal(mayRun(noisy, "chat", { chat: true })), "no ceiling of its own");
  assert.deepEqual(mayRun(noisy, "heartbeat"), loginFor("group-noisy"), "nor for its look, however much the login spent");
  assert.deepEqual(mayRun({ kind: "owner" }, "brief"), LOGIN);
});

test("charging with no group leaves every group ledger alone", () => {
  const g = spentToday(groupConvId("group-other"));
  charge(LOGIN, 1);
  assert.equal(spentToday(groupConvId("group-other")), g);
});

test("all tenants together past INSTANCE_KEY_DAILY_USD: nobody is refused", () => {
  on.tenantApiKey = KEY;
  on.instanceKeyDailyUsd = 3;
  const ann = friend("Ann");
  const bo = friend("Bo");
  charge(inst(ann, T.tenantContext(ann).ledger), 1.2);
  charge(inst(bo, T.tenantContext(bo).ledger), 1.9);
  assert.ok(keySpentToday() >= 3);
  assert.equal((mayRun({ kind: "tenant", tenantId: ann.id }, "chat", { chat: true }) as { kind: string }).kind, "instance");
  assert.equal((mayRun({ kind: "tenant", tenantId: bo.id }, "heartbeat") as { kind: string }).kind, "instance");
});
