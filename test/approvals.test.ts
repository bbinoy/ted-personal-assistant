import { test } from "node:test";
import assert from "node:assert/strict";
import { tick as settle } from "./util.ts";
import { formatWait } from "../src/approvals/approvals.ts";
import { answer, answerReaction, request } from "./approvalrig.ts";

// ONE answer rule for every question (look or chat turn alike): a quoted reply or a reaction answers it; an unquoted one only if nothing of Ted's came after the question.
const call = { tool: "mcp__mailbird__create_calendar_event", input: { summary: "x" } };
const ask = (ts = 500, o: { typedYes?: boolean; scope?: string } = {}) => request(async () => ts, "Create event x", call, undefined, o);
const never = { judge: async () => assert.fail("the judge must not be called"), recent: () => [] };
const newest = (ts: number | undefined) => ({ ...never, latest: () => ts }); // the timestamp of Ted's last message in the chat

test("an unquoted yes right after the question answers it (normal chat stays smooth)", async () => {
  const d = ask(500);
  await settle();
  assert.deepEqual(await answer("ok", () => {}, undefined, newest(500)), { outcome: "approved" });
  assert.deepEqual(await d, { approved: true });
});

test("an unquoted yes / no does not answer a question that Ted sent something after; a quoted one does, with no judge call", async () => {
  const d = ask(510);
  await settle();
  const later = newest(900); // a reply, a notice or another question went out after it
  assert.deepEqual(await answer("ok", () => {}, undefined, later), { outcome: "none" });
  assert.deepEqual(await answer("Yes!", () => {}, undefined, later), { outcome: "none" });
  assert.deepEqual(await answer("no", () => {}, undefined, later), { outcome: "none" });
  assert.deepEqual(await answer("yes", () => {}, { timestamp: 9999 }, later), { outcome: "none" }); // a quote of some other message
  assert.deepEqual(await answer("Yes!", () => {}, { timestamp: 510 }, later), { outcome: "approved" });
  assert.deepEqual(await d, { approved: true });
});

test("the judge cannot answer a question from an unquoted message either, when Ted spoke after it", async () => {
  const d = ask(520);
  await settle();
  assert.deepEqual(await answer("sure, sounds good, thanks", () => {}, undefined, { judge: async () => assert.fail("the judge must not be called"), recent: () => [], latest: () => 900 }), { outcome: "none" });
  assert.equal(answerReaction("👍", 520), "approved"); // a reaction on it does
  assert.deepEqual(await d, { approved: true });
});

test("a stray typed YES pays only when the payment question is Ted's latest message or is quoted", async () => {
  const d = ask(530, { typedYes: true });
  await settle();
  assert.deepEqual(await answer("YES", () => {}, undefined, newest(900)), { outcome: "none" });
  assert.deepEqual(await answer("YES", () => {}, undefined, newest(530)), { outcome: "approved" }); // (latest, and typed)
  assert.deepEqual(await d, { approved: true });
  const e = ask(531, { typedYes: true });
  await settle();
  assert.deepEqual(await answer("YES", () => {}, { timestamp: 531 }, newest(900)), { outcome: "approved" }); // quoted
  assert.deepEqual(await e, { approved: true });
  const f = ask(532, { typedYes: true });
  await settle();
  assert.deepEqual(await answer("ok", () => {}, { timestamp: 532 }, newest(900)).then((r) => r.outcome), "clarify"); // quoted but not typed: never pays
  assert.equal(answerReaction("👍", 532), "needs_text");
  answerReaction("👎", 532);
  assert.deepEqual(await f, { approved: false });
});

test("a question of another conversation is never answered from this one", async () => {
  const d = ask(540, { scope: "group-a" });
  await settle();
  assert.deepEqual(await answer("yes", () => {}, { timestamp: 540 }, never, { scope: "group-b" }), { outcome: "none" });
  assert.deepEqual(await answer("yes", () => {}, undefined, newest(540), { scope: "group-a" }), { outcome: "approved" });
  assert.deepEqual(await d, { approved: true });
});

test("a reaction on the approval message answers it, however much came after", async () => {
  const d = ask(777);
  await settle();
  assert.equal(answerReaction("👍", 1), "ignored");
  assert.equal(answerReaction("👍", 777), "approved");
  assert.deepEqual(await d, { approved: true });
});

// ---- several open approvals ----
const sent: string[] = [];
const askTs = (_bg: boolean, ts: number, desc = `Create event ${ts}`, signal?: AbortSignal) =>
  request(async (t) => (sent.push(t), ts), desc, call, signal);

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

test("a question lapses after its timeout, a second one too, both SILENTLY; the message has no header or footer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  sent.length = 0;
  let chatDone = false;
  let bgDone = false;
  const chat = askTs(false, 1401).then((d) => ((chatDone = true), d));
  const bg = askTs(true, 1402).then((d) => ((bgDone = true), d));
  assert.doesNotMatch(sent[0]!, /Approve\?|then I assume no|Reply yes or no/); // the message is the question as written, no header or footer
  t.mock.timers.tick(24 * 3_600_000 - 1);
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
  t.mock.timers.tick(24 * 3_600_000);
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
