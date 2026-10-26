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

test("background approval: a bare yes / no never answers it; a quoted reply does, without a judge call", async () => {
  const d = ask(true, 500);
  await settle();
  assert.deepEqual(await answer("ok", () => {}, undefined, never), { outcome: "none" }); // an "ok" typed for something else
  assert.deepEqual(await answer("Yes!", () => {}, undefined, never), { outcome: "none" });
  assert.deepEqual(await answer("no", () => {}, undefined, never), { outcome: "none" });
  assert.deepEqual(await answer("yes", () => {}, { timestamp: 9999 }, never), { outcome: "none" }); // a quote of some other message
  assert.deepEqual(await answer("Yes!", () => {}, { timestamp: 500 }, never), { outcome: "approved" });
  assert.deepEqual(await d, { approved: true });
  const n = ask(true, 501);
  await settle();
  assert.deepEqual(await answer("no", () => {}, { timestamp: 501 }, never), { outcome: "declined" });
  assert.deepEqual(await n, { approved: false });
});

test("background approval: even the judge cannot answer it from a message that quotes nothing of it", async () => {
  const bg = ask(true, 520);
  const chat = ask(false, 521);
  await settle();
  const offered: string[][] = [];
  const judge = async (_t: string, views: readonly { id: string; question: string }[]) => (offered.push(views.map((v) => v.id)), { target: "A1", outcome: "approve" as const });
  // one chat question is open besides the background one: a plain yes is for the chat one
  assert.deepEqual(await answer("sure", () => {}, undefined, never), { outcome: "approved" });
  assert.deepEqual(await chat, { approved: true });
  // only the background one is left: a longer message is read by the judge, which picks it, and that is not an answer
  assert.deepEqual(await answer("sure, sounds good, thanks", () => {}, undefined, { judge: judge as never, recent: () => [] }), { outcome: "none" });
  assert.deepEqual(offered, [["A1"]]);
  assert.equal(answerReaction("👍", 520), "approved");
  assert.deepEqual(await bg, { approved: true });
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

test("a question lapses after APPROVAL_TIMEOUT_MINUTES, a background one too, both SILENTLY; the message has no header or footer", async (t) => {
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
  assert.deepEqual(await chat, { approved: false, expired: true });
  assert.deepEqual(await bg, { approved: false, expired: true });
  assert.equal(bgDone, true);
  assert.equal(answerReaction("👍", 1401), "ignored"); // expired
  assert.equal(sent.length, 2, "only the two questions: an expiry says nothing in the chat (a journal line, journalconsistency.test.ts)");
});

test("a late yes to a question that timed out is told so, and runs nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const d = askTs(false, 1601);
  for (let k = 0; k < 6; k++) await Promise.resolve(); // (mock timers: settle() would wait on a real timer)
  t.mock.timers.tick(15 * 60_000);
  assert.deepEqual(await d, { approved: false, expired: true });
  const r = await answer("yes", () => {}, { timestamp: 1601 }, never);
  assert.equal(r.outcome, "clarify");
  assert.match(r.reply!, /timed out.*nothing was done.*ask me again/);
  const open = askTs(false, 1602); // another question is open: the late yes still does not touch it
  for (let k = 0; k < 6; k++) await Promise.resolve(); // (mock timers: settle() would wait on a real timer)
  const r2 = await answer("yes", () => {}, { timestamp: 1601 }, { judge: async () => ({ target: "A1", outcome: "other" }), recent: () => [] });
  assert.equal(r2.outcome, "clarify");
  assert.match(r2.reply!, /timed out/);
  assert.equal(answerReaction("👎", 1602), "declined");
  assert.deepEqual(await open, { approved: false });
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
