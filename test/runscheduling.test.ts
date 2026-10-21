import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./util.ts";
import { Limiter } from "../src/core/limiter.ts";
import { gated, runGate } from "../src/core/rungate.ts";
import { loadSettings, settings } from "../src/core/settings.ts";
import { runAgent } from "../src/run/agentrun.ts";
import { RunStopped, stopRuns } from "../src/run/ceiling.ts";
import { WarmPool } from "../src/run/agentwarm.ts";

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
