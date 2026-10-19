import test from "node:test";
import assert from "node:assert/strict";
import { publicArgs } from "../src/permissions.ts";

test("audit: public lookups log their inputs, nothing else does", () => {
  assert.deepEqual(publicArgs("mcp__weather__get_forecast", { lat: 36.1, lon: -5.6, days: 3, models: ["x"] }), { args: { lat: 36.1, lon: -5.6, days: 3 } });
  assert.deepEqual(publicArgs("WebSearch", { query: "imsouane swell" }), { args: { query: "imsouane swell" } });
  assert.equal(publicArgs("mcp__mailbird__get_message", { messageId: 1, body: "secret" }), undefined);
  assert.equal(publicArgs("mcp__browser__browser_type", { text: "4111" }), undefined);
  assert.equal(publicArgs("WebSearch", {}), undefined);
  assert.equal(String((publicArgs("WebSearch", { query: "x".repeat(900) })!.args as Record<string, unknown>).query).length, 300);
});
