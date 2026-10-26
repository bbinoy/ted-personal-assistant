import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_VERSION, layout, layoutProblem, stampLayout } from "../src/core/convpaths.ts";

// The one layout guard (core/convpaths.ts): version 4 or a new folder is usable, anything else is refused with one sentence.

const folder = (): string => mkdtempSync(join(tmpdir(), "layout-"));
const stamp = (root: string, v: string): void => (mkdirSync(layout(root).instance.dir, { recursive: true }), writeFileSync(layout(root).instance.layoutVersion, `${v}\n`));

test("a new, empty folder is usable and gets stamped with the current layout; a stamped one is left alone", () => {
  const root = folder();
  assert.equal(layoutProblem(root), null);
  stampLayout(root);
  assert.equal(readFileSync(layout(root).instance.layoutVersion, "utf8"), `${LAYOUT_VERSION}\n`);
  assert.equal(layoutProblem(root), null);
  stamp(root, "5");
  stampLayout(root);
  assert.equal(readFileSync(layout(root).instance.layoutVersion, "utf8"), "5\n");
});

test("an older layout (a lower stamp, or the pre-instance/ folders without one) is refused with the tag to check out; a newer one is refused too", () => {
  for (const v of ["2", "3"]) {
    const root = folder();
    stamp(root, v);
    assert.match(layoutProblem(root)!, /older layout.*git tag last-migration.*npm run migrate/);
  }
  const old = folder();
  mkdirSync(join(old, "memory", "notes"), { recursive: true });
  writeFileSync(join(old, "memory", "notes", "a.md"), "x");
  assert.match(layoutProblem(old)!, /older layout/);
  const newer = folder();
  stamp(newer, String(LAYOUT_VERSION + 1));
  assert.match(layoutProblem(newer)!, /newer layout/);
  stamp(newer, String(LAYOUT_VERSION));
  assert.equal(layoutProblem(newer), null);
});
