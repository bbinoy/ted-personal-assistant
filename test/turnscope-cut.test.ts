import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnScope } from "../src/approvals/turnscope.ts";
import { LIMITS } from "../src/core/sanitize.ts";

test("TurnScope: an assistant message cut at the limit ends in a marker; a short one is kept as is", () => {
  const scope = new TurnScope("owner");
  scope.say("send", "x".repeat(LIMITS.quote + 50));
  const said = (scope.read() as { assistantSaid: string }).assistantSaid;
  assert.equal(said, `${"x".repeat(LIMITS.quote)}…`);
  scope.assistantSaid("short draft");
  assert.equal((scope.read() as { assistantSaid: string }).assistantSaid, "short draft");
});
