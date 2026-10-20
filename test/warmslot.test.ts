import { test } from "node:test";
import assert from "node:assert/strict";
import { tick } from "./util.ts";
import { firstWarm, SpareSlot } from "../src/warmslot.ts";
import { askGateWith, prepareGate } from "../src/gate.ts";
import { groupCapabilities } from "../src/policy/capabilities.ts";
import { skillsFor } from "../src/skills.ts";
import { prepare, runConversation } from "../src/agent.ts";
import { group, owner } from "../src/conversation.ts";
import { createGroupBrain } from "../src/group.ts";
import { loadSettings, settings } from "../src/settings.ts";
import { writeJson } from "../src/state.ts";

const T0 = new Date(2026, 9, 14, 9, 0, 0);

// ---- the slot ----

const fakeWarm = (name: string, closed: string[]) => Promise.resolve({ name, close: () => void closed.push(name) });

test("warm slot: holds one process; a replacement closes the old one", async () => {
  const closed: string[] = [];
  const slot = new SpareSlot<{ name: string; close(): void }>({ maxAgeMs: 1000 });
  slot.put("a", "k1", fakeWarm("A", closed));
  assert.equal(slot.holder, "a");
  slot.put("b", "k2", fakeWarm("B", closed)); // another group became the latest
  await tick();
  assert.deepEqual(closed, ["A"]);
  assert.equal(slot.holder, "b");
  assert.equal(slot.has("a"), false);
  assert.equal(slot.has("b"), true);
});

test("warm slot: handed out only to the same conversation with the same key, once", async () => {
  const closed: string[] = [];
  const slot = new SpareSlot<{ name: string; close(): void }>({ maxAgeMs: 1000 });
  slot.put("a", "k1", fakeWarm("A", closed));
  assert.equal(slot.take("b", "k1"), undefined); // never shared with another conversation...
  assert.equal(slot.holder, "a"); // ...and not disturbed by it
  assert.equal(slot.take("a", "other-key"), undefined); // state moved on: a stale process is closed, not used
  await tick();
  assert.deepEqual(closed, ["A"]);
  assert.equal(slot.holder, undefined);
  slot.put("a", "k2", fakeWarm("A2", closed));
  assert.equal((await slot.take("a", "k2"))?.name, "A2");
  assert.equal(slot.take("a", "k2"), undefined); // serves one query
  assert.deepEqual(closed, ["A"]); // taken, so not closed by the slot
});

test("warm slot: too old is not used, a failed start empties the slot, idle drops it and activity restarts the wait", async () => {
  let t = 0;
  const closed: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const slot = new SpareSlot<{ name: string; close(): void }>({
    maxAgeMs: 1000,
    idleMs: () => 600,
    now: () => t,
    schedule: (fn, ms) => {
      const x = { fn, ms, live: true };
      timers.push(x);
      return () => void (x.live = false);
    },
  });
  slot.put("a", "k", fakeWarm("A", closed));
  t = 1500;
  assert.equal(slot.has("a"), false);
  assert.equal(slot.take("a", "k"), undefined);
  await tick();
  assert.deepEqual(closed, ["A"]);

  t = 0;
  slot.put("a", "k", Promise.reject(new Error("no start")));
  await tick();
  assert.equal(slot.holder, undefined);

  slot.put("a", "k", fakeWarm("B", closed));
  assert.equal(timers.filter((x) => x.live).length, 1);
  slot.touch("a"); // the group is still talking: the old timer is cancelled and a new one runs
  assert.equal(timers.filter((x) => x.live).length, 1);
  slot.touch("zzz");
  assert.equal(timers.filter((x) => x.live).length, 1);
  timers.find((x) => x.live)!.fn(); // idle period over
  await tick();
  assert.equal(slot.holder, undefined);
  assert.deepEqual(closed, ["A", "B"]);
});

// ---- groups in agent.ts ----

