import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The two aggregate ceilings (budget.ts): one group's own day on the owner's login, and all tenants' day together on the instance key. Each has its own refusal reason.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "spendcaps-test-"));

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { charge, isRefusal, LOGIN, loginFor, mayRun } = await import("../src/tenants/payer.ts");
const { spentToday, instanceKeyOverBudget } = await import("../src/core/budget.ts");
const { groupConvId } = await import("../src/core/convpaths.ts");
const { owner, tenant: tenantConv } = await import("../src/conversation/conversationmodel.ts");
const { heldPosts, resetHeld } = await import("../src/heartbeat/notices.ts");
const { refusal } = await import("../src/tenants/errors.ts");
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
  instanceDb().run("DELETE FROM notices");
  resetHeld(owner());
});

test("defaults: the key's day is its own setting; a group and a friend have none of their own", () => {
  assert.equal(typeof settings.instanceKeyDailyUsd, "number");
  assert.equal("groupDailyBudgetUsd" in settings, false);
  assert.equal("tenantDailyBudgetUsd" in settings, false);
});

test("a noisy group has no day of its own: it spends the owner's login day, and background work for everyone stops with that day", () => {
  const noisy = { kind: "group", groupId: "group-noisy" } as const;
  assert.deepEqual(mayRun(noisy, "chat", { chat: true }), loginFor("group-noisy"), "the login, remembered as that group's");
  const before = spentToday();
  charge(loginFor("group-noisy"), 5.5);
  assert.equal(spentToday(groupConvId("group-noisy")), 5.5);
  assert.equal(spentToday() - before, 5.5, "and it is also the owner's day");
  assert.ok(!isRefusal(mayRun(noisy, "chat", { chat: true })), "no ceiling of its own");
  assert.ok(!isRefusal(mayRun(noisy, "heartbeat")), "nor for its look, while the login's day is not spent");
  assert.deepEqual(mayRun(noisy, "heartbeat", { spent: () => true }), { refused: "budget" }, "the login's day spent: its look stops like the owner's");
  assert.deepEqual(mayRun({ kind: "owner" }, "brief", { spent: () => true }), { refused: "budget" });
  assert.deepEqual(mayRun({ kind: "owner" }, "chat", { chat: true, spent: () => true }), LOGIN, "the owner's chat stays available (a group's chat turn is held by group.ts at the same day)");
});

test("charging with no group leaves every group ledger alone", () => {
  const g = spentToday(groupConvId("group-other"));
  charge(LOGIN, 1);
  assert.equal(spentToday(groupConvId("group-other")), g);
});

test("all tenants together stop at INSTANCE_KEY_DAILY_USD, with a reason of its own", () => {
  on.tenantApiKey = KEY;
  on.instanceKeyDailyUsd = 3;
  const ann = friend("Ann");
  const bo = friend("Bo");
  const ctxA = T.tenantContext(ann);
  const ctxB = T.tenantContext(bo);
  assert.ok(!isRefusal(mayRun({ kind: "tenant", tenantId: ann.id }, "chat", { chat: true })));
  charge(inst(ann, ctxA.ledger), 1.2);
  charge(inst(bo, ctxB.ledger), 1.9);
  assert.equal(instanceKeyOverBudget(), true);
  const r = mayRun({ kind: "tenant", tenantId: ann.id }, "chat", { chat: true });
  assert.deepEqual(r, { refused: "instance-budget", limit: 3 });
  assert.deepEqual(mayRun({ kind: "tenant", tenantId: bo.id }, "chat", { chat: true }), { refused: "instance-budget", limit: 3 });
  assert.ok(!isRefusal(mayRun({ kind: "owner" }, "chat", { chat: true })), "the owner's login is another account");
  assert.ok(!isRefusal(mayRun({ kind: "group", groupId: "g" }, "chat", { chat: true })));
  assert.deepEqual(mayRun({ kind: "tenant", tenantId: ann.id }, "chat", { chat: true, keySpent: () => false }), { kind: "instance", id: ann.id, apiKey: KEY, ledger: ctxA.ledger }, "the seam");
});

// ---- who is told, once a day (capnotice.ts) ----

const { createTenantRunner } = await import("../src/conversation/tenantrun.ts");

test("key ceiling: the friend gets one fixed line a day, the owner one fact a day with the limit and no friend's name, both again the next day", async () => {
  on.tenantApiKey = KEY;
  on.instanceKeyDailyUsd = 0.5;
  const ann = friend("Ann-Cap");
  const bo = friend("Bo-Cap");
  charge(inst(ann, T.tenantContext(ann).ledger), 0.6);
  let clock = Date.now();
  const runner = createTenantRunner({ apiKey: () => KEY, now: () => clock, ask: async () => assert.fail("no model call") });
  const say = async (rec: { id: string }) => (await runner.run(tenantConv(rec.id), "hi")).text;
  assert.equal(await say(ann), refusal("shared-budget", "friend"));
  assert.equal(await say(ann), "[[silent]]", "not again today");
  assert.equal(await say(bo), refusal("shared-budget", "friend"), "each friend is told once");
  const told = heldPosts(owner()).map((h) => h.text);
  assert.equal(told.length, 1, "the owner once, however many friends and runs");
  assert.match(told[0]!, /\$0\.5 is reached.*INSTANCE_KEY_DAILY_USD/);
  assert.ok(!/Ann|Bo/.test(told[0]!));
  clock += 25 * 3600_000;
  assert.equal(await say(ann), refusal("shared-budget", "friend"), "the next day");
  assert.equal(heldPosts(owner()).length, 1, "the owner is told again the next day, but the same fact still waiting is held once");
});
