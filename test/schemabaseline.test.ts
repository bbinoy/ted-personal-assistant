import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OlderSchemaError, openDb, type Db, type Migration } from "../src/core/db.ts";
import { CONV_SCHEMA } from "../src/core/convdb.ts";
import { INSTANCE_SCHEMA } from "../src/core/instancedb.ts";

// The baseline of each database replaced the numbered steps that built it (22 for a conversation's assistant.db, 4 for instance.db). The oracle is test/fixtures/old-steps-schema.json: the schema
// (every table, index, trigger and view, normalised, and every table's columns) that the OLD steps produced, dumped from them before they were deleted. A fresh file made by the baseline must be
// identical to it, so a file that was made by the old steps (at the same user_version) is the same as a fresh one and opens without a step running.

type Dump = Record<string, string>;
const golden = JSON.parse(readFileSync(new URL("./fixtures/old-steps-schema.json", import.meta.url), "utf8")) as { conv: Dump; instance: Dump };
const norm = (sql: string): string => sql.replace(/--[^\n]*/g, " ").replace(/"/g, "").replace(/\s+/g, " ").replace(/ ?([(),]) ?/g, "$1").trim();

function dump(raw: { prepare: (sql: string) => { all: () => unknown[] } }): Dump {
  const out: Dump = {};
  for (const r of raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string; sql: string }[]) {
    out[`${r.type} ${r.name}`] = norm(r.sql);
    if (r.type === "table") {
      const cols = raw.prepare(`PRAGMA table_info(${r.name})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
      out[`columns ${r.name}`] = JSON.stringify(cols.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]));
    }
  }
  return out;
}
const dumpOf = (db: Db): Dump => dump({ prepare: (sql) => ({ all: () => db.all(sql) }) });

const dir = mkdtempSync(join(tmpdir(), "baseline-test-"));
let n = 0;
const path = (): string => {
  const d = join(dir, `${++n}`);
  mkdirSync(d);
  return join(d, "t.db");
};

for (const [name, steps, expected] of [
  ["a conversation's assistant.db", CONV_SCHEMA, golden.conv],
  ["instance.db", INSTANCE_SCHEMA, golden.instance],
] as [string, readonly Migration[], Dump][]) {
  const baseline = steps[0]!.version;

  test(`${name}: a fresh file made by the baseline has exactly the schema the old steps made`, () => {
    const db = openDb(path(), { migrations: steps.slice(0, 1) });
    assert.equal(db.version, baseline);
    assert.deepEqual(dumpOf(db), expected);
    db.close();
  });

  test(`${name}: a file already at the baseline version is opened as it is, with no step to run`, () => {
    const p = path();
    openDb(p, { migrations: steps.slice(0, 1) }).close();
    const raw = new DatabaseSync(p);
    const was = dump(raw);
    raw.close();
    const again = openDb(p, { migrations: steps.slice(0, 1) });
    assert.equal(again.version, baseline);
    assert.deepEqual(dumpOf(again), was);
    again.close();
  });

  test(`${name}: a file older than the baseline (every version from 1) is refused with a message and not touched`, () => {
    for (let v = 1; v < baseline; v++) {
      const p = path();
      const raw = new DatabaseSync(p);
      raw.exec(`CREATE TABLE marker (x); PRAGMA user_version=${v}`);
      raw.close();
      assert.throws(() => openDb(p, { migrations: steps }), (e: unknown) => e instanceof OlderSchemaError && new RegExp(`version ${v}, older than the oldest this code upgrades \\(${baseline}\\)`).test((e as Error).message));
      const check = new DatabaseSync(p);
      assert.equal(Object.values(check.prepare("PRAGMA user_version").get() as object)[0], v);
      assert.deepEqual(Object.keys(dump(check)), ["table marker", "columns marker"]);
      check.close();
    }
  });
}
