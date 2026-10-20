import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audit, readAudit } from "../src/audit.ts";
import { buildDigest, readTriageSince, triageEntryFor } from "../src/digest.ts";
import { dataPath } from "../src/state.ts";
import { OWNER_TRIAGE, readTriage, recordTriage } from "../src/triagelog.ts";

// ONE triage record: a file per conversation with the words, a wordless row in the audit log; the digest, the report and restore read the file.

const ROW = { id: "c-owner-1", messageId: 7, from: "Carl <carl@example.org>", subject: "Contract for Anna", account: "me@example.com", label: "act_now", kind: "personal_or_work", reason: "a person is waiting", protected: false };

test("the owner's decisions go to state/triage.jsonl; the audit log gets a row without sender, subject, account or reason", () => {
  const before = new Date(Date.now() - 1000).toISOString();
  recordTriage(OWNER_TRIAGE, "alerted", ROW);
  const file = readFileSync(dataPath(OWNER_TRIAGE), "utf8");
  assert.match(file, /Contract for Anna/);
  assert.match(file, /carl@example\.org/);
  const rows = readAudit((e) => e.tool === "heartbeat_triage" && e.meta?.id === "c-owner-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.decision, "alerted");
  assert.deepEqual(rows[0]!.meta, { id: "c-owner-1", messageId: 7, label: "act_now", kind: "personal_or_work", protected: false });
  assert.doesNotMatch(JSON.stringify(rows), /Carl|Contract|example\.org|waiting/);
  // the digest of the brief and the report read the file
  const read = readTriageSince(before);
  assert.deepEqual(read.map((r) => [r.decision, r.meta.from, r.meta.subject]), [["alerted", "Carl <carl@example.org>", "Contract for Anna"]]);
  assert.match(buildDigest(read, before), /Carl <carl@example\.org>: Contract for Anna/);
  assert.equal(triageEntryFor("c-owner-1")?.meta.messageId, 7);
});

test("rows an older version wrote into the audit log (with words) are still read by the digest and restore, and a friend's wordless rows never are", () => {
  const before = new Date(Date.now() - 1000).toISOString();
  audit("heartbeat_triage", "archived", "heartbeat", { id: "c-legacy", label: "archive", kind: "newsletter", from: "Paper", subject: "Old format", reason: "weekly" });
  audit("heartbeat_triage", "kept", "heartbeat", { tenant: "t1", id: "g-1", label: "act_now", kind: "personal_or_work" });
  const rows = readTriageSince(before);
  assert.ok(rows.some((r) => r.meta.id === "c-legacy"));
  assert.ok(!rows.some((r) => r.meta.id === "g-1"), "no sender: not a row of the owner's mail");
  assert.equal(triageEntryFor("c-legacy")?.meta.subject, "Old format");
});

test("the file is cut to its newest lines when it grows", () => {
  const file = "state/triage-rotation.jsonl";
  for (let i = 0; i < 30; i++) recordTriage(file, "kept", { id: `c${i}`, label: "read_later", from: "x", subject: "y".repeat(50) }, { maxBytes: 1000, keep: 5 });
  assert.equal(readTriage(file).at(-1)!.meta.id, "c29");
  assert.ok(readTriage(file).length < 30, "cut to the newest");
});
