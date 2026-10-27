import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./util.ts";
import { Limiter } from "../src/core/limiter.ts";
import { gated, runGate } from "../src/core/rungate.ts";
import { loadSettings, settings } from "../src/core/settings.ts";
import { browseRunOptions, runAgent } from "../src/run/agentrun.ts";
import { RunStopped, stopRuns } from "../src/run/ceiling.ts";
import { WarmPool } from "../src/run/agentwarm.ts";
import { BROWSE_RUN, OWNER_LOOK } from "./runkinds.ts";

const s = settings as unknown as Record<string, unknown>;

test("limiter: the cap is respected, and the waiting go best priority first, in arrival order within one", async () => {
  const lim = new Limiter(() => 2);
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const job = (name: string, priority: number) => lim.run(async () => { order.push(name); peak = Math.max(peak, ++active); await sleep(10); active--; }, { priority });
  await Promise.all([job("a", 5), job("b", 5), job("dream1", 3), job("look1", 2), job("dream2", 3), job("look2", 2)]);
  assert.deepEqual(order, ["a", "b", "look1", "look2", "dream1", "dream2"]);
  assert.equal(peak, 2);
});

test("limiter: an urgent job never waits (it takes a place over the limit), and the ones behind it wait for it", async () => {
  const lim = new Limiter(() => 1);
  const hold: (() => void)[] = [];
  const blocked = lim.run(() => new Promise<void>((r) => hold.push(r)));
  const order: string[] = [];
  const later = lim.run(async () => void order.push("background"), { priority: 3 });
  await lim.run(async () => void order.push("chat"), { urgent: true });
  assert.deepEqual(order, ["chat"], "the chat turn ran at once, ahead of the queued background job");
  assert.equal(lim.queued, 1);
  hold[0]!();
  await Promise.all([blocked, later]);
  assert.deepEqual(order, ["chat", "background"]);
  assert.equal(lim.running, 0);
});

test("limiter: a failing urgent job releases its place; a waiting job can be called off and then never starts", async () => {
  const lim = new Limiter(() => 1);
  let release!: () => void;
  const first = lim.run(() => new Promise<void>((r) => (release = r)));
  const ac = new AbortController();
  let started = false;
  const waiting = lim.run(async () => void (started = true), { signal: ac.signal });
  ac.abort(new Error("overtaken"));
  await assert.rejects(waiting, /overtaken/);
  assert.equal(lim.queued, 0);
  await assert.rejects(lim.run(async () => void (started = true), { signal: ac.signal }), /overtaken/, "already called off: never queued");
  release();
  await first;
  await assert.rejects(lim.run(async () => { throw new Error("boom"); }, { urgent: true }), /boom/);
  assert.equal(lim.running, 0);
  assert.equal(started, false);
  assert.equal(await lim.run(async () => "after"), "after");
});

test("run gate: MAX_CONCURRENT_RUNS places for looks and dreams; a chat turn never waits and a look goes before a dream", async () => {
  const was = settings.maxConcurrentRuns;
  s.maxConcurrentRuns = 2;
  try {
    const free: (() => void)[] = [];
    const log: string[] = [];
    const hold = (name: string) => () => new Promise<void>((r) => (log.push(`start ${name}`), free.push(r)));
    const l1 = gated("look", hold("look1"));
    const l2 = gated("look", hold("look2"));
    const dream = gated("dream", hold("dream"));
    const look3 = gated("look", hold("look3"));
    await sleep(5);
    assert.deepEqual(log, ["start look1", "start look2"], "two places, the rest wait");
    assert.equal(runGate.full, true);
    await gated("chat", async () => void log.push("chat"));
    assert.ok(log.includes("chat"), "chat did not wait for a place");
    free[0]!();
    await sleep(5);
    assert.deepEqual(log.slice(2).filter((x) => x !== "chat"), ["start look3"], "the look is ahead of the dream that came earlier");
    free[1]!();
    await sleep(5);
    free[2]!();
    await sleep(5);
    free[3]!();
    await Promise.all([l1, l2, dream, look3]);
    assert.equal(runGate.running, 0);
    assert.equal(runGate.full, false);
  } finally {
    s.maxConcurrentRuns = was;
  }
});

test("settings: MAX_CONCURRENT_RUNS defaults to 3 and GROUP_WARM_SLOTS to 2, both validated", () => {
  assert.equal(loadSettings({}).maxConcurrentRuns, 3);
  assert.equal(loadSettings({ MAX_CONCURRENT_RUNS: "5" }).maxConcurrentRuns, 5);
  assert.throws(() => loadSettings({ MAX_CONCURRENT_RUNS: "0" }), /MAX_CONCURRENT_RUNS/);
  assert.equal(loadSettings({}).groupWarmSlots, 2);
  assert.throws(() => loadSettings({ GROUP_WARM_SLOTS: "-1" }), /GROUP_WARM_SLOTS/);
});

