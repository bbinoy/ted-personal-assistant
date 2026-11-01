import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defer, sleep, tick } from "./util.ts";

// A message that arrives while the same conversation's chat turn runs stops that turn at its next tool boundary and forms the next turn at once (run/interrupt.ts, intake.ts settle): the
// owner's chat, a friend's and a group through the one intake. Nothing is lost or answered twice (the message never enters the running turn), and a turn never stops with a call in flight.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "interrupt-"));

const { settings } = await import("../src/core/settings.ts");
const { createPipeline, group, owner } = await import("../src/conversation/conversation.ts");
const { createOutbound } = await import("../src/conversation/outbound.ts");
const { runConversation } = await import("../src/run/agent.ts");
const { chatTurn } = await import("../src/run/chattail.ts");
const { CUT_FACT, interruptTurn, takeCutShort, watchTurn } = await import("../src/run/interrupt.ts");
const { writeSession } = await import("../src/run/sessionstore.ts");
const { FULL_CAPABILITIES } = await import("@ted-assistant/messenger/testing");

(settings as unknown as { warm: boolean }).warm = false;

const usage = { input_tokens: 1, output_tokens: 1 };
const call = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "x", input: {} }], usage }, parent_tool_use_id: null }) as never;
const back = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, parent_tool_use_id: null }) as never;
const thought = { type: "assistant", message: { content: [{ type: "text", text: "hm" }], usage }, parent_tool_use_id: null } as never;

test("a stop is asked for at once but happens only at a tool boundary: never with a call in flight", async () => {
  let stops = 0;
  const w = watchTurn("k-boundary", 0);
  w.attach({ interrupt: async () => void stops++ });
  w.see(call("a")); // a call in flight (an approval question, a payment step or a browse run is exactly such a call)
  w.ask();
  await sleep(10);
  assert.equal(stops, 0, "the call has not returned");
  w.see(call("b")); // a parallel call
  w.see(back("a"));
  await sleep(10);
  assert.equal(stops, 0, "one call is still out");
  w.see({ type: "assistant", message: { content: [{ type: "tool_use", id: "inner", name: "x" }] }, parent_tool_use_id: "b" } as never); // a subagent's own calls are inside its call
  w.see(back("b"));
  await sleep(10);
  assert.equal(stops, 1, "every call has returned: the model is about to be asked what next");
  w.see(back("zz"));
  w.ask();
  await sleep(10);
  assert.equal(stops, 1, "only once");
  w.end();
});

test("a stop is not made while the model is working on its next step, and a call that starts in the pause cancels it", async () => {
  let stops = 0;
  const w = watchTurn("k-pause", 20);
  w.attach({ interrupt: async () => void stops++ });
  w.see(call("a"));
  w.see(thought);
  w.ask();
  await sleep(40);
  assert.equal(stops, 0, "the model is generating, no call has returned");
  w.see(back("a"));
  w.see(call("b")); // a parallel call named just after the first result
  await sleep(40);
  assert.equal(stops, 0, "something new started in the pause");
  w.see(back("b"));
  await sleep(40);
  assert.equal(stops, 1);
  w.end();
});

test("a request made when the turn is already at a boundary stops it; one made before the query exists waits for it", async () => {
  let stops = 0;
  const w = watchTurn("k-late", 0);
  w.ask();
  w.attach({ interrupt: async () => void stops++ });
  await sleep(10);
  assert.equal(stops, 0, "nothing has happened yet in this turn");
  w.see(call("a"));
  w.see(back("a"));
  await sleep(10);
  assert.equal(stops, 1);
  w.end();
  interruptTurn("k-late"); // the turn is over: nothing to ask
  await sleep(10);
  assert.equal(stops, 1);
});

// ---- the whole run path with a fake model process ----

const conv = owner();
const prompts: string[] = [];
const resumes: (string | undefined)[] = [];
const textOf = async (p: any): Promise<string> => (typeof p === "string" ? p : String((await p[Symbol.asyncIterator]().next()).value.message.content));
const result = (subtype: string, text = "") => ({ type: "result", subtype, is_error: subtype !== "success", result: text, session_id: "sess-0", total_cost_usd: 0.01 });

