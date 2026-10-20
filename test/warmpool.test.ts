import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick } from "./util.ts";

// The one keyed pool of warm processes (agentwarm.ts WarmPool): the owner's chat, the group that spoke last and the few tenants most recently
// active, all through the same functions. What each kept of the three separate mechanisms it replaced: one process per conversation, built from
// that conversation's own options, handed to nobody else, discarded when what it was built from changes, closed when it is replaced or idle; a
// kind that is full replaces its least recently used one; the instance key is in a tenant's process only.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "warmpool-"));
const INSTANCE_KEY = "sk-" + "ant-api03-INSTANCEINSTANCEINSTANCE";
const OTHER_KEY = "sk-" + "ant-api03-OTHEROTHEROTHEROTHEROTHER";
process.env.ANTHROPIC_API_KEY = "sk-" + "ant-api03-OWNEROWNEROWNEROWNEROWNER";
process.env.TENANT_ANTHROPIC_API_KEY = INSTANCE_KEY;

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { pool, runWarmOrCold, warmUp } = await import("../src/agentwarm.ts");
const { runOptionsFor } = await import("../src/runoptions.ts");
const { chatResume } = await import("../src/chatsession.ts");
const { group, owner, tenant } = await import("../src/conversation/conversation.ts");
const { dropTenantWarm } = await import("../src/agent.ts");
const { userInput } = await import("../src/image.ts");
const { writeJson } = await import("../src/state.ts");

