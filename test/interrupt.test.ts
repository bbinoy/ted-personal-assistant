import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defer, sleep, tick } from "./util.ts";

// A message that will be answered and arrives while the same conversation's chat turn runs cuts that turn at the next tool call the model asks for (run/interrupt.ts, intake.ts settle):
// the call is denied (never run) and the turn ends; the message forms the next turn. The owner's chat, a friend's and a group go through the one intake. Nothing is lost or answered
// twice (the message never enters the running turn), a model writing its final answer is not cut, and a call in flight is never cut.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "interrupt-"));

const { settings } = await import("../src/core/settings.ts");
const { createPipeline, group, owner } = await import("../src/conversation/conversation.ts");
const { createOutbound } = await import("../src/conversation/outbound.ts");
const { runConversation } = await import("../src/run/agent.ts");
const { chatTurn } = await import("../src/run/chattail.ts");
const { CUT_DENIED, CUT_FACT, forgetCutShort, interruptTurn, takeCutShort, watchTurn } = await import("../src/run/interrupt.ts");
const { writeSession } = await import("../src/run/sessionstore.ts");
const { FULL_CAPABILITIES } = await import("@ted-assistant/messenger/testing");

(settings as unknown as { warm: boolean }).warm = false;

const usage = { input_tokens: 1, output_tokens: 1 };
const call = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "x", input: {} }], usage }, parent_tool_use_id: null }) as never;
const back = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, parent_tool_use_id: null }) as never;

test("the cut is made at the next tool call: not before a request, not twice, not for a subagent's call", async () => {
  const w = watchTurn("k-basic", true, 0);
  assert.equal(await w.cutAt("a"), false, "nobody asked");
  w.ask(1);
  assert.equal(await w.cutAt("sub", "agent-1"), false, "a subagent's own call is not the main loop's");
  assert.equal(await w.cutAt("a"), true);
  assert.equal(await w.cutAt("b"), true, "once cut, every further call of the closing turn is denied too");
  assert.equal(await w.cutAt("sub", "agent-1"), false);
  w.end();
});

test("a call in flight is never cut: an open approval, a payment or a browse step is a call that has not returned", async () => {
  const w = watchTurn("k-flight", true, 0);
  w.see(call("a")); // e.g. waiting for the answer to a question
  w.ask(1);
  w.see(call("b")); // the model asks for another call meanwhile
  assert.equal(await w.cutAt("b"), false, "a is still out");
  w.see(back("a"));
  assert.equal(await w.cutAt("b"), true, "a has returned and nothing else is out: this call is the cut");
  w.end();
});

test("a parallel call that comes into the stream during the pause stops the cut", async () => {
  const w = watchTurn("k-parallel", true, 30);
  w.see(call("a"));
  w.ask(1);
  const cut = w.cutAt("a");
  w.see(call("b"));
  assert.equal(await cut, false);
  w.end();
});

test("a model that never asks for another tool is not cut: its answer is delivered and the message is the next turn", async () => {
  const w = watchTurn("k-answer", true, 0);
  w.see(call("a"));
  w.see(back("a"));
  w.ask(1);
  await sleep(10);
  assert.equal(w.landed, false);
  w.end();
  interruptTurn("k-answer", 2); // the turn is over: nothing to ask
});

test("a turn that began because of a cut is not cut again", async () => {
  const w = watchTurn("k-once", false, 0);
  w.ask(1);
  assert.equal(await w.cutAt("a"), false);
  w.end();
});

test("the cut is ours only after our denial; the denial has no interrupt flag and says it is not a decline", async () => {
  const w = watchTurn("k-marker", true, 0);
  assert.equal(w.landed, false);
  w.ask(1);
  await w.cutAt("a");
  assert.equal(w.landed, true);
  assert.match(CUT_DENIED, /not declined/);
  w.end();
});

test("forgetCutShort: the message that cut the turn was taken back", async () => {
  const w = watchTurn("k-forget", true, 0);
  w.ask(7);
  forgetCutShort("k-forget", [7]); // deleted before the cut was made: no one is waiting
  assert.equal(await w.cutAt("a"), false);
  w.end();
  const v = watchTurn("k-forget2", true, 0);
  v.ask(8);
  assert.equal(await v.cutAt("a"), true);
  v.cut();
  forgetCutShort("k-forget2", [9]);
  assert.equal(takeCutShort("k-forget2"), true, "another message: unchanged");
  v.cut();
  forgetCutShort("k-forget2", [8]);
  assert.equal(takeCutShort("k-forget2"), false, "the cutting message was deleted");
  forgetCutShort("k-forget2");
  v.end();
});

// ---- the whole run path with a fake model process ----

