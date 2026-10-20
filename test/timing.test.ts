import { test } from "node:test";
import assert from "node:assert/strict";
import { startTiming } from "../src/core/timing.ts";
import { createPipeline, group, owner } from "../src/conversation/conversation.ts";
import { createOutbound } from "../src/conversation/outbound.ts";
import { FULL_CAPABILITIES } from "@ted-assistant/messenger/testing";

test("timing: marks are ms since arrival, durations are as given, the first value wins, the line has no content", () => {
  let t = 1000;
  const tm = startTiming("group", () => t, 900);
  tm.mark("settle"); // 100
  t = 1500;
  tm.mark("settle"); // ignored
  tm.set("gate", 640.4);
  tm.set("gateDelay", 3000);
  tm.mark("typing");
  assert.equal(tm.line(), "timing group settle=100 gate=640 gateDelay=3000 typing=600");
  const lines: string[] = [];
  tm.report((l) => lines.push(l));
  tm.report((l) => lines.push(l));
  assert.equal(lines.length, 1); // once per turn
  assert.equal(startTiming("owner", () => 5).line(), "timing owner ");
});

test("timing: one line per answered turn, owner and group, with every stage and nothing the user wrote", async () => {
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    let clock = 10_000;
    const messenger = { name: "fake", summary: "fake", self: "+1", capabilities: FULL_CAPABILITIES, react: async () => {}, typing: async () => {}, markRead: async () => {}, send: async () => 1 };
    const record = () => {};
    const pipeline = createPipeline({
      messenger,
      out: createOutbound(messenger, record),
      record,
      run: async (_c, _p, _o, _pics, hooks) => (clock += 700, hooks?.firstOutput(), clock += 300, { text: "ok" }),
      picture: async () => assert.fail("no picture"),
      document: async () => assert.fail("no document"),
      transcript: async () => "",
      speech: { ready: () => false, synth: async () => "", foreign: async () => undefined },
      approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
      vouch: async () => true,
      isOwner: () => false,
      admitGroup: async (conv, m) => {
        await pipeline.burst(conv, m, (b) => b.run(async () => void (await pipeline.runTurn(conv, { run: async () => ({ text: "hi" }), timing: b.timing, announce: false }))), m.arrivedAt);
      },
      now: () => clock,
      wait: async (ms) => void (clock += ms),
      settleMs: () => 2000,
      settleMaxMs: () => 10_000,
    });
    await pipeline.handleIncoming(owner(), { type: "message", m: { from: "+1", text: "secret words", timestamp: 1, direct: true } });
    await pipeline.handleIncoming(group("g-timing"), { type: "message", m: { from: "+2", text: "other secret", timestamp: 2, direct: false, group: { id: "g-timing" } } });
    const lines = logged.filter((l) => l.startsWith("timing "));
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^timing owner settle=2000 typing=2000 queue=0 first=2700 run=1000 total=3000$/);
    assert.match(lines[1]!, /^timing group settle=2000 queue=0 typing=2000 run=0 total=2000$/); // this stub never holds typing early
    assert.doesNotMatch(lines.join("\n"), /secret/);
  } finally {
    console.log = realLog;
  }
});
