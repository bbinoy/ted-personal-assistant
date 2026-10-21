import { test } from "node:test";
import assert from "node:assert/strict";
import { sleptFor, startHeartbeat, SETTLE_MS } from "../src/heartbeat/heartbeat.ts";
import { createStagger } from "../src/heartbeat/stagger.ts";
import { RunAborted, withCeiling } from "../src/run/ceiling.ts";
import { settings } from "../src/core/settings.ts";

// A Mac that sleeps: the tick notices the gap (Date clock against a monotonic one, or ticks far apart), stops what was in flight and lets the due-check restart it after a short settle delay.

const MIN = 60_000;
const PERIOD = settings.heartbeatMinutes * MIN;

test("sleptFor: normal ticks, a long sleep (the clocks disagree), a suspended process (ticks far apart), a short nap", () => {
  assert.equal(sleptFor(PERIOD, PERIOD, PERIOD), 0);
  assert.equal(sleptFor(PERIOD + 3000, PERIOD, PERIOD), 0, "a late tick is not a sleep");
  assert.equal(sleptFor(35 * MIN, 5 * MIN, PERIOD), 30 * MIN, "the Date clock ran on while the monotonic one stood still");
  assert.equal(sleptFor(4 * PERIOD, 4 * PERIOD, PERIOD), 4 * PERIOD, "more than three periods apart whatever the clocks say");
  assert.equal(sleptFor(3 * PERIOD, 3 * PERIOD, PERIOD), 0);
  assert.equal(sleptFor(PERIOD + 2 * MIN, PERIOD, PERIOD), 0, "a nap shorter than a period is no news");
});

test("the tick: after a sleep it logs how long, stops what was in flight, and starts the jobs only after the settle delay", () => {
  let wall = 1_000_000;
  let mono = 5_000;
  const timers: { f: () => void; ms: number }[] = [];
  const intervals: (() => void)[] = [];
  const events: string[] = [];
  const log = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    startHeartbeat(
      { onTick: () => void events.push("jobs"), onSleep: (ms) => void events.push(`sleep ${Math.round(ms / MIN)}`) },
      { setTimeout: (f, ms) => void timers.push({ f, ms }), setInterval: (f) => void intervals.push(f), now: () => wall, mono: () => mono },
    );
    timers[0]!.f(); // the first tick, 20 s after the start
    assert.deepEqual(events, ["jobs"]);
    wall += PERIOD;
    mono += PERIOD;
    intervals[0]!();
    assert.deepEqual(events, ["jobs", "jobs"]);
    // the lid is closed for 90 minutes: the monotonic clock stands still
    wall += 90 * MIN + PERIOD;
    mono += PERIOD;
    intervals[0]!();
    assert.deepEqual(events, ["jobs", "jobs", "sleep 90"], "the runs are stopped at once, the jobs wait");
    assert.ok(logged.some((l) => l === "heartbeat: the Mac slept for 90 min"));
    assert.equal(timers.at(-1)!.ms, SETTLE_MS);
    assert.equal(SETTLE_MS, 20_000);
    timers.at(-1)!.f();
    assert.deepEqual(events, ["jobs", "jobs", "sleep 90", "jobs"], "then the normal due-check restarts them");
    // and the tick after that is normal again
    wall += PERIOD;
    mono += PERIOD;
    intervals[0]!();
    assert.equal(events.at(-1), "jobs");
    assert.equal(events.length, 5);
  } finally {
    console.log = log;
  }
});

test("a throwing onSleep does not keep the jobs from starting", () => {
  let wall = 0;
  let mono = 0;
  const timers: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  let jobs = 0;
  const err = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    startHeartbeat({ onTick: () => void jobs++, onSleep: () => { throw new Error("x"); } }, { setTimeout: (f) => void timers.push(f), setInterval: (f) => void intervals.push(f), now: () => wall, mono: () => mono });
    wall += 60 * MIN;
    intervals[0]!();
    timers.at(-1)!();
    assert.equal(jobs, 1);
  } finally {
    console.error = err;
    console.log = log;
  }
});

test("stagger: at most the cap at once and a gap between two starts (fake clock)", async () => {
  let t = 0;
  const pending: { at: number; resolve: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((resolve) => pending.push({ at: t + ms, resolve }));
  const flush = () => new Promise((r) => setImmediate(r));
  const drive = async () => { // virtual time: wake the earliest sleeper, until nobody sleeps
    await flush();
    while (pending.length) {
      pending.sort((x, y) => x.at - y.at);
      const next = pending.shift()!;
      t = Math.max(t, next.at);
      next.resolve();
      await flush();
    }
  };
  const s = createStagger({ concurrency: 3, gapMs: 2000, sleep, now: () => t });
  const starts: [number, number][] = [];
  let active = 0;
  let most = 0;
  const releases: (() => void)[] = [];
  const job = (i: number) => s.run(async () => {
    starts.push([i, t]);
    most = Math.max(most, ++active);
    await new Promise<void>((r) => releases.push(r));
    active--;
  });
  const all = [0, 1, 2, 3, 4].map(job);
  await drive();
  assert.deepEqual(starts, [[0, 0], [1, 2000], [2, 4000]], "three at once at most, two seconds apart");
  assert.equal(most, 3);
  releases[0]!();
  await drive();
  assert.deepEqual(starts[3], [3, 6000], "the fourth takes the free slot, still a gap behind the third");
  releases[1]!();
  await drive();
  assert.deepEqual(starts[4], [4, 8000]);
  for (const r of releases) r();
  await Promise.all(all);
  assert.equal(most, 3);
  // a job that throws gives its slot back
  const one = createStagger({ concurrency: 1, gapMs: 0 });
  await assert.rejects(one.run(async () => { throw new Error("no"); }), /no/);
  assert.equal(await one.run(async () => "next"), "next");
});

test("ceiling: an outside abort rejects the run at once with RunAborted and stops the query; an abort before the start does too", async () => {
  const ctl = new AbortController();
  let inner!: AbortSignal;
  const run = withCeiling(60_000, (c) => ((inner = c.signal), new Promise<never>(() => {})), ctl.signal);
  ctl.abort("the Mac slept");
  await assert.rejects(run, (e: Error) => e instanceof RunAborted && /the Mac slept/.test(e.message));
  assert.equal(inner.aborted, true);
  const early = new AbortController();
  early.abort("early");
  await assert.rejects(withCeiling(60_000, () => new Promise<never>(() => {}), early.signal), RunAborted);
});
