import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, readAudit, type AuditEntry } from "../src/audit.ts";

const isTriage = (e: AuditEntry) => e.source === "heartbeat" && e.tool === "heartbeat_triage"; // (any rows with a tool name: what the substring pre-filter is for)

test("audit: the substring pre-filter gives the same rows as parsing every line", () => {
  audit("heartbeat_triage", "archived", "heartbeat", { id: "c-prefilter", subject: "A" });
  audit("mcp__x__get", "allow", "chat");
  audit("heartbeat_triage", "kept", "heartbeat", { id: "c-prefilter", subject: "B" });
  const all = readAudit((e) => isTriage(e) && e.meta?.id === "c-prefilter");
  const fast = readAudit((e) => isTriage(e) && e.meta?.id === "c-prefilter", '"tool":"heartbeat_triage"');
  assert.equal(all.length, 2);
  assert.deepEqual(fast, all);
});
