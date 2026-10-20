import { test } from "node:test";
import assert from "node:assert/strict";
import { createPipeline, owner, group } from "../src/conversation/conversation.ts";
import { defer, tick } from "./util.ts";

// One run at a time per conversation: the pipeline says whether a turn of a conversation is settling, queued or running (busy), and the heartbeat look waits for it
// (test/heartbeatrun.test.ts). The pipeline is the real one; only what it talks to is fake.
function pipeline(wait: (ms: number) => Promise<void> = async () => {}) {
  return createPipeline({ messenger: { capabilities: {} }, out: {}, record: () => {}, wait } as never);
}

test("busy: false when idle, true while a job of the conversation is queued or running, only for that conversation", async () => {
  const p = pipeline();
  const conv = owner();
  assert.equal(p.busy(conv), false);
  const hold = defer<void>();
  const order: string[] = [];
  const first = p.enqueue(conv, async () => (order.push("turn-start"), await hold.promise, order.push("turn-end")));
  assert.equal(p.busy(conv), true, "running");
  assert.equal(p.busy(group("g-other")), false, "another conversation is not blocked");
  const second = p.enqueue(conv, async () => void order.push("next"));
  hold.resolve();
  await Promise.all([first, second]);
  await tick();
  assert.deepEqual(order, ["turn-start", "turn-end", "next"], "turns run one at a time, in order");
  assert.equal(p.busy(conv), false, "idle again");
});

test("busy: a message in its settling pause counts, so a look right after the owner wrote does not start", async () => {
  const settle = defer<void>();
  const p = pipeline(() => settle.promise);
  const conv = owner();
  const ran: string[] = [];
  const burst = p.burst(conv, { timestamp: 1 }, async (b) => void (await b.run(async () => void ran.push("answered"))), Date.now());
  await tick();
  assert.equal(p.busy(conv), true, "settling");
  settle.resolve();
  await burst;
  await tick();
  assert.deepEqual(ran, ["answered"]);
  assert.equal(p.busy(conv), false);
});
