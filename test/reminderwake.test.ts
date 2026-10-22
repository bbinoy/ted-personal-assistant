import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "@ted-assistant/messenger";
import { FULL_CAPABILITIES } from "@ted-assistant/messenger/testing";

// Reminders and the wake tick / the intake order (src/heartbeat/wake.ts, src/conversation/intake.ts): reminders need no heartbeat and no WAKEUPS, and a quoted "done" on a reminder never reaches the approval model.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "reminderwake-test-"));
process.env.TZ = "Europe/Berlin";

const { settings } = await import("../src/core/settings.ts");
const { createWakeups } = await import("../src/heartbeat/wake.ts");
const { createPipeline, group, owner } = await import("../src/conversation/conversation.ts");
const { createOutbound } = await import("../src/conversation/outbound.ts");
const { createReminderAnswers } = await import("../src/tasks/remindanswer.ts");
const { zoneOf } = await import("../src/tenants/tenants.ts");
const { recordMessage, FILE } = await import("../src/core/messages.ts");
const S = await import("../src/tasks/store.ts");
const { peekConvDb } = await import("../src/core/convdb.ts");

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
const NOW = Date.parse("2026-10-22T10:00:00Z"); // 12:00 in Berlin
const scope = (key: string, now = NOW): import("../src/tasks/store.ts").Scope => ({ key, zone: "Europe/Berlin", by: "owner", origin: "owner", source: "chat", now });

test("the wake tick sends reminders with WAKEUPS off and no heartbeat run, for the owner and for a group", async () => {
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
    guards: { paused: () => false, budgetSpent: () => false },
  });
  await w.tick(new Date(NOW));
  assert.deepEqual(sent.map((x) => x.text).sort(), ["⏰ @Anna: ferry tickets", "⏰ Call Sam"]);
  assert.equal(looks, 0, "no heartbeat run: WAKEUPS is off");
  // the pause switch still stops them
  S.addItem(scope(o.key, NOW - 3_600_000), { title: "Paused one", remindAt: NOW - 60_000 });
  const p = createWakeups({ pipeline: pipeline as never, groupChats: false, vouch: async () => true, run: async () => ({ text: "" }), notesChangedAt: () => 0, now: () => new Date(NOW), guards: { paused: () => true, budgetSpent: () => false } });
  await p.tick(new Date(NOW));
  assert.equal(sent.length, 2);
});

test("a quoted done on a reminder is answered before the approval model is asked", async () => {
  const o = owner();
  const it = S.addItem(scope(o.key, NOW - 3_600_000), { title: "Pay rent" }).item;
  peekConvDb(o.convId)!.run("INSERT INTO reminders (item_id, key, state, fire_at, at, ts) VALUES (?, 'at:1', 'sent', ?, ?, 7777)", it.id, NOW, NOW);
  let asked = 0;
  const said: string[] = [];
  const messenger = { name: "fake", summary: "fake", self: "+10000000001", capabilities: FULL_CAPABILITIES, react: async () => {}, typing: async () => {}, markRead: async () => {}, send: async (_t: unknown, m: { text: string }) => (said.push(m.text), 9000 + said.length) };
  const out = createOutbound(messenger, (k, t, text) => recordMessage(k, t, text, new Date(), FILE));
  const pipeline = createPipeline({
    messenger, out, record: (_t, k, t, text) => recordMessage(k, t, text, new Date(), FILE),
    run: async () => ({ text: "" }),
    picture: async () => assert.fail("no picture"), document: async () => assert.fail("no document"), transcript: async () => assert.fail("no voice"),
    speech: { ready: () => false, synth: async () => assert.fail("no speech"), foreign: async () => undefined },
    approvals: { answer: async () => (asked++, { outcome: "none" as const }), answerReaction: () => "ignored" },
    reminders: createReminderAnswers({ out, zone: zoneOf }),
    vouch: async () => true, isOwner: () => true, admitGroup: async () => {}, wait: async () => {},
  });
  const msg: IncomingMessage = { from: "+10000000000", text: "done", timestamp: 8000, direct: true, quote: { text: "⏰ Pay rent", author: "+10000000001", timestamp: 7777 } };
  await pipeline.handleIncoming(o, { type: "message", m: msg });
  assert.equal(asked, 0, "the approval model was never asked");
  assert.equal(S.getItem(o.key, it.id)!.status, "done");
});
