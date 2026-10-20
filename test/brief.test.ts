import { test } from "node:test";
import assert from "node:assert/strict";
import { clockLine } from "../src/brief.ts";
import { localDay } from "../src/pause.ts";
import { readTriageSince } from "../src/digest.ts";
import { audit } from "../src/audit.ts";
import { sleep } from "./util.ts";
const at = (iso: string) => new Date(iso); // local time, no zone suffix

test("clock line: exact weekday and date pairs", () => {
  const line = clockLine(at("2026-10-11T09:30:00"));
  assert.match(line, /it is now Sunday 2026-10-11 09:30/);
  assert.match(line, /Yesterday was Saturday 2026-10-10/);
  assert.match(line, /Tomorrow is Monday 2026-10-12/);
  assert.match(line, /day after is Tuesday 2026-10-13/);
});

test("clock line: month and year rollover", () => {
  const line = clockLine(at("2026-12-31T08:00:00"));
  assert.match(line, /Tomorrow is Friday 2027-01-01/);
  assert.equal(localDay(at("2026-01-05T00:00:00")), "2026-01-05");
});

test("triage rows since the cut-off are read from the audit log, and other rows are not", async () => {
  audit("heartbeat_triage", "archived", "heartbeat", { id: "d-old", label: "archive", from: "Old", subject: "Before" });
  await sleep(5);
  const cut = new Date().toISOString();
  await sleep(5);
  audit("heartbeat_triage", "archived", "heartbeat", { id: "d-new", messageId: 9, label: "archive", kind: "newsletter", from: "Paper", subject: "After", reason: "weekly" });
  audit("mcp__x__get", "allow", "chat", { label: "archive", from: "Chat" });
  const rows = readTriageSince(cut);
  assert.deepEqual(rows.map((r) => r.meta.id), ["d-new"]);
  assert.deepEqual([rows[0]!.meta.from, rows[0]!.meta.subject, rows[0]!.meta.kind], ["Paper", "After", "newsletter"]);
});

