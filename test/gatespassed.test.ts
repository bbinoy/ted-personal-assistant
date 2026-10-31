import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alreadyPassed, recordPassed } from "../scripts/gates-passed.ts";

test("a recorded tree counts, another does not, an unclean tree (undefined) never does", () => {
  const file = join(mkdtempSync(join(tmpdir(), "gatespassed-")), "passed");
  assert.equal(alreadyPassed("aaa", file), false);
  recordPassed("aaa", file);
  recordPassed(undefined, file);
  assert.equal(alreadyPassed("aaa", file), true);
  assert.equal(alreadyPassed("bbb", file), false);
  assert.equal(alreadyPassed(undefined, file), false);
});

test("the file stays small", () => {
  const file = join(mkdtempSync(join(tmpdir(), "gatespassed-")), "passed");
  for (let i = 0; i < 130; i++) recordPassed(`t${i}`, file);
  assert.ok(readFileSync(file, "utf8").split("\n").filter(Boolean).length <= 100);
  assert.equal(alreadyPassed("t129", file), true);
});
