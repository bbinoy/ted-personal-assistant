import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_VERSION, layout, layoutProblem, stampLayout } from "../src/core/convpaths.ts";

// The one layout guard (core/convpaths.ts): a newer layout is refused with one sentence, anything else is used.

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

test("a layout stamp newer than this code's is refused with a sentence; the current one (and a folder with older files and no stamp) is used as it is", () => {
  const newer = folder();
  stamp(newer, String(LAYOUT_VERSION + 1));
  assert.match(layoutProblem(newer)!, /newer layout/);
  stamp(newer, String(LAYOUT_VERSION));
  assert.equal(layoutProblem(newer), null);
});