const result = { type: "result", subtype: "success", is_error: false, result: "hi", session_id: "sess-new", total_cost_usd: 0.001 };
const stream = (log: string[], name: string) => (async function* () { log.push(name); yield result; })();
const warmFor = (name: string, used: string[], closed: string[]) => ({ query: () => stream(used, name), close: () => void closed.push(name), [Symbol.asyncDispose]: async () => {} });
const startRig = () => {
  const started: any[] = [];
  const used: string[] = [];
  const closed: string[] = [];
  const start = ((o: any) => (started.push(o.options), Promise.resolve(warmFor(`warm${started.length}`, used, closed)))) as any;
  return { started, used, closed, start };
};
const coldQuery = (log: string[]) => (() => stream(log, "cold")) as any;
const build = () => ({ prompt: "p" });
let n = 0;
const gid = () => `warm-${++n}-0123456789abcdef`;

test("group warm: built from that group's own options only, exactly like a normal group run", () => {
  const was = settings.warm;
  (settings as { warm: boolean }).warm = true;
  try {
    const rig = startRig();
    const conv = group(gid());
    prepare(conv, { style: "- be warm" }, { start: rig.start, keep: true });
    assert.equal(rig.started.length, 1);
    const o = rig.started[0];
    assert.deepEqual(o.settings, { autoMemoryEnabled: true, autoMemoryDirectory: conv.notesDir });
    assert.notEqual(conv.notesDir, owner().notesDir);
    assert.deepEqual([o.settingSources, o.strictMcpConfig, o.plugins, o.skills, Object.keys(o.mcpServers ?? {})], [[], true, [{ type: "local", path: settings.pluginDir, skipMcpDiscovery: true }], skillsFor(groupCapabilities()), ["send", "weather", "draw", "voice", "memory", "browse"]]);
    assert.deepEqual(o.tools, ["Skill", "Read", "Write", "Edit", "WebSearch"]);
    assert.match(JSON.stringify(o.systemPrompt), /be warm/);
  } finally {
    (settings as { warm: boolean }).warm = was;
  }
});

test("group warm: one process for the latest group; another group replaces it; each group only ever gets its own", async () => {
  const was = settings.warm;
  (settings as { warm: boolean }).warm = true;
  try {
    const rig = startRig();
    const a = group(gid());
    const b = group(gid());
    prepare(a, { style: "" }, { start: rig.start, keep: true });
    prepare(a, { style: "" }, { start: rig.start, keep: true }); // already warm for a: nothing new started
    assert.equal(rig.started.length, 1);
    prepare(b, { style: "" }, { start: rig.start, keep: true }); // b spoke last
    await tick();
    assert.equal(rig.started.length, 2);
    assert.deepEqual(rig.closed, ["warm1"]); // a's was dropped: at most one group process
    // a runs cold (its warm process is gone) and never on b's process
    const log: string[] = [];
    await runConversation(a, { style: "" }, build, undefined, { query: coldQuery(log) });
    assert.deepEqual(log, ["cold"]);
    assert.deepEqual(rig.used, []);
    // b uses its own
    await runConversation(b, { style: "" }, build, undefined, { query: coldQuery(log) });
    assert.deepEqual(rig.used, ["warm2"]);
    assert.deepEqual(log, ["cold"]);
  } finally {
    (settings as { warm: boolean }).warm = was;
  }
});

test("group warm: a process built before the session moved on is not used", async () => {
  const was = settings.warm;
  (settings as { warm: boolean }).warm = true;
  try {
    const rig = startRig();
    const conv = group(gid());
    prepare(conv, { style: "" }, { start: rig.start, keep: true });
    writeJson(conv.sessionFile, { sessionId: "moved-on", costUsd: 0, lastTurnAt: new Date().toISOString() }); // a turn happened meanwhile
    const log: string[] = [];
    await runConversation(conv, { style: "" }, build, undefined, { query: coldQuery(log) });
    assert.deepEqual(log, ["cold"]);
    assert.deepEqual(rig.used, []);
    await tick();
    assert.deepEqual(rig.closed, ["warm1"]);
  } finally {
    (settings as { warm: boolean }).warm = was;
  }
});