const conv = owner();
const prompts: string[] = [];
const resumes: (string | undefined)[] = [];
const textOf = async (p: any): Promise<string> => (typeof p === "string" ? p : String((await p[Symbol.asyncIterator]().next()).value.message.content));
const result = (subtype: string, text = "") => ({ type: "result", subtype, is_error: subtype !== "success", result: text, session_id: "sess-0", total_cost_usd: 0.01 });
type Opts = { prompt: unknown; options: { resume?: string; canUseTool: (t: string, i: object, o: { signal: AbortSignal; toolUseID: string; agentID?: string }) => Promise<{ behavior: string; message?: string; interrupt?: boolean }> } };
const ask = (o: Opts, id: string, agentID?: string) => o.options.canUseTool("mcp__claude_ai_Google_Calendar__list_events", {}, { signal: new AbortController().signal, toolUseID: id, agentID });

test("run path: the denied call ends the turn with no reply, the session is kept, and the next turn is told it was cut short", async () => {
  writeSession(conv.convId, { sessionId: "sess-0", costUsd: 0 });
  const toolRunning = defer<void>();
  const seen: { denial?: Awaited<ReturnType<typeof ask>> } = {};
  const first = ((o: Opts) => (async function* () {
    prompts.push(await textOf(o.prompt));
    resumes.push(o.options.resume);
    yield call("t1");
    await toolRunning.promise;
    yield back("t1");
    yield call("t2");
    seen.denial = await ask(o, "t2");
    yield result("success", "I will stop here.");
  })()) as never;
  const turn = runConversation(conv, {}, chatTurn(conv, { prompt: "find a slot" }), undefined, { query: first });
  await tick();
  interruptTurn(conv.key, 11); // a message arrived for the conversation
  await tick();
  assert.equal(seen.denial, undefined, "the call is still running: nothing is cut");
  toolRunning.resolve();
  const reply = await turn;
  assert.deepEqual([(seen as typeof seen).denial?.behavior, (seen as typeof seen).denial?.interrupt, (seen as typeof seen).denial?.message], ["deny", undefined, CUT_DENIED]);
  assert.equal(reply.text, "", "nothing is said for the cut turn: the closing text is dropped");

  let again: string | undefined;
  const second = ((o: Opts) => (async function* () {
    prompts.push(await textOf(o.prompt));
    resumes.push(o.options.resume);
    interruptTurn(conv.key, 12); // another message arrives during the turn the first one made
    yield call("t3");
    again = (await ask(o, "t3")).behavior;
    yield result("success", "done");
  })()) as never;
  const next = await runConversation(conv, {}, chatTurn(conv, { prompt: "also: only after 18:00" }), undefined, { query: second });
  assert.equal(next.text, "done");
  assert.notEqual(again, "deny", "a turn that began because of a cut is not cut again: later messages queue");
  assert.ok(!prompts[0]!.includes(CUT_FACT));
  assert.ok(prompts[1]!.includes(CUT_FACT) && prompts[1]!.includes("also: only after 18:00"), "the fact and the message");
  assert.ok(prompts[1]!.indexOf(CUT_FACT) < prompts[1]!.indexOf("also: only after 18:00"));
  assert.deepEqual(resumes, ["sess-0", "sess-0"], "the same session");

  const third = await runConversation(conv, {}, chatTurn(conv, { prompt: "thanks" }), undefined, { query: ((o: Opts) => (async function* () { prompts.push(await textOf(o.prompt)); yield result("success", "done"); })()) as never });
  assert.equal(third.text, "done");
  assert.ok(!prompts[2]!.includes(CUT_FACT), "told once");
});

test("run path: a turn that finishes its answer is an ordinary turn, and the next one is not told anything", async () => {
  const q = ((o: Opts) => (async function* () { yield call("t1"); await ask(o, "t1"); yield back("t1"); yield result("success", "all done"); })()) as never;
  const turn = runConversation(conv, {}, chatTurn(conv, { prompt: "quick" }), undefined, { query: q });
  await tick();
  interruptTurn(conv.key, 20); // asked while the call runs; the model then only writes its answer
  assert.equal((await turn).text, "all done");
  assert.equal(takeCutShort(conv.key), false);
});

test("run path: an error in that window that is not our cut is still a failure", async () => {
  const q = ((o: Opts) => (async function* () { yield call("t1"); await ask(o, "t1"); yield back("t1"); yield call("t2"); await ask(o, "t2"); yield result("error_during_execution"); })()) as never;
  const turn = runConversation(conv, {}, chatTurn(conv, { prompt: "x" }), undefined, { query: q });
  const outcome = turn.then(() => undefined, (e: Error) => e);
  await tick();
  interruptTurn(conv.key, 30);
  assert.ok(await outcome);
  assert.equal(takeCutShort(conv.key), false);
});

// ---- the intake: which messages cut a running turn ----

