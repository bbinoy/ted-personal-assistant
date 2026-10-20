import { test } from "node:test";
import assert from "node:assert/strict";
import { tick as settle } from "./util.ts";
import { formatWait } from "../src/approvals/approvals.ts";
import { answer, answerReaction, request } from "./approvalrig.ts";

// Background approvals (wake-ups, presets, the handler) must not swallow the owner's chat messages.
const call = { tool: "mcp__claude_ai_Google_Calendar__create_event", input: { summary: "x" } };
const ask = (background: boolean, ts = 500) => {
  const asked = request(async () => ts, "Create event x", call, undefined, { background });
  return asked;
};
const never = { judge: async () => assert.fail("the judge must not be called"), recent: () => [] };

test("background approval: the only open one takes an exact yes / no without a judge call", async () => {
  const d = ask(true);
  await settle();
  assert.deepEqual(await answer("Yes!", () => {}, undefined, never), { outcome: "approved" });
  assert.deepEqual(await d, { approved: true });
  const n = ask(true);
  await settle();
  assert.deepEqual(await answer("no", () => {}, undefined, never), { outcome: "declined" });
  assert.deepEqual(await n, { approved: false });
});

test("background approval: a reaction on the approval message still answers it", async () => {
  const d = ask(true, 777);
  await settle();
  assert.equal(answerReaction("👍", 1), "ignored");
  assert.equal(answerReaction("👍", 777), "approved");
  assert.deepEqual(await d, { approved: true });
});

// ---- several open approvals ----
const sent: string[] = [];
const askTs = (background: boolean, ts: number, desc = `Create event ${ts}`, signal?: AbortSignal) =>
  request(async (t) => (sent.push(t), ts), desc, call, signal, { background });

test("three chat approvals: answered independently by reaction and quoted reply", async () => {
  const a = askTs(false, 1001);
  const b = askTs(false, 1002);
  const c = askTs(false, 1003);
  await settle();
  assert.equal(answerReaction("👎", 1001), "declined");
  assert.deepEqual(await a, { approved: false });
  assert.deepEqual(await answer("yes", () => {}, { timestamp: 1002 }, never), { outcome: "approved" }); // quoted: b
  assert.deepEqual(await b, { approved: true });
  assert.deepEqual(await answer("no", () => {}, undefined, never), { outcome: "declined" }); // the only one left
  assert.deepEqual(await c, { approved: false });
  assert.deepEqual(await answer("yes", () => {}, undefined, never), { outcome: "none" });
});

test("timeouts per kind; the message has no header or footer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  sent.length = 0;
  let chatDone = false;
  let bgDone = false;
  const chat = askTs(false, 1401).then((d) => ((chatDone = true), d));
  const bg = askTs(true, 1402).then((d) => ((bgDone = true), d));
  assert.doesNotMatch(sent[0]!, /Approve\?|then I assume no|Reply yes or no/); // the message is the question as written, no header or footer
  t.mock.timers.tick(15 * 60_000 - 1);
  await Promise.resolve();
  assert.equal(chatDone, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await chat, { approved: false });
  assert.equal(bgDone, false);
  assert.equal(answerReaction("👍", 1401), "ignored"); // expired
  t.mock.timers.tick(105 * 60_000 - 1);
  await Promise.resolve();
  assert.equal(bgDone, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await bg, { approved: false });
  assert.equal(sent.length, 2); // nothing extra sent on expiry
});

test("aborting a chat turn declines only its own approval", async () => {
  const ac = new AbortController();
  const a = askTs(false, 1501, "x", ac.signal);
  const b = askTs(false, 1502);
  await settle();
  ac.abort();
  assert.deepEqual(await a, { approved: false });
  assert.equal(answerReaction("👍", 1502), "approved");
  assert.deepEqual(await b, { approved: true });
});

test("formatWait", () => {
  assert.equal(formatWait(15), "15 min");
  assert.equal(formatWait(120), "2 h");
  assert.equal(formatWait(90), "1 h 30 min");
});
