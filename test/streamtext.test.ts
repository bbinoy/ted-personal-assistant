import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TRIAL, capability `stream` (owner only; remove at rollout): in a chat turn every top-level text block is delivered as it is written; the final reply is not sent twice.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "streamtext-"));

const { consume } = await import("../src/run/agentrun.ts");
const { createDelivery } = await import("../src/conversation/delivery.ts");
const { owner, group } = await import("../src/conversation/conversation.ts");
const { scopeOf } = await import("../src/approvals/turnscope.ts");
const { allows } = await import("../src/policy/capabilities.ts");

const text = (t: string, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "text", text: t }], usage: {} } });
const tool = { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }], usage: {} } };
const result = (r: string) => ({ type: "result", subtype: "success", is_error: false, result: r, session_id: "S", total_cost_usd: 0 });
const feed = (...msgs: object[]) => (async function* () { yield* msgs as never[]; })();

function rig() {
  const log: string[] = [];
  const out = {
    reply: async (t: string) => (log.push(t), log.length),
    replyPlain: async (t: string) => (log.push(t), log.length),
    sendVoice: async (_f: string, spoken: string) => (log.push(`voice:${spoken}`), log.length),
    sendPicture: async () => 0,
  };
  const messenger = { capabilities: { reactions: true, typing: true, quotes: false }, self: "me", react: async (_t: unknown, _m: unknown, emoji: string) => void log.push(`react:${emoji}`), typing: async () => {}, markRead: async () => {} };
  const speech = { ready: () => false, synth: async () => "", foreign: async () => undefined };
  const delivery = createDelivery({ messenger, out, speech, isOwner: () => true } as never);
  return { log, delivery };
}

const run = (conv: ReturnType<typeof owner>, msgs: object[], final: string) => async () => {
  const opts = { kind: { who: conv.kind === "owner" ? "owner" : "group", attended: true } as never, systemPrompt: "x", conversation: conv.key, maxTurns: 1, maxBudgetUsd: 1 };
  return { text: (await consume(feed(...msgs, result(final)), opts, 0)).text };
};
const turn = (conv: ReturnType<typeof owner>, r: ReturnType<typeof run>) => ({ run: r, announce: true, target: { author: "+2", timestamp: 5 } });

test("stream: only the owner has the capability", () => {
  assert.equal(allows(owner(), "stream"), true);
  assert.equal(allows(group("g1"), "stream"), false);
});

test("stream: text, tool, text, tool, text is three messages in order, the final one is not sent again", async () => {
  const { log, delivery } = rig();
  const c = owner();
  const r = await delivery.runTurn(c, turn(c, run(c, [text("one"), tool, text("two"), tool, text("three")], "three")));
  assert.equal(r.error, undefined);
  assert.deepEqual(log, ["one", "two", "three"]);
});

test("stream: markers are handled per block; a blank block is skipped; a subagent's text is not delivered", async () => {
  const { log, delivery } = rig();
  const c = owner();
  await delivery.runTurn(c, turn(c, run(c, [text("[[voice]] hello"), text("   "), tool, text("secret", "toolu_sub"), text("[[react: 👍]]"), text("[[silent]]"), text("[[react: 🎉]] done")], "[[react: 🎉]] done")));
  assert.deepEqual(log, ["hello", "react:👍", "done", "react:🎉"]);
});

test("stream: the judge's record of what was said covers every block of the turn", async () => {
  const { delivery } = rig();
  const c = owner();
  scopeOf(c.key).say("please draft it");
  await delivery.runTurn(c, turn(c, run(c, [text("first part"), tool, text("second part")], "second part")));
  const said = (scopeOf(c.key).read() as { assistantSaid?: string }).assistantSaid ?? "";
  assert.match(said, /first part/);
  assert.match(said, /second part/);
});

test("stream: a different final reply after the streamed blocks is still sent", async () => {
  const { log, delivery } = rig();
  const c = owner();
  await delivery.runTurn(c, turn(c, run(c, [text("working"), tool], "all done")));
  assert.deepEqual(log, ["working", "all done"]);
});

test("no stream: a conversation without the capability gets only the final reply, as before", async () => {
  const { log, delivery } = rig();
  const c = group("g1");
  await delivery.runTurn(c, turn(c, run(c, [text("one"), tool, text("two")], "two")));
  assert.deepEqual(log, ["two"]);
});
