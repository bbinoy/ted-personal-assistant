import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memberCacheSize, ownerInGroup } from "../src/conversation/group.ts";
import { groupDir, groupNotesDir } from "../src/conversation/groupstore.ts";
import { convPaths, groupConvId } from "../src/core/convpaths.ts";

test("groups: each group id has its own folder, and a different id that hashes to the same folder is refused, not merged", () => {
  const a = "group-a-isolation-test";
  const dirA = groupDir(a, "Alpha");
  assert.equal(dirA, convPaths(groupConvId(a)).dir);
  assert.equal(groupDir(a), dirA, "the same group again is fine");
  assert.notEqual(groupDir("group-b-isolation-test", "Beta"), dirA);
  // someone who ground an id with the same 48-bit key: their folder is already taken by a's meta.json
  const clash = "b-ground-to-collide";
  mkdirSync(convPaths(groupConvId(clash)).notes, { recursive: true });
  writeFileSync(convPaths(groupConvId(clash)).meta, JSON.stringify({ id: "the-real-group", name: "Real" }));
  assert.throws(() => groupDir(clash, "Imposter"), /belongs to another group/);
  assert.equal(groupNotesDir(clash), convPaths(groupConvId(clash)).notes); // (the path alone is only data; nothing is read or written before groupDir)
});

test("groups: the membership cache stays small however many groups talk to us", async () => {
  const lookup = async () => [];
  for (let i = 0; i < 700; i++) await ownerInGroup(`stranger-${i}`, lookup, () => false, 1_000_000 + i);
  assert.ok(memberCacheSize() <= 200, `${memberCacheSize()} entries`);
  // the newest are kept (a group in use stays cached)
  let calls = 0;
  const counting = async () => (calls++, []);
  await ownerInGroup("stranger-699", counting, () => false, 1_000_700);
  assert.equal(calls, 0);
});