test("run path: the turn ends at the boundary with no reply, the session is kept, and the next turn is told it was cut short", async () => {
  writeSession(conv.convId, { sessionId: "sess-0", costUsd: 0 });
  const toolRunning = defer<void>();
  const stopped = defer<void>();
  let stops = 0;
  const first = ((o: { prompt: unknown; options: { resume?: string } }) => {
    const gen = (async function* () {
      prompts.push(await textOf(o.prompt));
      resumes.push(o.options.resume);
      yield call("t1");
      await toolRunning.promise;
      yield back("t1");
      await stopped.promise;
      yield result("error_during_execution");
    })();
    return Object.assign(gen, { interrupt: async () => (stops++, stopped.resolve()) });
  }) as never;
  const turn = runConversation(conv, {}, chatTurn(conv, { prompt: "find a slot" }), undefined, { query: first });
  await tick();
  interruptTurn(conv.key); // a message arrived for the conversation
  await tick();
  assert.equal(stops, 0, "the call is still running");
  toolRunning.resolve();
  const reply = await turn;
  assert.equal(stops, 1);
  assert.equal(reply.text, "", "nothing is said for the cut turn");

  const second = ((o: { prompt: unknown; options: { resume?: string } }) => {
    const gen = (async function* () {
      prompts.push(await textOf(o.prompt));
      resumes.push(o.options.resume);
      yield result("success", "done");
    })();
    return gen;
  }) as never;
  const next = await runConversation(conv, {}, chatTurn(conv, { prompt: "also: only after 18:00" }), undefined, { query: second });
  assert.equal(next.text, "done");
  assert.ok(!prompts[0]!.includes(CUT_FACT));
  assert.ok(prompts[1]!.includes(CUT_FACT) && prompts[1]!.includes("also: only after 18:00"), "the fact and the message");
  assert.ok(prompts[1]!.indexOf(CUT_FACT) < prompts[1]!.indexOf("also: only after 18:00"));
  assert.deepEqual(resumes, ["sess-0", "sess-0"], "the same session");

  const third = await runConversation(conv, {}, chatTurn(conv, { prompt: "thanks" }), undefined, { query: second });
  assert.equal(third.text, "done");
  assert.ok(!prompts[2]!.includes(CUT_FACT), "told once");
});

test("run path: a turn that finishes before the stop lands is an ordinary turn, and the next one is not told anything", async () => {
  const q = (() => Object.assign((async function* () { yield call("t1"); yield result("success", "all done"); })(), { interrupt: async () => {} })) as never;
  const turn = runConversation(conv, {}, chatTurn(conv, { prompt: "quick" }), undefined, { query: q });
  await tick();
  interruptTurn(conv.key);
  assert.equal((await turn).text, "all done");
  assert.equal(takeCutShort(conv.key), false);
  interruptTurn(conv.key); // nobody is running
});

test("run path: an error that is not our stop is still a failure", async () => {
  const q = (() => Object.assign((async function* () { yield result("error_during_execution"); })(), { interrupt: async () => {} })) as never;
  await assert.rejects(runConversation(conv, {}, chatTurn(conv, { prompt: "x" }), undefined, { query: q }));
  assert.equal(takeCutShort(conv.key), false);
});

// ---- the intake: which messages stop a running turn ----

const OWNER = "+10000000000";
const GID = "ZmFrZS1ncm91cC1pbnRlcnJ1cHQ=";
function rig(acts: boolean[] = []) { // the gate's answers for the messages it is asked about, in order; then no
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
  // A turn as agent.ts runs it, minus the model: registered as the conversation's chat turn, at a tool boundary, held until it is stopped or released.
  const fakeTurn = async (key: string, text: string, tag: string) => {
    runs.push(`${tag}: ${text}`);
    const w = watchTurn(key, 0);
    const stopped = defer<void>();
    w.attach({ interrupt: async () => (stops.push(tag), stopped.resolve()) });
    w.see(call("a"));
    w.see(back("a"));
    if (n++ === 0) await Promise.race([hold.promise, stopped.promise]);
    w.end();
    return stopped;
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
  const chat = (text: string, timestamp: number, addressedToMe: boolean) => pipeline.handleIncoming(group(GID), { type: "message", m: { from: "+15555550105", text, timestamp, direct: false, group: { id: GID }, addressedToMe } });
  return { say, chat, runs, stops, release: hold.resolve };
}

test("intake: a message for the owner's chat stops the running turn, and makes the next turn alone", async () => {
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
  assert.deepEqual(r.stops, [], "nothing to stop");
  assert.equal(r.runs.length, 2);
});

test("intake: a burst of messages stops the turn once and forms one next turn", async () => {
  const r = rig();
  const first = r.say("plan the trip", 3_001);
  await tick();
  await Promise.all([first, r.say("a", 3_002), r.say("b", 3_003)]);
  assert.deepEqual(r.stops, ["owner"]);
  assert.equal(r.runs.length, 2);
  assert.ok(r.runs[1]!.includes("a") && r.runs[1]!.includes("b"));
});

test("intake: group chatter the gate leaves alone does not stop a group's turn; a message for us does", async () => {
  const quiet = rig([true]);
  const first = quiet.chat("plan the trip, someone", 4_001, false);
  await tick();
  await quiet.chat("so who brings the ball", 4_002, false);
  assert.deepEqual(quiet.stops, [], "the gate said no: nobody is waiting for an answer");
  quiet.release();
  await first;

  const loud = rig();
  const turn = loud.chat("@Ted plan the trip", 4_101, true);
  await tick();
  await Promise.all([turn, loud.chat("@Ted and book it", 4_102, true)]);
  assert.deepEqual(loud.stops, ["group"], "addressed to us: the same rule as the owner's chat");
  assert.equal(loud.runs.length, 2);
});
