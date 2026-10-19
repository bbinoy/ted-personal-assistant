import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isFree, MANIFEST, readsUntrusted } from "../src/toolmanifest.ts";

// The full set of manifest rows, pinned: every tool the model might get, with its provider, action, capability, sources and mail view, and the two
// things the rows decide for it (runs free of the judge; reading it makes the run's arguments untrusted). Recorded from the code before the tool
// modules existed (src/modules); the move into modules must not add, drop or change a row. A deliberate change to a tool means editing
// test/fixtures/manifest-rows.json on purpose. The order is not pinned, the set is.

interface Row {
  tool: string;
  provider: string;
  action: string;
  cap: string;
  only: string[] | null;
  view: string | null;
  free: boolean;
  untrusted: boolean;
}

const stored: Row[] = JSON.parse(readFileSync(new URL("./fixtures/manifest-rows.json", import.meta.url), "utf8"));
const byTool = (a: { tool: string }, b: { tool: string }) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0);

test("manifest rows: the full row set is the recorded one (tool, provider, action, cap, only, view, free, untrusted)", () => {
  const now: Row[] = MANIFEST.map((e) => ({ tool: e.tool, provider: e.provider, action: e.action, cap: e.cap, only: e.only ? [...e.only] : null, view: e.view ?? null, free: isFree(e.tool, e.provider as never), untrusted: readsUntrusted(e.tool, e.provider as never) }));
  assert.equal(now.length, stored.length, "the number of rows");
  assert.deepEqual([...now].sort(byTool), [...stored].sort(byTool));
});

test("manifest rows: the fixture holds no flag and no key-like text", () => {
  for (const r of stored) assert.deepEqual(Object.keys(r).sort(), ["action", "cap", "free", "only", "provider", "tool", "untrusted", "view"]);
});
