import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./util.ts";
import { Limiter } from "../src/core/limiter.ts";


test("limiter: never more than the limit at once, every job runs, in arrival order", async () => {
  const lim = new Limiter(() => 2);
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const job = (i: number) => lim.run(async () => {
    started.push(i);
    peak = Math.max(peak, ++active);
    await sleep(15);
    active--;
    return i;
  });
  const out = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(job));
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6]); // none skipped
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(peak, 2);
  assert.equal(lim.queued, 0);
});

test("limiter: a failing job gives its place to the next one", async () => {
  const lim = new Limiter(() => 1);
  const a = lim.run(async () => { await sleep(5); throw new Error("whisper failed"); });
  const b = lim.run(async () => "b");
  await assert.rejects(a, /whisper failed/);
  assert.equal(await b, "b");
  assert.equal(await lim.run(async () => "c"), "c"); // and the place was freed
});

