import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Who pays for a model call and may it run now (payer.ts), and the one small-model call that pays them (haiku.ts oneShot): the same answer for the owner, a group and a
// friend, from every job that asks.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "payer-test-"));
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token"; // the instance's own login, which a call on the instance key must never carry

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { INSTANCE_KEY_COOLDOWN, LOGIN, isRefusal, mayRun } = await import("../src/tenants/payer.ts");
const { oneShot } = await import("../src/tenants/haiku.ts");
const { AuthError, InstanceKeyError, RateLimitError, noticeFor } = await import("../src/tenants/errors.ts");
const { coolingDown, noteRateLimit, resetCooldown } = await import("../src/core/cooldown.ts");
const { recordCost, spentToday } = await import("../src/core/budget.ts");
const { keyNotices } = await import("../src/tenants/keynotice.ts");
const { compactConversation } = await import("../src/run/chatsession.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { recentIn } = await import("../src/approvals/recentchat.ts");
const { tenantKey } = await import("../src/core/ownerkey.ts");

const on = settings as unknown as Record<string, unknown>;
const KEY = "instance-key-for-the-payer-tests";
const owner = { kind: "owner" } as const;
const group = { kind: "group" } as const;

let n = 0;
function friend(name: string): import("../src/tenants/tenants.ts").TenantRecord {
  const rec = T.addTenant({ aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
  T.provision(rec);
  T.setStatus(rec.id, "active");
  return T.tenantById(rec.id)!;
}
const her = (rec: { id: string }) => ({ kind: "tenant", tenantId: rec.id }) as const;

beforeEach(() => {
  on.tenants = true;
  resetCooldown();
  keyNotices.reset();
});

test("mayRun: the owner and a group run on the login, held back (unattended) by the pause switch, the shared cooldown and the instance's day budget", () => {
  for (const conv of [owner, group]) {
    assert.deepEqual(mayRun(conv, "t"), LOGIN);
    assert.deepEqual(mayRun(conv, "t", { paused: () => true }), { refused: "paused" });
    assert.deepEqual(mayRun(conv, "t", { spent: () => true }), { refused: "budget" });
    noteRateLimit();
    const cooling = mayRun(conv, "t");
    assert.ok(isRefusal(cooling) && cooling.refused === "cooldown" && cooling.until! > Date.now());
    assert.deepEqual(mayRun(conv, "t", { chat: true, paused: () => true, spent: () => true }), LOGIN, "somebody waiting for an answer is never held back by them");
    resetCooldown();
  }
});

test("mayRun: a friend runs on the instance key and her own ledger; the key's cooldown is every friend's, her budget is her own", () => {
  const anna = friend("Anna");
  const bea = friend("Bea");
  const p = mayRun(her(anna), "t", { key: () => KEY });
  assert.deepEqual(p, { kind: "instance", id: anna.id, apiKey: KEY, costFile: T.tenantContext(anna).costFile });
  // no key: no run, and the owner hears of it once (never the login as a fallback)
  const alerts: string[] = [];
  keyNotices.sendTo((t) => void alerts.push(t));
  assert.deepEqual(mayRun(her(anna), "t", { key: () => undefined }), { refused: "no-key" });
  assert.deepEqual(mayRun(her(bea), "t", { key: () => undefined }), { refused: "no-key" });
  assert.equal(alerts.length, 1);
  // her budget
  recordCost(100, T.tenantContext(anna).costFile);
  assert.deepEqual(mayRun(her(anna), "t", { key: () => KEY }), { refused: "budget", limit: T.tenantContext(anna).dailyBudgetUsd });
  assert.equal((mayRun(her(bea), "t", { key: () => KEY }) as { kind: string }).kind, "instance", "another friend's day is her own");
  // the key's cooldown
  noteRateLimit(Date.now(), INSTANCE_KEY_COOLDOWN);
  for (const rec of [anna, bea]) assert.equal((mayRun(her(rec), "t", { key: () => KEY }) as { refused: string }).refused, "cooldown", "the key is cooling down for every friend");
  assert.ok(!coolingDown(Date.now() + 1000), "the owner's login is not cooling down");
  // paused, suspended
  resetCooldown();
  assert.deepEqual(mayRun(her(bea), "t", { key: () => KEY, paused: () => true }), { refused: "paused" });
  assert.equal((mayRun(her(bea), "t", { key: () => KEY, chat: true, paused: () => true }) as { kind: string }).kind, "instance", "her message is answered whatever the pause switch says");
  T.setStatus(bea.id, "suspended");
  assert.deepEqual(mayRun(her(bea), "t", { key: () => KEY }), { refused: "inactive" });
  assert.deepEqual(mayRun(her(bea), "t", { key: () => KEY, chat: true }), { refused: "inactive" });
});

test("a friend's urgent compaction waits while she is blocked (her day's budget spent): no model call, nothing marked", async () => {
  const anna = friend("Anna2");
  const conv = { ...her(anna), sessionFile: T.tenantContext(anna).sessionFile, source: "group", notesDir: T.tenantContext(anna).notesDir } as const;
  const file = T.tenantContext(anna).sessionFile;
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(T.tenantContext(anna).dir, { recursive: true });
  const stale = JSON.stringify({ sessionId: "s", costUsd: 0, lastContextTokens: 10_000_000, baseTokens: 1, lastTurnAt: new Date().toISOString() });
  writeFileSync(file, stale);
  recordCost(100, T.tenantContext(anna).costFile); // her day is spent
  const err = console.error;
  const log = console.log;
  console.error = console.log = () => {};
  try {
    await compactConversation(conv, "urgent", { key: () => KEY });
    assert.equal(readFileSync(file, "utf8"), stale, "blocked: not even attempted (no failure marker, no model call)");
  } finally {
    console.error = err;
    console.log = log;
  }
});

test("oneShot on the login: the process's environment, the instance ledger, the owner's cooldown; a usage limit is thrown and starts it; a success clears it", async () => {
  const seen: { options?: Record<string, unknown> } = {};
  const query = (a: { options: Record<string, unknown> }) => {
    seen.options = a.options;
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25, result: "hi", structured_output: { ok: 1 } };
    })();
  };
  const before = spentToday();
  const r = await oneShot({ system: "s", prompt: "p", payer: LOGIN, run: query as never, schema: { type: "json_schema", schema: { type: "object" } } });
  assert.deepEqual([r.ok, r.text, r.output], [true, "hi", { ok: 1 }]);
  assert.equal(seen.options!.env, undefined);
  assert.equal(seen.options!.model, "haiku");
  assert.equal(spentToday(), before + 0.25);
  noteRateLimit();
  await oneShot({ system: "s", prompt: "p", payer: LOGIN, run: query as never });
  assert.equal(coolingDown(), false, "a call that went through ends the episode");
  const limited = (() =>
    (async function* () {
      yield { type: "assistant", error: "rate_limit" };
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0 };
    })()) as never;
  await assert.rejects(oneShot({ system: "s", prompt: "p", payer: LOGIN, run: limited }), RateLimitError);
  assert.equal(coolingDown(), true);
  resetCooldown();
  const expired = (() =>
    (async function* () {
      yield { type: "assistant", error: "authentication_failed" };
      yield { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0 };
    })()) as never;
  await assert.rejects(oneShot({ system: "s", prompt: "p", payer: LOGIN, run: expired }), AuthError);
});

