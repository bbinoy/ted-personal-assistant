import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// core/notify.ts: the one "tell at most once / per day / every N ms" with an optional fact for the owner's next run.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "notify-"));

const { notify, forgetNotices, pruneNotices } = await import("../src/core/notify.ts");
const { convDb } = await import("../src/core/convdb.ts");
const { OWNER_CONV } = await import("../src/core/convpaths.ts");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = new Date(2026, 4, 3, 10, 0, 0).getTime();
const held = (): number => convDb(OWNER_CONV).num("SELECT COUNT(*) FROM held_posts");

const rules = [
  { name: "once", rule: { once: true }, again: [t0 + 400 * DAY], due: [] },
  { name: "perDay", rule: { perDay: true }, again: [t0 + HOUR], due: [t0 + DAY] },
  { name: "every", rule: { everyMs: HOUR }, again: [t0 + HOUR - 1], due: [t0 + HOUR] },
] as const;

for (const r of rules) {
  test(`notify ${r.name}: due once, then not again until its rule allows`, () => {
    const key = `rule:${r.name}`;
    assert.equal(notify(key, r.rule, undefined, t0), true);
    for (const t of r.again) assert.equal(notify(key, r.rule, undefined, t), false, `not again at +${t - t0}`);
    for (const t of r.due) assert.equal(notify(key, r.rule, undefined, t), true, `due at +${t - t0}`);
  });
}

test("notify keeps its text as a fact only when due, and keys are separate per conversation", () => {
  const before = held();
  assert.equal(notify("fact:a", { perDay: true }, "Something needs a look.", t0), true);
  assert.equal(held(), before + 1);
  assert.equal(notify("fact:a", { perDay: true }, "Something else.", t0), false);
  assert.equal(held(), before + 1, "not due: no second fact");
  assert.equal(notify("fact:b", { perDay: true }, undefined, t0), true, "no text: only the throttle");
  assert.equal(held(), before + 1);
  assert.equal(notify("warn:friend-a", { perDay: true }, undefined, t0), true);
  assert.equal(notify("warn:friend-b", { perDay: true }, undefined, t0), true, "another conversation's key is its own");
});

test("forgetNotices drops only the keys that end with that convId; pruneNotices drops old interval marks", () => {
  notify("refusal:cooldown:friend-x", { everyMs: HOUR }, undefined, t0);
  notify("warn:friend-x", { perDay: true }, undefined, t0);
  notify("warn:friend-xx", { perDay: true }, undefined, t0);
  assert.equal(forgetNotices("friend-x"), 2);
  assert.equal(notify("warn:friend-x", { perDay: true }, undefined, t0), true, "forgotten: due again");
  assert.equal(notify("warn:friend-xx", { perDay: true }, undefined, t0), false, "another conversation's mark stays");
  notify("old", { everyMs: HOUR }, undefined, t0 - 3 * DAY);
  assert.ok(pruneNotices(t0) >= 1);
});