test("warm pool: GROUP_WARM_SLOTS groups keep a process (least recently used goes first), 0 keeps none", () => {
  const was = [settings.warm, settings.groupWarmSlots];
  s.warm = true;
  s.groupWarmSlots = 2;
  try {
    const pool = new WarmPool({ maxAgeMs: 60_000 });
    const g = (n: number) => ({ key: `group:${n}`, kind: "group" as const });
    pool.slot(g(1), true);
    pool.slot(g(2), true);
    pool.slot(g(1), false); // 1 is the most recently used now
    pool.slot(g(3), true); // 2 goes
    assert.equal(pool.slot(g(2), false), undefined);
    assert.ok(pool.slot(g(1), false) && pool.slot(g(3), false));
    s.groupWarmSlots = 0;
    assert.equal(pool.slot(g(4), true), undefined, "0: none");
  } finally {
    [s.warm, s.groupWarmSlots] = was;
  }
});

test("/stop reaches a look that still waits for a place in the run gate, and the gate is left clean", async () => {
  const was = settings.maxConcurrentRuns;
  s.maxConcurrentRuns = 1;
  try {
    let free!: () => void;
    const holder = gated("look", () => new Promise<void>((r) => (free = r)));
    const look = runAgent("p", (async () => ({ approved: false })) as never, { source: "background", stopScope: "scope-x" } as never, { query: (() => assert.fail("never started")) as never });
    await sleep(5);
    assert.equal(runGate.queued, 1);
    assert.equal(stopRuns("scope-x"), 1);
    await assert.rejects(look, RunStopped);
    assert.equal(runGate.queued, 0, "it left the line");
    free();
    await holder;
    assert.equal(runGate.running, 0);
  } finally {
    s.maxConcurrentRuns = was;
  }
});

// ---- the run gate seen from runAgent: a browse child never queues, a look parked on an approval gives its place away ----
const okResult = { type: "result", subtype: "success", is_error: false, result: "hi", total_cost_usd: 0, session_id: "s", duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: {} } as never;
const quick = (() => (async function* () { yield okResult; })()) as never;
const base = { kind: OWNER_LOOK, systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 } as const;

test("a browse child (gate: helper) never queues for a place, even when every place is held by looks that wait for it", async () => {
  const was = settings.maxConcurrentRuns;
  s.maxConcurrentRuns = 2;
  try {
    const looks = [0, 1].map(() => gated("look", () => runAgent("p", async () => ({ approved: true }), { ...base, gate: "helper" } as never, { query: quick }))); // a look that browses: its child runs under the place the look holds
    assert.deepEqual((await Promise.all(looks)).map((r) => r.text), ["hi", "hi"]);
    const free: (() => void)[] = [];
    const blockers = [0, 1].map(() => gated("look", () => new Promise<void>((r) => free.push(r)))); // all places taken
    assert.equal(runGate.full, true);
    assert.equal((await runAgent("p", async () => ({ approved: true }), { ...base, gate: "helper" } as never, { query: quick })).text, "hi", "a chat turn's browse child does not wait behind looks");
    assert.equal(runGate.queued, 0);
    free.forEach((r) => r());
    await Promise.all(blockers);
  } finally {
    s.maxConcurrentRuns = was;
  }
});

test("a run parked on an approval gives its place to others meanwhile and takes one again when the answer comes (a browse worker of a chat turn: an unattended run asks nobody)", async () => {
  const was = settings.maxConcurrentRuns;
  s.maxConcurrentRuns = 1;
  try {
    let answer!: () => void;
    const approve = () => new Promise<{ approved: boolean }>((r) => (answer = () => r({ approved: true })));
    const q = ((p: { options: { canUseTool: (t: string, i: object, o: object) => Promise<unknown> } }) => (async function* () {
      await p.options.canUseTool("mcp__browser__browser_navigate", {}, { signal: new AbortController().signal });
      yield okResult;
    })()) as never;
    const look = runAgent("p", approve as never, { ...base, kind: BROWSE_RUN } as never, { query: q });
    await sleep(20);
    assert.equal(runGate.running, 0, "parked: the place is free");
    assert.equal(await gated("look", async () => "another look ran"), "another look ran");
    answer();
    assert.equal((await look).text, "hi");
    assert.equal(runGate.running, 0);
  } finally {
    s.maxConcurrentRuns = was;
  }
});

test("the browse child is called off with its parent: the parent's signal and \"/stop\" in the parent's conversation reach it", async () => {
  const guard = { vision: false, profileKeys: () => [], cardInfo: () => undefined } as never;
  const parent = new AbortController();
  const o = browseRunOptions(guard, undefined, { signal: parent.signal, stopScope: "chat-scope" });
  assert.deepEqual([o.gate, o.signal, o.stopScope], ["helper", parent.signal, "chat-scope"]);
  const hung = (() => (async function* () { await new Promise(() => {}); })()) as never;
  const byStop = runAgent("p", async () => ({ approved: true }), { ...base, gate: "helper", stopScope: "chat-scope" } as never, { query: hung });
  await sleep(5);
  assert.equal(stopRuns("chat-scope"), 1);
  await assert.rejects(byStop, RunStopped);
  const bySignal = runAgent("p", async () => ({ approved: true }), { ...base, gate: "helper", signal: parent.signal } as never, { query: (({ options }: { options: { abortController: AbortController } }) => (async function* () { await new Promise((_, no) => options.abortController.signal.addEventListener("abort", () => no(new Error("aborted")))); })()) as never });
  await sleep(5);
  parent.abort();
  await assert.rejects(bySignal, /aborted/);
});
