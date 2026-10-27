import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./util.ts";
import { pausing, RunTimeout, withCeiling } from "../src/run/ceiling.ts";
import { prepare, runConversation } from "../src/run/agent.ts";
import { runAgent } from "../src/run/agentrun.ts";
import { group } from "../src/conversation/conversation.ts";
import { loadSettings, settings } from "../src/core/settings.ts";
import { readAudit } from "../src/core/audit.ts";
import { OWNER_LOOK } from "./runkinds.ts";

const never = () => new Promise<never>(() => {});

// ---- the ceiling ----

test("ceiling: a run that ends in time is returned and leaves no timer", async () => {
  assert.equal(await withCeiling(1000, async () => "done"), "done");
  await assert.rejects(withCeiling(1000, async () => { throw new Error("own"); }), /own/);
});

test("ceiling: a hung run is abandoned at the limit, aborted, and says how long", async () => {
  let signal!: AbortSignal;
  await assert.rejects(withCeiling(30, (c) => ((signal = c.signal), never())), (e: Error) => e instanceof RunTimeout && /^run timed out after 0\.\d+ minutes$/.test(e.message));
  assert.equal(signal.aborted, true);
});

test("ceiling: time spent paused (an approval wait) is not counted", async () => {
  const r = await withCeiling(250, async (c) => {
    await sleep(20);
    const resume = c.pause();
    await sleep(500); // longer than the whole ceiling
    resume();
    resume(); // twice is harmless
    await sleep(10);
    return "ok";
  });
  assert.equal(r, "ok");
  // ...but the time outside the pause still counts
  await assert.rejects(withCeiling(80, async (c) => {
    await pausing(c, () => sleep(200))();
    await never();
  }), RunTimeout);
});

test("settings: the run ceilings default to 40 (chat, groups) and 180 (background) minutes and are validated", () => {
  const s = loadSettings({});
  assert.equal(s.runMaxMinutesChat, 40);
  assert.equal(s.runMaxMinutesBackground, 180);
  assert.equal(loadSettings({ RUN_MAX_MINUTES_CHAT: "10", RUN_MAX_MINUTES_BACKGROUND: "300" }).runMaxMinutesBackground, 300);
  assert.throws(() => loadSettings({ RUN_MAX_MINUTES_CHAT: "0" }), /RUN_MAX_MINUTES_CHAT/);
  assert.throws(() => loadSettings({ RUN_MAX_MINUTES_BACKGROUND: "soon" }), /RUN_MAX_MINUTES_BACKGROUND/);
});

// ---- in the run wrapper ----

const mutable = settings as { runMaxMinutesChat: number; runMaxMinutesBackground: number; warm: boolean };
const result = { type: "result", subtype: "success", is_error: false, result: "hi", session_id: "s", total_cost_usd: 0 };
const ok = (async function* () { yield result; });
const hung = (seen: { aborted?: () => boolean }) => ((p: any) => {
  const ctl: AbortController = p.options.abortController;
  seen.aborted = () => ctl.signal.aborted;
  return (async function* () { await never(); })();
}) as any;
let n = 0;
const gid = () => `ceil-${++n}-0123456789abcdef`;
const build = () => ({ prompt: "p" });

test("run wrapper: a hung group turn times out, aborts the query, is audited, and the next turn runs", async () => {
  const was = mutable.runMaxMinutesChat;
  mutable.runMaxMinutesChat = 0.001; // 60 ms
  try {
    const conv = group(gid());
    const seen: { aborted?: () => boolean } = {};
    await assert.rejects(runConversation(conv, { style: "" }, build, undefined, { query: hung(seen) }), /run timed out after/);
    assert.equal(seen.aborted!(), true);
    assert.ok(readAudit((e) => e.tool === "run" && e.decision === "timeout" && e.source === "group").length >= 1);
    mutable.runMaxMinutesChat = 40;
    assert.equal((await runConversation(conv, { style: "" }, build, undefined, { query: (() => ok()) as any })).text, "hi");
  } finally {
    mutable.runMaxMinutesChat = was;
  }
});

test("run wrapper: a warm process that hangs is closed on timeout, and the conversation keeps no spare from before", async () => {
  const was = { ...mutable };
  mutable.runMaxMinutesChat = 0.001;
  mutable.warm = true;
  try {
    const conv = group(gid());
    const closedQuery: string[] = [];
    const closed: string[] = [];
    const start = (() => Promise.resolve({ query: () => ({ close: () => void closedQuery.push("q"), async *[Symbol.asyncIterator]() { await never(); } }), close: () => void closed.push("w") })) as any;
    prepare(conv, { style: "" }, { start, keep: true });
    await sleep(5);
    const turn = runConversation(conv, { style: "" }, build, undefined, { query: (() => ok()) as any });
    await sleep(5);
    // a spare built while the turn runs (the session is the same, so it would fit) is dropped with the aborted run
    prepare(conv, { style: "" }, { start: (() => Promise.resolve({ query: () => ok(), close: () => void closed.push("spare") })) as any });
    await assert.rejects(turn, /timed out/);
    await sleep(5);
    assert.deepEqual(closedQuery, ["q"]); // the query of the warm process was stopped
    assert.deepEqual(closed, ["spare"]);
    mutable.runMaxMinutesChat = 40;
    assert.equal((await runConversation(conv, { style: "" }, build, undefined, { query: (() => ok()) as any })).text, "hi"); // cold: nothing stale to reuse
  } finally {
    Object.assign(mutable, was);
  }
});

test("run wrapper: a background run has its own limit and its approval wait is not counted", async () => {
  const was = { ...mutable };
  mutable.runMaxMinutesChat = 40;
  mutable.runMaxMinutesBackground = 0.002; // 120 ms
  try {
    const opts = { kind: OWNER_LOOK, systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 } as const;
    // waits 300 ms in a (slow) approval, longer than the whole ceiling, and still finishes
    const slowApproval = ((p: any) => (async function* () {
      await p.options.canUseTool("mcp__x__do", {}, { signal: new AbortController().signal });
      yield result;
    })()) as any;
    const approve = async () => (await sleep(300), { approved: true });
    // classify() asks for an unknown tool, so the approval is reached
    assert.equal((await runAgent("p", approve, opts, { query: slowApproval })).text, "hi");
    // a run that merely hangs is still cut
    await assert.rejects(runAgent("p", approve, opts, { query: hung({}) }), /timed out/);
    assert.ok(readAudit((e) => e.tool === "run" && e.decision === "timeout" && e.source === "background").length >= 1);
  } finally {
    Object.assign(mutable, was);
  }
});
