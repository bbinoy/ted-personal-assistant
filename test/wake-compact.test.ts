import { test } from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../src/conversation/conversation.ts";
import { createWakeups } from "../src/heartbeat/wake.ts";

const T0 = new Date("2026-10-12T12:00:00Z");
const G = "wake-compact-group-0123456789ab";

test("wake: a grown, quiet conversation is compacted from the tick inside its queue; the one function for the owner and groups; not when paused or over budget", async () => {
  const events: string[] = [];
  const mk = (guards: { paused: boolean; spent: boolean }, due: () => boolean) =>
    createWakeups({
      pipeline: { canSpeak: () => false, sendWhile: async (_c: unknown, run: () => Promise<unknown>) => run(), enqueue: async (c: Conversation, job: () => Promise<unknown>) => (events.push(`queued:${c.kind}`), job()), record: () => {}, runTurn: async () => ({ spoke: false }) } as any,
      groupChats: true,
      vouch: async () => true,
      run: async () => ({ text: "" }),
      groups: () => [G],
      compact: { due, run: async (c: Conversation) => void events.push(`compact:${c.kind}`) },
      notesChangedAt: () => 0,
      guards: { paused: () => guards.paused, budgetSpent: () => guards.spent },
      now: () => T0,
    });
  const w = mk({ paused: false, spent: false }, () => true);
  await w.tick(T0);
  await w.idle();
  assert.deepEqual(events.sort(), ["compact:group", "compact:owner", "queued:group", "queued:owner"]);
  events.length = 0;
  for (const g of [{ paused: true, spent: false }, { paused: false, spent: true }]) await mk(g, () => true).tick(T0);
  await mk({ paused: false, spent: false }, () => false).tick(T0);
  assert.deepEqual(events, []);
});
