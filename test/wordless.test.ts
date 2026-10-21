import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "wordless-test-"));
const { wordless } = await import("../src/core/audit.ts");

test("wordless: a friend's control labels (label, approvedControl) become lengths like the rest of her words", () => {
  const meta = { host: "shop.example.net", label: "Pay Anna's dentist", approvedControl: "Confirm booking with Dr. Weiss", approvedStep: "browser_click", approval: "r1-1", count: 2 };
  const out = wordless(meta)!;
  assert.equal(out.labelChars, "Pay Anna's dentist".length);
  assert.equal(out.approvedControlChars, "Confirm booking with Dr. Weiss".length);
  assert.equal(out.hostChars, "shop.example.net".length);
  assert.ok(!JSON.stringify(out).includes("dentist") && !JSON.stringify(out).includes("Weiss") && !JSON.stringify(out).includes("shop.example"));
  assert.deepEqual([out.approvedStep, out.approval, out.count], ["browser_click", "r1-1", 2], "ids, tool names and counts stay");
});
