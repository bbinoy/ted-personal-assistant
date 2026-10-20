import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logFiles, matchLines, searchLogs } from "../src/core/logsearch.ts";

const now = Date.parse("2026-10-13T12:00:00Z");

test("logsearch: every word must match, case-insensitively; old stamped lines drop out of a time window", () => {
  const text = [
    '{"ts":"2026-10-12T08:00:00.000Z","tool":"archive","meta":{"subject":"Anthropic receipt"}}',
    '{"ts":"2026-10-13T11:00:00.000Z","tool":"archive","meta":{"subject":"Anthropic receipt"}}',
    '{"ts":"2026-10-13T11:30:00.000Z","tool":"draft","meta":{"subject":"Lunch"}}',
    "12:33:35.091 undated line about an anthropic thing",
  ].join("\n");
  assert.equal(matchLines(text, { query: "ANTHROPIC receipt" }, now).length, 2);
  assert.equal(matchLines(text, { query: "anthropic", sinceHours: 6 }, now).length, 2); // the 12 Oct line is out, the undated one stays
  assert.equal(matchLines(text, { query: "nothing here" }, now).length, 0);
  assert.equal(matchLines("x".repeat(2000), {}, now)[0]!.length, 501);
});

test("logsearch: log names match loosely, a rotated file comes first, and the limit keeps the newest", () => {
  const dir = mkdtempSync(join(tmpdir(), "ls-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "audit.jsonl"), "new1\nnew2\n");
  writeFileSync(join(dir, "audit.jsonl.1"), "old1\n");
  writeFileSync(join(dir, "voice.jsonl"), "hello\n");
  assert.deepEqual(logFiles(dir, "audit"), ["audit.jsonl.1", "audit.jsonl"]);
  assert.equal(searchLogs(dir, { file: "audit", limit: 2 }), "Showing the last 2 of 3 matching lines.\n[audit.jsonl] new1\n[audit.jsonl] new2");
  assert.equal(searchLogs(dir, { file: "voice", query: "hello" }), "hello");
  assert.match(searchLogs(dir, { file: "nope" }), /No log file matches/);
  assert.equal(searchLogs(dir, { query: "zzz" }), "No matching lines.");
});
