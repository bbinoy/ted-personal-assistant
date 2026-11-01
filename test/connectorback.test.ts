import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// recordConnectors says which reportable connectors went from down to connected since the last record (agentrun.ts then pulls the owner's next look forward with pullLook,
// tested in checkagain.test.ts). Temporary data folder.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "connectorback-"));

const { recordConnectors } = await import("../src/modules/connectors.ts");

const srv = (notion: string, mail = "connected") => [{ name: "claude.ai Notion", status: notion }, { name: "claude.ai Google Calendar", status: "connected" }, { name: "mailbird", status: mail }];

test("connector back: first record, up -> up and up -> down name nothing; down -> up names the connector", () => {
  assert.deepEqual(recordConnectors([], srv("connected")), []); // first ever record
  assert.deepEqual(recordConnectors([], srv("connected")), []);
  assert.deepEqual(recordConnectors([], srv("needs-auth")), []);
  assert.deepEqual(recordConnectors([], srv("needs-auth")), []);
  assert.deepEqual(recordConnectors([], srv("connected")), ["Notion"]);
  assert.deepEqual(recordConnectors([], srv("connected")), []);
  assert.deepEqual(recordConnectors([], srv("connected", "failed")), []); // the local mail client counts too
  assert.deepEqual(recordConnectors([], srv("connected")), ["mail"]);
});

test("connector back: an offline start-up (every server failed) names nothing", () => {
  const off = [{ name: "claude.ai Notion", status: "failed" }, { name: "claude.ai Google Calendar", status: "failed" }];
  assert.deepEqual(recordConnectors([], off), []);
});
