// A merge that left conflict markers behind once reached main unnoticed (the docs), because git merges a file that already holds them
// without complaint. Every tracked text file is checked here, so such a merge fails the gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("no tracked file holds merge conflict markers", () => {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-nIE", "^(<<<<<<< |>>>>>>> |=======$)", "--", ".", ":(exclude)package-lock.json"], { encoding: "utf8" });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e; // 1: no match
  }
  assert.equal(out.trim(), "", `conflict markers found:\n${out}`);
});
