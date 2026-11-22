import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The one throttle ("told at most once per key per interval") is remembered in the told table of instance.db, so a restart does not repeat a notice; the shared key's problem reaches the owner
// as a FACT for her next run (never a fixed chat line) once per interval.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "noticepersist-"));

const { reportKeyProblem } = await import("../src/tenants/keynotice.ts");
const { owner } = await import("../src/conversation/conversationmodel.ts");
const { heldPosts, resetHeld } = await import("../src/heartbeat/notices.ts");

test("key notice: a restart within the interval stays quiet; after it, a fact again; a different problem is its own", () => {
  resetHeld(owner());
  const t0 = Date.now();
  const every = 180 * 60_000; // the key notice interval, three hours
  assert.equal(reportKeyProblem("refused", t0), true);
  // (a restart changes nothing: the marks are in the database, not in memory)
  assert.equal(reportKeyProblem("refused", t0 + 3_600_000), false, "no repeat after a restart");
  assert.equal(reportKeyProblem("missing", t0 + 3_600_000), true);
  assert.equal(reportKeyProblem("refused", t0 + every + 1), true, "after the interval it speaks again");
  const held = heldPosts(owner()).map((h) => h.text);
  assert.equal(held.length, 2, "the refused fact is held once while it waits");
  assert.match(held[0]!, /^System status for .*TENANT_ANTHROPIC_API_KEY/, "a fact for the owner's next run, to say in her own words");
});
