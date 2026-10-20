import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// docs/ARCHITECTURE.md "Project layout" lists every source file with a line about it. It drifted by dozens of files once; this keeps it honest in both directions.

const ROOT = new URL("../", import.meta.url);
const doc = readFileSync(new URL("docs/ARCHITECTURE.md", ROOT), "utf8");
const layout = doc.slice(doc.indexOf("## Project layout"));
const listed = new Set([...layout.matchAll(/^(src\/[\w./-]+\.ts)\s/gm)].map((m) => m[1]!));
const files = (dir: string): string[] => readdirSync(new URL(`${dir}/`, ROOT)).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`);

test("docs: every file in src/ and src/modules/ appears in the project layout", () => {
  const missing = [...files("src"), ...files("src/modules")].filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `add a line for each to "Project layout" in docs/ARCHITECTURE.md`);
});

test("docs: every source file the project layout names exists", () => {
  assert.deepEqual([...listed].filter((f) => !existsSync(new URL(f, ROOT))), [], "a file was renamed or removed: fix its line in docs/ARCHITECTURE.md");
});
