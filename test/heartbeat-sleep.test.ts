import { test } from "node:test";
import assert from "node:assert/strict";
import { sleptFor, startHeartbeat, SETTLE_MS } from "../src/heartbeat/heartbeat.ts";
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
