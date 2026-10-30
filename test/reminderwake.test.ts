import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reminders and the wake tick (src/heartbeat/wake.ts): reminders need no heartbeat and no WAKEUPS: a conversation without a look gets the fallback line at once (heartbeat/remindtick.ts).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "reminderwake-test-"));
process.env.TZ = "Europe/Berlin";

const { settings } = await import("../src/core/settings.ts");
const { createWakeups } = await import("../src/heartbeat/wake.ts");
const { group, owner } = await import("../src/conversation/conversation.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const S = await import("../src/tasks/store.ts");

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
const NOW = Date.parse("2026-10-22T10:00:00Z"); // 12:00 in Berlin
const scope = (key: string, now = NOW): import("../src/tasks/store.ts").Scope => ({ key, zone: "Europe/Berlin", by: "owner", origin: "owner", source: "chat", now });

test("with WAKEUPS off (no look to say them) the wake tick sends the fallback line for the owner and for a group", async () => {
  s.wakeups = false;
  const g = group("remwake-group-0123456789abcdef");
  const o = owner();
  S.addItem(scope(o.key, NOW - 3_600_000), { title: "Call Sam", remindAt: NOW - 60_000 });
  S.addItem(scope(g.key, NOW - 3_600_000), { title: "ferry tickets", remindAt: NOW - 60_000, assignee: "Anna" });
  const sent: { conv: string; text: string }[] = [];
  let looks = 0;
  const pipeline = {
    busy: () => false, sendWhile: async (_c: unknown, run: () => Promise<unknown>) => run(), record: () => {},
    enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(),
    runTurn: async (c: { key: string; logFile: string }, turn: { run: () => Promise<{ text: string }> }) => {
      const text = (await turn.run()).text;
      sent.push({ conv: c.key, text });
      recordMessage("notice", 5000 + sent.length, text, new Date(NOW), c.logFile);
      return { spoke: true };
    },
  };
  const w = createWakeups({
    pipeline: pipeline as never,
    groupChats: true,
    groups: () => [g.key],
    vouch: async () => true,
    run: async () => (looks++, { text: "" }),
    notesChangedAt: () => 0,
    now: () => new Date(NOW),
    guards: { paused: () => false },
  });
  await w.tick(new Date(NOW));
  assert.deepEqual(sent.map((x) => x.text).sort(), ["⏰ @Anna: ferry tickets", "⏰ Call Sam"]);
  assert.equal(looks, 0, "no heartbeat run: WAKEUPS is off");
  // the pause switch still stops them
  S.addItem(scope(o.key, NOW - 3_600_000), { title: "Paused one", remindAt: NOW - 60_000 });
  const p = createWakeups({ pipeline: pipeline as never, groupChats: false, vouch: async () => true, run: async () => ({ text: "" }), notesChangedAt: () => 0, now: () => new Date(NOW), guards: { paused: () => true } });
  await p.tick(new Date(NOW));
  assert.equal(sent.length, 2);
});
