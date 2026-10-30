import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What every run is handed the same way: the turn's cost (never negative), the experts' context, and the lines of the chat a resumed session has not seen.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "runcontext-"));

const { consume } = await import("../src/run/agentrun.ts");
const { runConversation } = await import("../src/run/agent.ts");
const { chatTurn, unseenChat } = await import("../src/run/chattail.ts");
const { owner } = await import("../src/conversation/conversation.ts");
const { readSession, writeSession } = await import("../src/run/sessionstore.ts");
const { recordMessage, ledgerEntries } = await import("../src/core/messages.ts");
const { charge, LOGIN } = await import("../src/tenants/payer.ts");
const { spentToday } = await import("../src/core/budget.ts");
const { forgetShown } = await import("../src/run/turncontext.ts");

const conv = owner();
const result = (session: string, total: number) => ({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: session, total_cost_usd: total });
const stream = (...msgs: object[]) => (async function* () { yield* msgs as never[]; })();
const opts = { kind: { who: "owner" as const, attended: true }, systemPrompt: "x", sessionConv: conv.convId, maxTurns: 1, maxBudgetUsd: 1 };
const bare = (lines: string[]) => lines.map((l) => l.replace(/^\[[^\]]*\] /, ""));

test("a turn's cost: the delta inside one session, the whole total when the session restarted or compacted, never negative", async () => {
  writeSession(conv.convId, { sessionId: "A", costUsd: 5 });
  assert.equal((await consume(stream(result("A", 5.5)), opts, 5)).costUsd, 0.5, "the same session: the delta");
  assert.equal((await consume(stream(result("B", 0.75)), opts, 5.5)).costUsd, 0.75, "a new session id: its total started again from zero");
  assert.equal(readSession(conv.convId).sessionId, "B");
  assert.equal((await consume(stream(result("B", 0.25)), opts, 0.75)).costUsd, 0.25, "a total below the last one: the total");
});

const asst = (id: string, usage: object, model = "m1") => ({ type: "assistant", message: { id, model, content: [], usage } });
const withUsage = (total: number, session = "H") => ({ ...result(session, total), modelUsage: { m1: { inputTokens: 0, outputTokens: 100, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 0, costUSD: total } } });

test("a resumed session whose total carries its history (new id, stored total lost): the turn's own usage is priced, not the total", async () => {
  writeSession(conv.convId, { sessionId: "A", costUsd: 0 });
  // history: 1M cache-read + 100 output = 100500 weighted; this query: 100k cache-read = 10000 weighted, twice in one message id (counted once)
  const spentBefore = spentToday();
  const turn = asst("a1", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100_000 });
  const r = await consume(stream(turn, turn, withUsage(82.5)), { ...opts, maxBudgetUsd: 10 }, 0);
  assert.ok(r.costUsd > 7 && r.costUsd < 9, `about a tenth of the total, got ${r.costUsd}`);
  assert.ok(Math.abs(spentToday() - spentBefore - r.costUsd) < 1e-5, "charge() and the returned cost agree");
});

test("an out-of-range figure with no usage to price is capped, logged and audited", async () => {
  writeSession(conv.convId, { sessionId: "A", costUsd: 0 });
  const before = spentToday();
  const r = await consume(stream(result("A", 82.5)), opts, 0);
  assert.equal(r.costUsd, 1, "the run's budget cap");
  assert.equal(spentToday() - before, 1);
});

test("charge: a negative or empty amount is never recorded", () => {
  const before = spentToday();
  charge(LOGIN, -0.7368);
  charge(LOGIN, Number.NaN);
  assert.equal(spentToday(), before);
  charge(LOGIN, 0.5);
  assert.equal(spentToday(), before + 0.5);
});

test("chat tail: a resumed session gets what other runs posted since it last saw the chat, not its own exchanges; a fresh one the recent chat without this turn's message", () => {
  const file = conv.logFile;
  const T = (m: number) => new Date(Date.UTC(2026, 9, 12, 9, m));
  recordMessage("owner", 1, "first question", T(0), file);
  recordMessage("chat", 2, "first answer", T(1), file);
  recordMessage("owner", 3, "second question", T(2), file);
  const fresh = unseenChat(conv);
  assert.equal(fresh.lines.length, 2, "both directions of the earlier exchange");
  assert.match(fresh.lines[0]!, /first question/);
  assert.match(fresh.lines[1]!, /first answer/);
  const seenAt = fresh.seenAt!;
  recordMessage("chat", 4, "second answer", T(3), file); // this session's own reply
  recordMessage("notice", 5, "Meeting prep: call at 11:00", T(4), file); // another run's post
  recordMessage("owner", 6, "third question", T(5), file);
  const resumed = unseenChat(conv, seenAt);
  assert.equal(resumed.lines.length, 1, "the reply and the person's words are in the session already");
  assert.match(bare(resumed.lines)[0]!, /Meeting prep: call at 11:00$/);
  const built = chatTurn(conv, { prompt: "third question" })(seenAt);
  assert.match(built.prompt, /<chat_log>[\s\S]*Meeting prep[\s\S]*<\/chat_log>\n\nthird question$/);
  assert.equal(built.seenAt, ledgerEntries(file).at(-1)!.at, "stored with the session: the next turn starts after it");
  assert.equal(chatTurn(conv, { prompt: "x" })(built.seenAt).prompt, "x", "nothing new: the message alone");
});

test("the tail is the conversation's own log: another file's lines never appear", () => {
  assert.ok(unseenChat(conv).lines.length > 0);
  assert.deepEqual(unseenChat({ logFile: join(process.env.HARNESS_DATA_DIR!, "nowhere.jsonl"), tenantId: undefined }).lines, []);
});

test("the experts of a chat turn are told the same context as a look's: the clock and the recent chat", async () => {
  forgetShown(conv.convId);
  recordMessage("notice", 10, "Rent is due Friday", new Date(), conv.logFile);
  let hook: any;
  const query = ((p: { options: any }) => (async function* () {
    hook = p.options.hooks.PreToolUse[0].hooks[0];
    yield result("S", 0.01);
  })()) as never;
  await runConversation(conv, { now: new Date("2026-10-12T09:00:00Z") }, () => ({ prompt: "hi" }), undefined, { query });
  const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "expert", prompt: "do it" } }, undefined, { signal: new AbortController().signal });
  const prompt: string = out.hookSpecificOutput.updatedInput.prompt;
  assert.match(prompt, /^do it\n\nCURRENT TIME/);
  assert.match(prompt, /The recent chat:[\s\S]*Rent is due Friday/);
});
