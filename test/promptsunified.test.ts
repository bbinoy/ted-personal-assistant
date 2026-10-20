import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_DEFAULTS, summarySystem } from "../src/run/persona.ts";
import { PROMPTS } from "../src/core/preset.ts";

// The small models' prompts are the preset's. The participation gate has one default text (a group's); what a conversation does on its own when nobody wrote is the heartbeat run's
// one instruction (test/heartbeatrun.test.ts, test/heartbeatconv.test.ts), not a gate.

test("the gate's default is a group's; no prompt of the preset is left for a triage, a handler or a direct-chat gate", () => {
  assert.deepEqual(Object.keys(GATE_DEFAULTS), ["group"]);
  for (const gone of ["gateDirect", "triage", "handler", "background", "digest"]) assert.ok(!(gone in PROMPTS), gone);
  assert.match(summarySystem(), /^You keep the one-paragraph memory of the older messages of a chat/);
});