test("warm: WARM=off starts nothing; WARM and WARM_IDLE_MINUTES are validated", async () => {
  assert.equal(loadSettings({}).warm, true);
  assert.equal(loadSettings({ WARM: "off" }).warm, false);
  assert.throws(() => loadSettings({ WARM: "maybe" }), /WARM/);
  assert.equal(loadSettings({}).warmIdleMinutes, 60);
  assert.throws(() => loadSettings({ WARM_IDLE_MINUTES: "0" }), /WARM_IDLE_MINUTES/);
  assert.equal(loadSettings({ WARM_IDLE_MINUTES: "90" }).warmIdleMinutes, 90);
  const was = settings.warm;
  (settings as { warm: boolean }).warm = false;
  try {
    const rig = startRig();
    prepare(group(gid()), { style: "" }, { start: rig.start, keep: true });
    prepare(group(gid()), { style: "" }, { start: rig.start });
    assert.equal(rig.started.length, 0);
  } finally {
    (settings as { warm: boolean }).warm = was;
  }
});

// ---- when the group brain asks for it ----

test("group warm: asked when a message arrives and after a turn, not while the group's own turn runs, not for tagged-only chatter", async () => {
  (settings as { dailyBudgetUsd: number }).dailyBudgetUsd = Infinity; // other test files share the data dir, and one of them spends the day's budget
  const calls: string[] = [];
  const sent: string[] = [];
  let hold: Promise<void> = Promise.resolve();
  const brain = createGroupBrain({
    pipeline: {
      record: () => {},
      react: () => {},
      wait: async () => {},
      canSpeak: () => false,
      enqueue: (_c: any, j: any) => j(),
      burstQueued: () => false,
      holdTyping: () => () => {},
      burst: async (_c: any, m: any, settled: any) => settled({ stale: () => false, timing: { set() {}, mark() {} }, run: (job: any) => job([m]) }),
      runTurn: async (_c: any, t: any) => (calls.push("turn"), await hold, sent.push((await t.run({ firstOutput() {} })).text), { spoke: true }),
    } as any,
    recent: () => [],
    run: async () => "ok",
    gate: async () => ({ act: true, task: "task" as const, delaySeconds: 0, nextCheckMinutes: 30 }),
    warm: (_c, after) => void calls.push(after ? "warm after" : "warm arrival"),
  });
  const g = gid();
  await brain({ groupId: g, text: "@Ted hi", timestamp: 1, isOwner: false, addressedToMe: true, author: "+1" });
  assert.deepEqual(calls, ["warm arrival", "turn", "warm after"]);
  calls.length = 0;
  let release!: () => void;
  hold = new Promise<void>((r) => (release = r));
  const first = brain({ groupId: g, text: "@Ted again", timestamp: 3, isOwner: false, addressedToMe: true, author: "+1" });
  await tick();
  const second = brain({ groupId: g, text: "@Ted and more", timestamp: 4, isOwner: false, addressedToMe: true, author: "+1" });
  await tick();
  release();
  await Promise.all([first, second]);
  assert.equal(calls.filter((c) => c === "warm arrival").length, 1); // none for the message that came while the turn ran
  const was = settings.groupParticipation;
  (settings as { groupParticipation: string }).groupParticipation = "tagged";
  try {
    calls.length = 0;
    await brain({ groupId: g, text: "chatter", timestamp: 2, isOwner: false, addressedToMe: false, author: "+1" });
    assert.deepEqual(calls, []); // nothing will be answered: no process for it
  } finally {
    (settings as { groupParticipation: string }).groupParticipation = was;
  }
});

// ---- one mechanism for every slot ----

test("warm slot: a refresh renews the process but not the idle period, and builds nothing for an expired one", async () => {
  let t = 0;
  const closed: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const slot = new SpareSlot<{ name: string; close(): void }>({
    maxAgeMs: 10_000,
    idleMs: () => 1000,
    now: () => t,
    schedule: (fn, ms) => {
      const x = { fn, ms, live: true };
      timers.push(x);
      return () => void (x.live = false);
    },
  });
  assert.equal(slot.wants("a"), false);
  slot.put("a", "k", fakeWarm("A", closed));
  t = 600;
  slot.put("a", "k", fakeWarm("A2", closed), { refresh: true }); // a timer renewed it
  await tick();
  assert.deepEqual(closed, ["A"]);
  assert.equal(timers.filter((x) => x.live).at(-1)!.ms, 400); // still counts from the last real use
  t = 900;
  slot.touch("a"); // real use: the full period again
  assert.equal(timers.filter((x) => x.live).at(-1)!.ms, 1000);
  timers.find((x) => x.live)!.fn();
  await tick();
  assert.equal(slot.wants("a"), false);
  slot.put("a", "k", fakeWarm("A3", closed), { refresh: true }); // nothing is warm for it any more: the renewal is discarded
  await tick();
  assert.equal(slot.holder, undefined);
  assert.deepEqual(closed, ["A", "A2", "A3"]);
});