test("oneShot on the instance key: her cost file, the key in the environment and no login, a refusal is the key's (every friend's cooldown, one owner notice)", async () => {
  const anna = friend("Anna3");
  const payer = mayRun(her(anna), "t", { key: () => KEY });
  assert.ok(!isRefusal(payer) && payer.kind === "instance");
  const seen: { options?: Record<string, any> } = {};
  const ok = (a: { options: Record<string, any> }) => {
    seen.options = a.options;
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.4, result: "hi" };
    })();
  };
  const before = spentToday();
  await oneShot({ system: "s", prompt: "p", payer, run: ok as never });
  assert.equal(seen.options!.env.ANTHROPIC_API_KEY, KEY);
  assert.equal(seen.options!.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "never the owner's login");
  assert.equal(JSON.parse(readFileSync(T.tenantContext(anna).costFile, "utf8")).usd, 0.4);
  assert.equal(spentToday(), before, "not the instance's own ledger");
  const alerts: string[] = [];
  keyNotices.sendTo((t) => void alerts.push(t));
  const refused = (() =>
    (async function* () {
      yield { type: "assistant", error: "billing_error" };
      yield { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0 };
    })()) as never;
  await assert.rejects(oneShot({ system: "s", prompt: "p", payer, run: refused }), (e) => e instanceof InstanceKeyError && e.why === "billing");
  assert.equal(coolingDown(Date.now() + 1000, INSTANCE_KEY_COOLDOWN), true);
  assert.equal(coolingDown(Date.now() + 1000), false);
  assert.equal(alerts.length, 1);
  const bea = friend("Bea3");
  assert.equal((mayRun(her(bea), "t", { key: () => KEY }) as { refused: string }).refused, "cooldown", "another friend, the same key");
});

