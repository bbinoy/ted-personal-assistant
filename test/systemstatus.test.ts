import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CLAUDE.md §4: system status stays out of the chat. A friend's broken connection is a fact for the owner's next look (not a chat text); an approval that lapsed unanswered in the background reaches the next
// look once.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "systemstatus-"));

const { noticeFor, reportReconnect } = await import("../src/tenants/errors.ts");
const { owner } = await import("../src/conversation/conversationmodel.ts");
const { heldPosts, resetHeld } = await import("../src/heartbeat/notices.ts");
const { factsFor } = await import("../src/heartbeat/facts.ts");
const { closeAllConvDbs } = await import("../src/core/convdb.ts");
const { request } = await import("./approvalrig.ts");

test("a friend's broken connection says nothing in the owner's chat; it is held once per conversation as a fact with no name", () => {
  resetHeld(owner());
  const e = new Error("her Google permission expired or was withdrawn");
  assert.equal(noticeFor("owner")(e), undefined);
  assert.equal(noticeFor("friend")(e), "⚠️ Something went wrong, try again.");
  const t0 = Date.now();
  assert.equal(reportReconnect("friend-a", t0), true);
  assert.equal(reportReconnect("friend-a", t0 + 1000), false, "once a day per conversation");
  assert.equal(reportReconnect("friend-b", t0), true);
  const held = heldPosts(owner()).map((h) => h.text);
  assert.equal(held.length, 1, "the same fact is not held twice");
  assert.match(held[0]!, /^System status for .*reconnect Google/);
  assert.doesNotMatch(held[0]!, /friend-/);
});

test("a background approval that lapsed is told to the next look once, with its age; a chat turn is not handed it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const conv = owner();
  const call = { tool: "mcp__claude_ai_Google_Calendar__create_event", input: { summary: "x" } };
  const asked = request(async () => 7001, "Create event Dentist\nmore details", call, undefined, { background: true });
  t.mock.timers.tick(15 * 60_000);
  assert.equal((await asked).expired, true);
  closeAllConvDbs(); // a restart: the entry is in the file
  const now = new Date(Date.now() + 5 * 60_000);
  assert.ok(!factsFor(conv, now, "chat").status.some((s) => /lapsed unanswered/.test(s)));
  const look = factsFor(conv, now, "look");
  const line = look.status.find((s) => /lapsed unanswered/.test(s));
  assert.ok(line && /Create event Dentist/.test(line) && /no answer within 15 min/.test(line) && /5 min ago/.test(line), String(line));
  assert.doesNotMatch(line ?? "", /more details|7001/);
  assert.ok(!factsFor(conv, now, "look").status.some((s) => /lapsed unanswered/.test(s)), "pending while the first look has it");
  look.done({ ended: false, said: false });
  const retry = factsFor(conv, now, "look");
  assert.ok(retry.status.some((s) => /lapsed unanswered/.test(s)), "a failed look leaves it for the next");
  retry.done({ ended: true, said: false });
  assert.ok(!factsFor(conv, now, "look").status.some((s) => /lapsed unanswered/.test(s)), "told once");
});
