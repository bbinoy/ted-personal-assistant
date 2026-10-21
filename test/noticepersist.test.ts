import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The notices that repeat after an interval (the shared key's problem, a group's error notice) are remembered in state/cap-notices.json, so a restart does not repeat them.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "noticepersist-"));

const { settings } = await import("../src/core/settings.ts");
const { createKeyNotices } = await import("../src/tenants/keynotice.ts");
const { capNoticeDue, markCapNotice, lastNoticeAt, markNoticeAt } = await import("../src/core/capnotice.ts");

test("key notice: a 'restart' (a new instance) within the interval stays quiet; after it, it speaks; a different problem is its own", () => {
  const every = () => 3 * 3_600_000;
  const t0 = Date.now();
  const told: string[] = [];
  const first = createKeyNotices({ everyMs: every, persist: true });
  first.sendTo((t) => told.push(t));
  assert.equal(first.report("refused", t0), true);
  const restarted = createKeyNotices({ everyMs: every, persist: true });
  restarted.sendTo((t) => told.push(t));
  assert.equal(restarted.report("refused", t0 + 3_600_000), false, "no repeat after a restart");
  assert.equal(restarted.report("missing", t0 + 3_600_000), true);
  assert.equal(restarted.report("refused", t0 + 3 * 3_600_000 + 1), true, "after the interval it speaks again");
  assert.equal(told.length, 3);
  const wording = createKeyNotices({ everyMs: every }); // not persistent: unchanged behaviour
  wording.sendTo(() => undefined);
  assert.equal(wording.report("refused", t0), true);
});

test("interval stamps and the once-a-day marks share the file without erasing each other, and old stamps are dropped", () => {
  const now = Date.now();
  markNoticeAt("warn:g1", now - 2 * 86_400_000);
  markNoticeAt("warn:g2", now);
  assert.equal(lastNoticeAt("warn:g1"), undefined, "older than a day: dropped when the next is written");
  assert.equal(lastNoticeAt("warn:g2"), now);
  markCapNotice("group:x", now);
  assert.equal(capNoticeDue("group:x", now), false);
  assert.equal(lastNoticeAt("warn:g2"), now, "a day mark leaves the stamps");
  markNoticeAt("warn:g3", now);
  assert.equal(capNoticeDue("group:x", now), false, "a stamp leaves the day marks");
  assert.match(readFileSync(join(settings.stateDir, "cap-notices.json"), "utf8"), /warn:g3/);
});