test("warm slot: a key is part of has(), so a spare built for other options is not 'already warm'", () => {
  const slot = new SpareSlot<{ close(): void }>({ maxAgeMs: 1000 });
  slot.put("gate", "sys-1", Promise.resolve({ close() {} }));
  assert.equal(slot.has("gate", "sys-1"), true);
  assert.equal(slot.has("gate", "sys-2"), false);
});

test("warm: a warm process that died while idle falls back to a cold start; an error after output is not retried", async () => {
  const out = async (g: AsyncIterable<number>) => { const r: number[] = []; for await (const x of g) r.push(x); return r; };
  const dead = () => (async function* (): AsyncGenerator<number> { throw new Error("ProcessTransport is not ready for writing"); })();
  const cold = () => (async function* () { yield 7; })();
  const seen: string[] = [];
  assert.deepEqual(await out(firstWarm(dead, cold, (e) => seen.push(e.message))), [7]);
  assert.deepEqual(seen, ["ProcessTransport is not ready for writing"]);
  const half = () => (async function* (): AsyncGenerator<number> { yield 1; throw new Error("mid-turn"); })();
  await assert.rejects(out(firstWarm(half, cold)), /mid-turn/);
  const throwsAtOnce = () => { throw new Error("closed"); };
  assert.deepEqual(await out(firstWarm(throwsAtOnce as never, cold)), [7]);
});

test("gate spare: serves one group message look whatever the group, only for the exact system prompt, and replaces itself", async () => {
  const was = settings.warm;
  (settings as { warm: boolean }).warm = true;
  try {
    const started: any[] = [];
    const used: string[] = [];
    const qs = (log: string[], name: string) => Object.assign(stream(log, name), { close() {} }); // a Query can be closed
    const start = ((o: any) => (started.push(o.options), Promise.resolve({ query: (p: string) => (used.push(p), qs([], "warm")), close() {}, [Symbol.asyncDispose]: async () => {} }))) as any;
    prepareGate(T0, start);
    prepareGate(T0, start); // already warm for these options
    assert.equal(started.length, 1);
    assert.deepEqual([started[0].tools, started[0].mcpServers, started[0].settingSources, started[0].model], [[], {}, [], "haiku"]);
    assert.doesNotMatch(String(started[0].systemPrompt), /conversation_log|<notes>|CURRENT TIME/); // nothing of any conversation is in the options
    const cold: string[] = [];
    const io = { start, query: (() => qs(cold, "cold")) as any };
    const a = group(gid());
    const b = group(gid());
    await askGateWith({ conv: a, trigger: "message", now: T0, tail: ["x"] }, io);
    assert.equal(used.length, 1);
    assert.match(used[0]!, /CURRENT TIME/); // the conversation is in the prompt
    await tick();
    assert.equal(started.length, 2); // the next spare is on its way
    await askGateWith({ conv: b, trigger: "message", now: T0, tail: ["y"] }, io); // another group takes it
    assert.equal(used.length, 2);
    assert.deepEqual(cold, []);
    // different options (the clock look, the owner) never take it
    await tick();
    await askGateWith({ conv: a, trigger: "clock", now: T0, tail: [] }, io);
    await askGateWith({ conv: owner(), trigger: "message", now: T0, tail: [] }, io);
    assert.equal(used.length, 2);
    assert.deepEqual(cold, ["cold", "cold"]);
  } finally {
    (settings as { warm: boolean }).warm = was;
  }
});
