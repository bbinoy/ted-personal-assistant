import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepTail, trimLogInPlace } from "../src/core/logtrim.ts";

test("keepTail: the last bytes from a line boundary; small input unchanged", () => {
  const b = Buffer.from("aaaa\nbbbb\ncccc\n");
  assert.equal(keepTail(b, 100).toString(), "aaaa\nbbbb\ncccc\n");
  assert.equal(keepTail(b, 8).toString(), "cccc\n"); // "bb\ncccc\n" cut at the first newline: no half line
  assert.equal(keepTail(b, 5).toString(), "cccc\n"); // the cut falls on a line start: nothing more dropped
  assert.equal(keepTail(Buffer.from("x".repeat(20)), 5).toString(), "xxxxx"); // no newline: just the tail
});

test("trimLogInPlace: over the limit keeps the newest lines in the same file and mode; under it does nothing", () => {
  const f = join(mkdtempSync(join(tmpdir(), "trim-")), "launchd-stderr.log");
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(40)}\n`).join("");
  writeFileSync(f, lines);
  chmodSync(f, 0o600);
  assert.equal(trimLogInPlace(f, lines.length + 1, 1000), 0);
  assert.equal(readFileSync(f, "utf8"), lines);
  const dropped = trimLogInPlace(f, 50_000, 1000);
  const after = readFileSync(f, "utf8");
  assert.ok(dropped > 0 && after.length <= 1000 && after.startsWith("line "));
  assert.ok(after.endsWith("line 1999 " + "x".repeat(40) + "\n"));
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(trimLogInPlace(join(tmpdir(), "does-not-exist.log"), 1, 1), 0); // no file: fine
});