const result = { type: "result", subtype: "success", is_error: false, result: "hi", session_id: "sess-new", total_cost_usd: 0.001 };
const stream = (log: string[], name: string) => (async function* () { log.push(name); yield result; })();
const rig = () => {
  const started: { name: string; options: Record<string, any> }[] = [];
  const used: string[] = [];
  const closed: string[] = [];
  const start = ((o: any) => {
    const name = `warm${started.length + 1}`;
    started.push({ name, options: o.options });
    return Promise.resolve({ query: () => stream(used, name), close: () => void closed.push(name), [Symbol.asyncDispose]: async () => {} });
  }) as any;
  return { started, used, closed, start };
};
const cold = (log: string[]) => () => stream(log, "cold") as any;
let n = 0;
const person = (name: string) => T.redeemInvite(T.mintInvite()!.code, { aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
const withSettings = async (change: Record<string, unknown>, fn: () => Promise<void>) => {
  const was = Object.fromEntries(Object.keys(change).map((k) => [k, (settings as any)[k]]));
  Object.assign(settings, change);
  try {
    await fn();
  } finally {
    Object.assign(settings, was);
  }
};

const inputsOf = (conv: ReturnType<typeof tenant | typeof group | typeof owner>, apiKey = INSTANCE_KEY) => (conv.kind === "tenant" ? { apiKey } : conv.kind === "group" ? { style: "" } : { notify: async () => {} });
const prepare = (conv: any, start: any, apiKey?: string) => warmUp(conv, runOptionsFor(conv, inputsOf(conv, apiKey)), chatResume(conv.sessionFile), start);
const turn = (conv: any, log: string[], apiKey?: string) => {
  const o = runOptionsFor(conv, inputsOf(conv, apiKey));
  return runWarmOrCold(conv, o, chatResume(conv.sessionFile), userInput("p", [], []), cold(log));
};

test("warm pool: one process per kind of room, the owner's untouched by groups and tenants; a full kind replaces its least recently used", async () => {
  await withSettings({ warm: true, tenantWarmMax: 2 }, async () => {
    const r = rig();
    const [a, b, c] = [person("A"), person("B"), person("C")].map((x) => tenant(x.id));
    const g1 = group(`pool-${++n}-aaaaaaaaaaaaaaaa`);
    const g2 = group(`pool-${++n}-bbbbbbbbbbbbbbbb`);
    for (const conv of [owner(), g1, a!, b!]) prepare(conv, r.start);
    await tick();
    assert.deepEqual(pool.holders().sort(), [owner().key, g1.key, a!.key, b!.key].sort());
    prepare(g2, r.start); // another group spoke last: at most one group process
    await tick();
    assert.equal(pool.has(g1), false);
    assert.equal(pool.has(g2), true);
    assert.deepEqual(r.closed, ["warm2"]);
    await turn(a!, []); // a was used (the most recently); b is now the least recently used tenant
    prepare(a!, r.start);
    prepare(c!, r.start); // room for two tenants
    await tick();
    assert.equal(pool.has(b!), false, "the least recently used tenant's process was closed");
    assert.ok(pool.has(a!) && pool.has(c!));
    assert.ok(pool.has(owner()), "the owner's was never in the way of a group or a tenant");
  });
});

test("warm pool: a process serves only its own conversation, once, and is built from that conversation's options", async () => {
  await withSettings({ warm: true, tenantWarmMax: 2 }, async () => {
    const r = rig();
    const a = tenant(person("A").id);
    const b = tenant(person("B").id);
    const g = group(`pool-${++n}-cccccccccccccccc`);
    for (const conv of [owner(), g, a, b]) prepare(conv, r.start);
    await tick();
    const byConv = Object.fromEntries([owner(), g, a, b].map((c, i) => [c.key, r.started[i]!.options]));
    // the instance key is in a tenant's process and in no other; the owner's keeps the process environment
    assert.equal(byConv[a.key]!.env.ANTHROPIC_API_KEY, INSTANCE_KEY);
    assert.equal(byConv[b.key]!.env.ANTHROPIC_API_KEY, INSTANCE_KEY);
    assert.equal(byConv[g.key]!.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY);
    assert.equal(byConv[owner().key]!.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY);
    assert.equal(byConv[a.key]!.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.deepEqual(byConv[g.key]!.settings, { autoMemoryEnabled: true, autoMemoryDirectory: g.notesDir });
    assert.deepEqual(byConv[a.key]!.settings, { autoMemoryEnabled: true, autoMemoryDirectory: a.notesDir });
    // each runs on its own, and once
    const log: string[] = [];
    await turn(b, log);
    await turn(g, log);
    await turn(a, log);
    await turn(a, log);
    assert.deepEqual(r.used, ["warm4", "warm2", "warm3"]);
    assert.deepEqual(log, ["cold"], "a's second turn has no process left: cold");
    assert.ok(pool.has(owner()), "the owner's was not taken by anyone else");
    await turn(owner(), log);
    assert.deepEqual(r.used.at(-1), "warm1");
  });
});

test("warm pool: a process built before something changed is not used: the session, her key", async () => {
  await withSettings({ warm: true, tenantWarmMax: 2 }, async () => {
    const r = rig();
    const a = tenant(person("A").id);
    const b = tenant(person("B").id);
    prepare(a, r.start);
    prepare(b, r.start);
    writeJson(a.sessionFile, { sessionId: "moved-on", costUsd: 0, lastTurnAt: new Date().toISOString() }); // a turn happened meanwhile
    const log: string[] = [];
    await turn(a, log);
    await turn(b, log, OTHER_KEY); // the instance key changed
    assert.deepEqual(log, ["cold", "cold"]);
    assert.deepEqual(r.used, []);
    await tick();
    assert.deepEqual(r.closed.sort(), ["warm1", "warm2"]);
  });
});

test("warm pool: WARM=off and TENANT_WARM_MAX=0 start nothing; dropping a tenant closes hers", async () => {
  const a = tenant(person("A").id);
  await withSettings({ warm: false, tenantWarmMax: 2 }, async () => {
    const r = rig();
    for (const conv of [owner(), group(`pool-${++n}-dddddddddddddddd`), a]) prepare(conv, r.start);
    assert.equal(r.started.length, 0);
  });
  await withSettings({ warm: true, tenantWarmMax: 0 }, async () => {
    const r = rig();
    prepare(a, r.start);
    assert.equal(r.started.length, 0, "no room for tenants");
    prepare(owner(), r.start);
    assert.equal(r.started.length, 1, "the owner's does not depend on it");
    pool.drop(owner().key);
  });
  await withSettings({ warm: true, tenantWarmMax: 2 }, async () => {
    const r = rig();
    prepare(a, r.start);
    await tick();
    assert.deepEqual(pool.holders(), [a.key]);
    dropTenantWarm(a.tenantId!);
    await tick();
    assert.deepEqual(r.closed, ["warm1"]);
    assert.deepEqual(pool.holders(), []);
  });
});

test("warm pool: a renewal wants a process in use, not an idle one", async () => {
  await withSettings({ warm: true }, async () => {
    const r = rig();
    assert.equal(pool.wants(owner()), false);
    prepare(owner(), r.start);
    assert.equal(pool.wants(owner()), true);
    await turn(owner(), []); // used up
    assert.equal(pool.wants(owner()), false);
  });
});

const refreshing = (conv: any, start: any) => warmUp(conv, runOptionsFor(conv, inputsOf(conv)), chatResume(conv.sessionFile), start, true);

test("warm pool: a renewal of an unchanged spare that stays fresh starts nothing; a changed one is rebuilt", async () => {
  await withSettings({ warm: true }, async () => {
    const r = rig();
    pool.drop(owner().key);
    prepare(owner(), r.start);
    await tick();
    refreshing(owner(), r.start);
    refreshing(owner(), r.start);
    await tick();
    assert.equal(r.started.length, 1, "nothing changed: the spare it has is kept");
    assert.deepEqual(r.closed, []);
    writeJson(owner().sessionFile, { sessionId: "moved-on", costUsd: 0, lastTurnAt: new Date().toISOString() }); // a turn happened meanwhile
    refreshing(owner(), r.start);
    await tick();
    assert.equal(r.started.length, 2, "the session moved on: rebuilt");
    assert.deepEqual(r.closed, ["warm1"]);
    pool.drop(owner().key);
  });
});

test("warm pool: a spare that would go stale before the next renewal is renewed (has, with the time it must last)", async () => {
  const { SpareSlot } = await import("../src/warmslot.ts");
  let t = 0;
  const slot = new SpareSlot<{ close(): void }>({ maxAgeMs: 60 * 60_000, now: () => t });
  slot.put("a", "k", Promise.resolve({ close() {} }));
  const next = 25 * 60_000;
  t = 20 * 60_000;
  assert.equal(slot.has("a", "k", next), true, "20 min old: still fresh at the next renewal");
  t = 40 * 60_000;
  assert.equal(slot.has("a", "k", next), false, "40 min old: would be stale at the next renewal: build a new one");
  assert.equal(slot.has("a", "k"), true, "still usable now");
});
