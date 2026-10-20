import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptions } from "../src/run/agentrun.ts";
import { createdFact, forgetCreated } from "../src/approvals/created.ts";

const MB = "mcp__mailbird__";
const signal = new AbortController().signal;

test("the run records what the assistant creates (PostToolUse), under the run's conversation, and nothing an update touched", async () => {
  forgetCreated();
  const o = buildOptions(async () => ({ approved: false }), { source: "chat", systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1, conversation: "c-hook" } as never, undefined);
  const hook = o.hooks!.PostToolUse![0]!.hooks[0]!;
  const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
  await hook({ hook_event_name: "PostToolUse", tool_name: `${MB}create_draft`, tool_input: { to: "a@example.org" }, tool_response: text({ messageId: 4711 }) } as never, undefined, { signal });
  await hook({ hook_event_name: "PostToolUse", tool_name: `${MB}update_draft`, tool_input: {}, tool_response: text({ messageId: 9 }) } as never, undefined, { signal });
  assert.equal(createdFact("c-hook", { messageId: 4711 }), "yes");
  assert.equal(createdFact("c-hook", { messageId: 9 }), "no", "an update made nothing");
  assert.equal(createdFact("owner", { messageId: 4711 }), "no", "another conversation");
  forgetCreated();
});