test("oneShot: other failures are not ok, not thrown; a hung call times out and its process is closed; an unfinished stream is a failure", async () => {
  const failed = (() => (async function* () { yield { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0 }; })()) as never;
  const r = await oneShot({ system: "s", prompt: "p", payer: LOGIN, run: failed });
  assert.deepEqual([r.ok, r.subtype, r.output], [false, "error_max_turns", undefined]);
  assert.ok(r.error instanceof Error);
  let closed = false;
  const hang = (() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), close: () => void (closed = true) })) as never;
  const t = await oneShot({ system: "s", prompt: "p", payer: LOGIN, run: hang, timeoutMs: 20 });
  assert.deepEqual([t.ok, t.timedOut], [false, true]);
  assert.ok(closed);
  const empty = (() => (async function* () {})()) as never;
  assert.equal((await oneShot({ system: "s", prompt: "p", payer: LOGIN, run: empty })).ok, false);
});

test("notices: one table by what went wrong and who reads it; a friend is told about the account the instance runs on, not about her own key", () => {
  const friendTexts = [new RateLimitError("x"), new InstanceKeyError("limit"), new InstanceKeyError("billing"), new InstanceKeyError("refused"), new Error("x")].map(noticeFor("friend"));
  for (const t of friendTexts) assert.doesNotMatch(t, /your (Anthropic|API)|your own/i);
  assert.match(noticeFor("friend")(new InstanceKeyError("billing")), /no credit left/);
  assert.match(noticeFor("owner")(new AuthError("x")), /claude auth login/);
  assert.match(noticeFor("group")(new AuthError("x")), /needs to fix it/);
  assert.match(noticeFor("owner")(new Error("x")), /Check the logs/);
  assert.doesNotMatch(noticeFor("friend")(new Error("x")), /logs/);
});

test("approval context: a friend's prompt reads her own log, a group none, and nobody reads another's", () => {
  const anna = friend("Anna4");
  const bea = friend("Bea4");
  const at = new Date();
  recordMessage("owner", at.getTime(), "please book the 9 o'clock train", at, T.tenantContext(anna).logFile);
  recordMessage("chat", at.getTime() + 1, "Which day?", at, T.tenantContext(anna).logFile);
  recordMessage("owner", at.getTime() + 2, "Bea's private words", at, T.tenantContext(bea).logFile);
  assert.deepEqual(recentIn(tenantKey(anna.id)), [{ from: "owner", text: "please book the 9 o'clock train" }, { from: "assistant", text: "Which day?" }]);
  assert.deepEqual(recentIn(tenantKey(anna.id), "Which day?"), [{ from: "owner", text: "please book the 9 o'clock train" }, { from: "assistant", text: "Which day?" }], "(only a last line from the person is the message being judged)");
  assert.deepEqual(recentIn("some-group-id-0123456789abcdef"), []);
  assert.deepEqual(recentIn("tenant:nobody"), []);
  assert.ok(!JSON.stringify(recentIn(tenantKey(anna.id))).includes("Bea"));
});
