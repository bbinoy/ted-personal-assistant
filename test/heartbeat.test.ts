import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./util.ts";
const tick = () => sleep(10);
import { startHeartbeat, startJobs } from "../src/heartbeat.ts";
import { readJson } from "../src/state.ts";

// The heartbeat tick and the jobs it starts (every conversation's look, the dream) are independent: a failing or hanging one never keeps another from
// running. What a conversation does on a tick is the heartbeat run (test/heartbeatrun.test.ts).

test("startJobs: a job that throws (sync or async) or never finishes does not stop the others", async () => {
  const ran: string[] = [];
  const errors: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    startJobs({
      throws: () => { throw new Error("sync boom"); },
      rejects: async () => { throw new Error("async boom"); },
      hangs: () => new Promise(() => {}), // a slow job: never awaited
      wake: () => void ran.push("wake"),
      brief: async () => void ran.push("brief"),
      mail: () => void ran.push("mail"),
    });
    await tick();
  } finally {
    console.error = was;
  }
  assert.deepEqual(ran, ["wake", "brief", "mail"]);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /throws: tick failed: sync boom/.test(e)) && errors.some((e) => /rejects: tick failed: async boom/.test(e)));
});

test("heartbeat: the tick starts its jobs, a throwing or hanging job skips nothing, and the liveness line is written (also at night)", async () => {
  const timers: (() => void)[] = [];
  const ran: string[] = [];
  const quiet = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const hb = startHeartbeat(
      {
        onTick: () => startJobs({
          wake: () => void ran.push("wake"),
          dream: () => { throw new Error("dream broke"); },
          brief: () => new Promise(() => {}), // takes "minutes"
          mail: async () => void ran.push("mail"),
        }),
      },
      { setTimeout: (f) => void timers.push(f), setInterval: (f) => void timers.push(f) },
    );
    assert.equal(timers.length, 2); // the first-tick timer and the interval, both ours
    timers[0]!();
    await tick();
    assert.deepEqual(ran, ["wake", "mail"]);
    assert.ok(readJson<{ lastTickAt?: string }>("state/heartbeat.json", {}).lastTickAt, "proof of life for doctor");
    timers[1]!();
    await tick();
    assert.deepEqual(ran, ["wake", "mail", "wake", "mail"]);
    void hb;
  } finally {
    console.error = quiet;
    console.log = log;
  }
});
