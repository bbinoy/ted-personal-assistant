import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Verdict } from "../src/autojudge.ts";
import { failureCount, makeCanUseTool } from "../src/permissions.ts";

// The anti-repeat state of permissions.ts ("already done", failed asks) is kept per conversation.

const CAL = "mcp__claude_ai_Google_Calendar__create_event";
const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; message?: string };
const noJudge = async (): Promise<Verdict> => ({ decision: "ask", reason: "test" });

test("an approved call is 'already done' only in the conversation that approved it; another conversation's identical call is its own", async () => {
  const call = { summary: "Dinner-per-conversation", startTime: "2026-10-20T19:00:00" };
  let asked = 0;
  const mk = (conversation: string) => makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined, noJudge, undefined, undefined, false, { conversation });
  const a = mk("conv-a");
  const b = mk("conv-b");
  assert.equal(((await a(CAL, call, opts)) as Out).behavior, "allow");
  assert.equal(((await a(CAL, call, opts)) as Out).behavior, "deny", "the same conversation: already done");
  assert.equal(((await b(CAL, call, opts)) as Out).behavior, "allow", "another conversation: its own question, no 'already approved' told to its model");
  assert.equal(asked, 2);
  assert.match(((await b(CAL, call, opts)) as Out).message ?? "", /already approved and done/);
});

test("failed asks are counted per conversation and pruned with time", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const call = { summary: "Failing-per-conversation", startTime: "2026-10-21T19:00:00" };
    let asked = 0;
    const mk = (conversation: string) => makeCanUseTool(async () => (asked++, { approved: false, failure: "no question could be written" }), "chat", undefined, noJudge, undefined, undefined, false, { conversation });
    const a = mk("fail-a");
    for (let i = 0; i < 2; i++) assert.match(((await a(CAL, call, opts)) as Out).message ?? "", /could not be confirmed/);
    assert.match(((await a(CAL, call, opts)) as Out).message ?? "", /failed 2 times, so it is not asked again/);
    assert.equal(asked, 2);
    assert.match(((await mk("fail-b")(CAL, call, opts)) as Out).message ?? "", /could not be confirmed/, "another conversation is still asked");
    const before = failureCount();
    mock.timers.tick(31 * 60_000);
    await mk("fail-c")(CAL, { ...call, summary: "Another" }, opts); // a new failure prunes the old ones
    assert.equal(failureCount(), 1, `the old entries are dropped (there were ${before})`);
  } finally {
    mock.timers.reset();
  }
});
