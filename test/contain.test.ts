import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside } from "../src/core/contain.ts";

test("isInside: contained paths, traversal, siblings, symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "contain-"));
  const dir = join(root, "notes");
  const other = join(root, "notes-evil");
  mkdirSync(dir);
  mkdirSync(other);
  writeFileSync(join(other, "secret.md"), "x");
  symlinkSync(other, join(dir, "link"));
  symlinkSync(join(other, "secret.md"), join(dir, "file-link.md"));
  symlinkSync(dir, join(root, "alias"));

  assert.equal(isInside(join(dir, "a.md"), dir), true);
  assert.equal(isInside(join(dir, "sub", "new", "a.md"), dir), true); // not created yet
  assert.equal(isInside(join(root, "alias", "a.md"), dir), true); // via a symlink to the dir itself
  assert.equal(isInside(dir, dir), false);
  assert.equal(isInside(join(dir, "..", "notes-evil", "secret.md"), dir), false);
  assert.equal(isInside(join(dir, "x", "..", "..", "a.md"), dir), false);
  assert.equal(isInside(join(other, "secret.md"), dir), false); // prefix sibling
  assert.equal(isInside(join(dir, "link", "secret.md"), dir), false);
  assert.equal(isInside(join(dir, "link", "new.md"), dir), false);
  assert.equal(isInside(join(dir, "file-link.md"), dir), false);
  for (const bad of [undefined, null, 5, "", "a\0b"]) assert.equal(isInside(bad, dir), false);
});
