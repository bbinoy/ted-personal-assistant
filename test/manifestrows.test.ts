import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { allRows, isFree, readsUntrusted } from "../src/policy/toolmanifest.ts";

// The full set of manifest rows, pinned: every tool the model might get, with its provider, action, capability, the runs it exists in (attended or not, and for whom) and mail view, and the two
// things the rows decide for it (runs free of the judge; reading it makes the run's arguments untrusted). Recorded from the code before the tool
// modules existed (src/modules); the move into modules must not add, drop or change a row. A deliberate change to a tool means regenerating
// test/fixtures/manifest-rows.json on purpose (SNAPSHOT_WRITE=1 npm test) and reading the diff. (The split of the policy source into who and attended replaced `only` by `attended` and `who`.) The order is not pinned, the set is.

interface Row {
  tool: string;
  provider: string;
  action: string;
  cap: string;
  attended: boolean | null; // true: only where someone waits; false: only in unattended runs; null: both
  who: string[] | null; // only these runs (a friend's own connection, the browse worker, the owner's own records)
  view: string | null;
  free: boolean;
  untrusted: boolean;
}

const stored: Row[] = JSON.parse(readFileSync(new URL("./fixtures/manifest-rows.json", import.meta.url), "utf8"));
const byTool = (a: { tool: string }, b: { tool: string }) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0);

test("manifest rows: the full row set is the recorded one (tool, provider, action, cap, only, view, free, untrusted)", () => {
  const now: Row[] = allRows().map((e) => ({ tool: e.tool, provider: e.provider, action: e.action, cap: e.cap, attended: e.attended ?? null, who: e.who ? [...e.who] : null, view: e.view ?? null, free: isFree(e.tool, e.provider as never), untrusted: readsUntrusted(e.tool, e.provider as never) }));
  if (process.env.SNAPSHOT_WRITE) return void writeFileSync(new URL("./fixtures/manifest-rows.json", import.meta.url), `[\n${now.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`);
  assert.equal(now.length, stored.length, "the number of rows");
  assert.deepEqual([...now].sort(byTool), [...stored].sort(byTool));
});

test("manifest rows: the fixture holds no flag and no key-like text", () => {
  for (const r of stored) assert.deepEqual(Object.keys(r).sort(), ["action", "attended", "cap", "free", "provider", "tool", "untrusted", "view", "who"]);
});