const OWNER = "+10000000000";
const EVE = "+15555550114";
const BOB = "+15555550105";
const GID = "ZmFrZS1ncm91cC1pbnRlcnJ1cHQ=";
function rig(acts: boolean[] = []) { // acts: the gate's answers for the messages it is asked about, in order; then no
  const messenger = {
    name: "fake",
    summary: "fake",
    self: "+10000000001",
    capabilities: FULL_CAPABILITIES,
    react: async () => {},
    typing: async () => {},
    markRead: async () => {},
    send: async () => 1,
  };
  const record = () => {};
  const runs: string[] = [];
  const stops: string[] = [];
  const hold = defer<void>();
  let n = 0;
  // A turn as agent.ts runs it, minus the model: registered as the conversation's chat turn, it asks for a tool call over and over until it is cut or released.
  const fakeTurn = async (key: string, text: string, tag: string) => {
    runs.push(`${tag}: ${text}`);
    if (n++ > 0) return;
    const w = watchTurn(key, true, 0);
    for (let i = 0; i < 200; i++) {
      w.see(call(`c${i}`));
      if (await w.cutAt(`c${i}`)) return void (stops.push(tag), w.end());
      w.see(back(`c${i}`));
      if (await Promise.race([hold.promise.then(() => true), sleep(2).then(() => false)])) break;
    }
    w.end();
  };
  const pipeline = createPipeline({
    messenger,
    out: createOutbound(messenger, record, { pauseMs: 0 }),
    record,
    run: async (c, prompt) => (await fakeTurn(c.key, prompt, "owner"), { text: "" }),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => "",
    speech: { ready: () => false, synth: async () => assert.fail("no speech"), foreign: async () => undefined },
    approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: (w) => w.from === OWNER,
    group: { recent: () => [], context: () => ({ lines: [] }), warm: () => {}, gate: async () => ({ act: acts.shift() ?? false, delaySeconds: 0, nextCheckMinutes: 30 }), run: async (build, { conv: c }) => (await fakeTurn(c.key, build().prompt, "group"), "") },
    wait: async () => {},
  });
  const say = (text: string, timestamp: number) => pipeline.handleIncoming(owner(), { type: "message", m: { from: OWNER, text, timestamp, direct: true } });
  const chat = (from: string, text: string, timestamp: number, addressedToMe: boolean) => pipeline.handleIncoming(group(GID), { type: "message", m: { from, text, timestamp, direct: false, group: { id: GID }, addressedToMe } });
  const cheer = (from: string) => pipeline.handleIncoming(group(GID), { type: "reaction", r: { from, emoji: "👍", targetTimestamp: 1, isRemove: false, direct: false, group: { id: GID } } });
  return { say, chat, cheer, pipeline, runs, stops, release: hold.resolve };
}

test("intake: a message for the owner's chat cuts the running turn, and makes the next turn alone", async () => {
  const r = rig();
  const first = r.say("plan the trip", 1_001);
  await tick();
  const second = r.say("also: only after 18:00", 1_002);
  await Promise.all([first, second]);
  assert.deepEqual(r.stops, ["owner"]);
  assert.equal(r.runs.length, 2);
  assert.ok(r.runs[0]!.endsWith("plan the trip") && r.runs[1]!.endsWith("also: only after 18:00"), "the message is in the next turn only");
});

test("intake: a message that arrives after the turn has ended is an ordinary next turn", async () => {
  const r = rig();
  const first = r.say("plan the trip", 2_001);
  await tick();
  r.release();
  await first;
  await r.say("thanks", 2_002);
  assert.deepEqual(r.stops, [], "nothing to cut");
  assert.equal(r.runs.length, 2);
});

test("intake: a burst of messages cuts the turn once and forms one next turn", async () => {
  const r = rig();
  const first = r.say("plan the trip", 3_001);
  await tick();
  await Promise.all([first, r.say("a", 3_002), r.say("b", 3_003)]);
  assert.deepEqual(r.stops, ["owner"]);
  assert.equal(r.runs.length, 2);
  assert.ok(r.runs[1]!.includes("a") && r.runs[1]!.includes("b"));
});

test("intake groups: chatter the gate leaves alone, a reaction and another member's message do not cut; the asker's own do", async () => {
  const quiet = rig([true]);
  const first = quiet.chat(EVE, "plan the trip, someone", 4_001, false);
  await tick();
  await quiet.chat(EVE, "so who brings the ball", 4_002, false);
  assert.deepEqual(quiet.stops, [], "the gate said no: nobody is waiting for an answer");
  await quiet.cheer(EVE);
  assert.deepEqual(quiet.stops, [], "a reaction never cuts");
  await quiet.chat(BOB, "@Ted what about me", 4_003, true);
  assert.deepEqual(quiet.stops, [], "someone else's message waits its turn");
  quiet.release();
  await first;

  const same = rig();
  const turn = same.chat(EVE, "@Ted plan the trip", 4_101, true);
  await tick();
  await Promise.all([turn, same.chat(EVE, "@Ted and book it", 4_102, true)]);
  assert.deepEqual(same.stops, ["group"], "the person the turn is answering: the same rule as the owner's chat");
  assert.equal(same.runs.length, 2);
});

test("intake: a turn with no real message in it (a continuation) does not carry the cut fact", async () => {
  const r = rig();
  const key = owner().key;
  const v = watchTurn(key, true, 0);
  v.ask(5);
  await v.cutAt("a");
  v.cut();
  v.end();
  await r.pipeline.continuation(owner(), "the call you proposed was approved");
  assert.equal(takeCutShort(key), false, "dropped: the turn had no message in it");
});
