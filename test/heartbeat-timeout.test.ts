import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./util.ts";
import { RunTimeout, withCeiling } from "../src/run/ceiling.ts";
import { runAgent } from "../src/run/agentrun.ts";
import { lookOptions } from "../src/run/agent.ts";
import { expertSetup } from "../src/run/delegation.ts";
import { loadSettings, settings } from "../src/core/settings.ts";
import { owner } from "../src/conversation/conversation.ts";
import { LOGIN } from "../src/tenants/payer.ts";
import { OWNER_LOOK } from "./runkinds.ts";

// A heartbeat look is a short job (HEARTBEAT_TIMEOUT_MINUTES, 10) and an expert it delegates to gets EXPERT_TIMEOUT_MINUTES (20) in all; the run is aborted at the ceiling.

const never = () => new Promise<never>(() => {});
const mutable = settings as { heartbeatTimeoutMinutes: number; expertTimeoutMinutes: number };
const result = { type: "result", subtype: "success", is_error: false, result: "hi", session_id: "s", total_cost_usd: 0 };
const no = async () => ({ approved: false });

test("settings: a look is cut at 10 minutes, an expert's look at 20, both overridable and validated", () => {
  const s = loadSettings({});
  assert.deepEqual([s.heartbeatTimeoutMinutes, s.expertTimeoutMinutes], [10, 20]);
  const o = loadSettings({ HEARTBEAT_TIMEOUT_MINUTES: "5", EXPERT_TIMEOUT_MINUTES: "30" });
  assert.deepEqual([o.heartbeatTimeoutMinutes, o.expertTimeoutMinutes], [5, 30]);
  assert.throws(() => loadSettings({ HEARTBEAT_TIMEOUT_MINUTES: "0" }), /HEARTBEAT_TIMEOUT_MINUTES/);
});

test("the heartbeat run's options carry both limits", () => {
  const o = lookOptions(owner(), LOGIN);
  assert.deepEqual([o.maxMinutes, o.expertMaxMinutes], [settings.heartbeatTimeoutMinutes, settings.expertTimeoutMinutes]);
});

test("ceiling: extend() makes the allowance longer, never shorter, also while paused, and not once it has fired", async () => {
  const r = await withCeiling(60, async (c) => {
    await sleep(30);
    c.extend(300);
    c.extend(10); // smaller: ignored
    await sleep(120);
    return "ok";
  });
  assert.equal(r, "ok");
  await assert.rejects(withCeiling(60, async (c) => (c.extend(100), never())), (e: Error) => e instanceof RunTimeout && e.minutes < 0.01);
  const paused = await withCeiling(60, async (c) => {
    const resume = c.pause();
    c.extend(250);
    await sleep(100);
    resume();
    await sleep(100);
    return "ok";
  });
  assert.equal(paused, "ok");
});

test("a look that hangs is aborted at its ceiling (the query is stopped); one that delegates to an expert gets the longer allowance", async () => {
  const was = { ...mutable };
  try {
    const base = { kind: OWNER_LOOK, systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1, maxMinutes: 0.001, expertMaxMinutes: 0.01 } as const; // 60 ms, 600 ms
    let aborted = false;
    const hung = ((p: any) => (p.options.abortController.signal.addEventListener("abort", () => (aborted = true)), (async function* () { await never(); })())) as any;
    await assert.rejects(runAgent("p", no, base, { query: hung }), (e: Error) => e instanceof RunTimeout);
    assert.equal(aborted, true);

    const delegating = (settle: number) => ((p: any) => (async function* () {
      const hook = p.options.hooks.PreToolUse?.[0].hooks[0] ?? (async () => ({}));
      await hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "expert", prompt: "brief" } }, undefined, { signal: new AbortController().signal });
      await sleep(settle);
      yield result;
    })()) as any;
    const withExperts = { ...base, experts: { setup: expertSetup([], "") } };
    assert.equal((await runAgent("p", no, withExperts, { query: delegating(200) })).text, "hi", "200 ms is past the look's 60 ms but inside the expert's 600 ms");
    await assert.rejects(runAgent("p", no, withExperts, { query: delegating(900) }), RunTimeout);
    await assert.rejects(runAgent("p", no, base, { query: delegating(200) }), RunTimeout); // without a delegation the short limit holds
  } finally {
    Object.assign(mutable, was);
  }
});
