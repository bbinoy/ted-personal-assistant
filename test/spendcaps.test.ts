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
const { groupSpentToday, spentToday, instanceKeyOverBudget } = await import("../src/core/budget.ts");
const { resetCooldown } = await import("../src/core/cooldown.ts");
const { keyNotices } = await import("../src/tenants/keynotice.ts");

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
  keyNotices.reset();
});

test("defaults: a group's day is a quarter of the owner's, the key's day is its own setting", () => {
  assert.equal(settings.groupDailyBudgetUsd, settings.dailyBudgetUsd * 0.25);
  assert.equal(typeof settings.instanceKeyDailyUsd, "number");
});

test("a noisy group is refused at its own ceiling, chat or not, while the owner and other groups still run", () => {
  on.groupDailyBudgetUsd = 5;
  const noisy = { kind: "group", groupId: "group-noisy" } as const;
  const quiet = { kind: "group", groupId: "group-quiet" } as const;
  assert.deepEqual(mayRun(noisy, "chat", { chat: true }), loginFor("group-noisy"), "under its ceiling: the login, remembered as that group's");
  const before = spentToday();
  charge(loginFor("group-noisy"), 4);
  assert.ok(!isRefusal(mayRun(noisy, "chat", { chat: true })));
  charge(loginFor("group-noisy"), 1.5);
  assert.equal(groupSpentToday("group-noisy"), 5.5);
  assert.equal(spentToday() - before, 5.5, "and it is also the owner's day, as before");
  assert.deepEqual(mayRun(noisy, "chat", { chat: true }), { refused: "group-budget", limit: 5 });
  assert.deepEqual(mayRun(noisy, "heartbeat"), { refused: "group-budget", limit: 5 });
  assert.ok(!isRefusal(mayRun(quiet, "chat", { chat: true })), "another group is not held back");
  assert.deepEqual(mayRun({ kind: "owner" }, "chat", { chat: true }), LOGIN, "nor is the owner");
  assert.ok(!isRefusal(mayRun({ kind: "owner" }, "brief")), "nor her brief (the group spent 5.5 of 20)");
});

test("charging with no group leaves every group ledger alone", () => {
  const g = groupSpentToday("group-other");
  charge(LOGIN, 1);
  assert.equal(groupSpentToday("group-other"), g);
});

test("all tenants together stop at INSTANCE_KEY_DAILY_USD even when each is under her own ceiling, with a reason of its own", () => {
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
  assert.ok(ctxA.dailyBudgetUsd > 1.2, "she is far from her own ceiling: it is the aggregate that refused");
  assert.ok(!isRefusal(mayRun({ kind: "owner" }, "chat", { chat: true })), "the owner's login is another account");
  assert.ok(!isRefusal(mayRun({ kind: "group", groupId: "g" }, "chat", { chat: true })));
  assert.deepEqual(mayRun({ kind: "tenant", tenantId: ann.id }, "chat", { chat: true, keySpent: () => false }), { kind: "instance", id: ann.id, apiKey: KEY, ledger: ctxA.ledger }, "the seam");
});

test("her own ceiling is still checked first and keeps its own reason", () => {
  on.tenantApiKey = KEY;
  on.instanceKeyDailyUsd = 1000;
  const cy = friend("Cy");
  const ctx = T.tenantContext(cy);
  charge(inst(cy, ctx.ledger), ctx.dailyBudgetUsd + 0.5);
  assert.deepEqual(mayRun({ kind: "tenant", tenantId: cy.id }, "chat", { chat: true }), { refused: "budget", limit: ctx.dailyBudgetUsd });
});

// ---- who is told, once a day (capnotice.ts) ----

const { createTenantRunner } = await import("../src/conversation/tenantrun.ts");
const { tenant: tenantConv, group: groupConv } = await import("../src/conversation/conversationmodel.ts");
const { capNoticesTo, FRIEND_CAP_TEXT, GROUP_CAP_TEXT, groupCapped, ownerCapText, capNoticeDue } = await import("../src/core/capnotice.ts");
const { FixedNotice, noticeFor } = await import("../src/tenants/errors.ts");

test("key ceiling: the friend gets one fixed line a day, the owner one line a day with the limit and no friend's name, both again the next day", async () => {
  on.tenantApiKey = KEY;
  on.instanceKeyDailyUsd = 0.5;
  const told: string[] = [];
  capNoticesTo((t) => void told.push(t));
  const ann = friend("Ann-Cap");
  const bo = friend("Bo-Cap");
  charge(inst(ann, T.tenantContext(ann).ledger), 0.6);
  let clock = Date.now();
  const runner = createTenantRunner({ apiKey: () => KEY, now: () => clock, ask: async () => assert.fail("no model call") });
  const say = async (rec: { id: string }) => (await runner.run(tenantConv(rec.id), "hi")).text;
  assert.equal(await say(ann), FRIEND_CAP_TEXT);
  assert.equal(await say(ann), "[[silent]]", "not again today");
  assert.equal(await say(bo), FRIEND_CAP_TEXT, "each friend is told once");
  assert.deepEqual(told, [ownerCapText(0.5)], "the owner once, however many friends and runs");
  assert.ok(!/Ann|Bo/.test(told[0]!));
  clock += 25 * 3600_000;
  assert.equal(await say(ann), FRIEND_CAP_TEXT, "the next day");
  assert.equal(told.length, 2);
  capNoticesTo(undefined);
});

test("group ceiling: an addressed message gets one short line a day in the group; an unaddressed one none; a line that could not be posted is tried again", async () => {
  const posted: string[] = [];
  const say = (ok = true) => async () => (ok && posted.push(GROUP_CAP_TEXT), ok);
  assert.equal(await groupCapped(false, true, "g-day", say()), false, "under the ceiling: nothing");
  assert.equal(await groupCapped(true, false, "g-day", say()), true, "over, not addressed: refused, silent");
  assert.equal(posted.length, 0);
  assert.equal(await groupCapped(true, true, "g-day", say(false)), true);
  assert.equal(capNoticeDue("group:g-day"), true, "not delivered, not marked");
  assert.equal(await groupCapped(true, true, "g-day", say()), true);
  assert.equal(await groupCapped(true, true, "g-day", say()), true);
  assert.equal(posted.length, 1, "once");
  assert.equal(await groupCapped(true, true, "g-other", say()), true, "another group has its own");
  assert.equal(posted.length, 2);
  assert.equal(await groupCapped(true, true, "g-day", say(), Date.now() + 25 * 3600_000), true);
  assert.equal(posted.length, 3, "the next day");
});

test("a fixed notice is shown as it is, for any audience", () => {
  assert.equal(noticeFor("group")(new FixedNotice(GROUP_CAP_TEXT)), GROUP_CAP_TEXT);
  assert.equal(groupConv("g").notice(new FixedNotice("x")), "x");
});
