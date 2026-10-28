import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { CONV_SCHEMA } from "../src/core/convdb.ts";
import { INSTANCE_SCHEMA } from "../src/core/instancedb.ts";
import { pruneTold, told } from "../src/core/told.ts";

// core/told.ts: the one record of "told once / once a day / at most every N", over any database that has the table; and the steps that moved the older marks into it.

const dir = mkdtempSync(join(tmpdir(), "told-test-"));
let n = 0;
const path = (): string => {
  const d = join(dir, `${++n}`);
  mkdirSync(d);
  return join(d, "t.db");
};
const HOUR = 3_600_000;

test("told: once is once for ever, an interval is a window, a day is a local day in the given zone; each key on its own", () => {
  const db = openDb(path(), { migrations: INSTANCE_SCHEMA });
  const t0 = Date.UTC(2026, 9, 14, 12, 0);
  assert.equal(told(db, "a", { once: true }, t0), true);
  assert.equal(told(db, "a", { once: true }, t0 + 400 * 24 * HOUR), false, "never again");
  assert.equal(told(db, "b", { everyMs: HOUR }, t0), true);
  assert.equal(told(db, "b", { everyMs: HOUR }, t0 + HOUR - 1), false);
  assert.equal(told(db, "b", { everyMs: HOUR }, t0 + HOUR), true);
  // 23:30 and 00:30 UTC are the same day in Los Angeles' evening but different days in UTC
  const late = Date.UTC(2026, 9, 14, 23, 30);
  assert.equal(told(db, "d", { perDay: true, zone: "UTC" }, late), true);
  assert.equal(told(db, "d", { perDay: true, zone: "UTC" }, late + HOUR), true, "past midnight in UTC: a new day");
  assert.equal(told(db, "e", { perDay: true, zone: "America/Los_Angeles" }, late), true);
  assert.equal(told(db, "e", { perDay: true, zone: "America/Los_Angeles" }, late + HOUR), false, "still the same day in Los Angeles");
  db.close();
});

test("told: pruning forgets interval and day marks older than two days and never a once mark", () => {
  const db = openDb(path(), { migrations: INSTANCE_SCHEMA });
  const now = Date.UTC(2026, 9, 14, 12, 0);
  told(db, "once", { once: true }, now - 100 * 24 * HOUR);
  told(db, "old", { everyMs: HOUR }, now - 3 * 24 * HOUR);
  told(db, "new", { everyMs: HOUR }, now - HOUR);
  assert.equal(pruneTold(db, now), 1);
  assert.deepEqual(db.all("SELECT key FROM told ORDER BY key").map((r) => r.key), ["new", "once"]);
  db.close();
});

test("step 5 of instance.db: the notice marks become told rows, so nothing is told twice after the upgrade", () => {
  const p = path();
  const old = openDb(p, { migrations: INSTANCE_SCHEMA.slice(0, 1) });
  const now = Date.now();
  old.run("INSERT INTO notices (key, last_at) VALUES ('budget:owner', ?), ('warn:g1', ?)", now, now - 5 * 60_000);
  old.close();
  const db = openDb(p, { migrations: INSTANCE_SCHEMA });
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'notices'"), undefined);
  assert.deepEqual(db.all("SELECT key, once FROM told ORDER BY key").map((r) => [r.key, r.once]), [["budget:owner", 0], ["warn:g1", 0]]);
  assert.equal(told(db, "budget:owner", { perDay: true }, now), false);
  assert.equal(told(db, "warn:g1", { everyMs: HOUR }, now), false);
  db.close();
});

test("step 23 of assistant.db: the group members told once become once-told rows, so no member is told twice after the upgrade", () => {
  const p = path();
  const old = openDb(p, { migrations: CONV_SCHEMA.slice(0, 1) });
  old.run("INSERT INTO group_remind_noted (member, at) VALUES ('Ann', 5), ('Bo', 6)");
  old.close();
  const db = openDb(p, { migrations: CONV_SCHEMA });
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'group_remind_noted'"), undefined);
  assert.deepEqual(db.all("SELECT key, at, once FROM told ORDER BY key").map((r) => [r.key, r.at, r.once]), [["group-reminder:Ann", 5, 1], ["group-reminder:Bo", 6, 1]]);
  assert.equal(told(db, "group-reminder:Ann", { once: true }), false);
  assert.equal(told(db, "group-reminder:Cy", { once: true }), true);
  db.close();
});
