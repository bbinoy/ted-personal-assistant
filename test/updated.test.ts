import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// run/updated.ts: "Ted was updated" is told once per conversation after the code moves to a new commit; the same for the owner, a group and a friend; capped; no git, no block.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "updated-"));
const { owner, group, tenant } = await import("../src/conversation/conversationmodel.ts");
const { updatedFact } = await import("../src/run/updated.ts");
const T = await import("../src/tenants/tenants.ts");
const friend = () => tenant(T.addTenant({ aci: "00000000-0000-4000-8000-0000000000dd", name: "Bea" })!.id);

// A fake git: HEAD is `head`; the log between two commits is `subjects`.
const fake = (head: string | undefined, subjects: string[] = []) => (...a: string[]) => (a[0] === "rev-parse" ? head : subjects.join("\n"));

test("told once after a version change, not on the next run, again after the next update", () => {
  const c = owner();
  assert.equal(updatedFact(c, fake("aaa")), undefined); // the first run here: nothing earlier to be out of date
  const block = updatedFact(c, fake("bbb", ["Merge: files in chat are usable by every tool"]));
  assert.match(block!, /Ted was updated since the last run/);
  assert.match(block!, /- Merge: files in chat are usable by every tool/);
  assert.match(block!, /try it\.$/);
  assert.equal(updatedFact(c, fake("bbb", ["x"])), undefined);
  assert.ok(updatedFact(c, fake("ccc", ["y"])));
});

test("the same block for every kind of conversation", () => {
  const blocks = [owner(), group("g-updated"), friend()].map((c) => {
    updatedFact(c, fake("aaa"));
    return updatedFact(c, fake("bbb", ["Merge: one", "Merge: two"]));
  });
  assert.ok(blocks[0]);
  assert.equal(new Set(blocks).size, 1);
});

test("capped at 12 subjects", () => {
  const c = group("g-cap");
  updatedFact(c, fake("aaa"));
  const block = updatedFact(c, fake("bbb", Array.from({ length: 40 }, (_, i) => `Merge: n${i}`)))!;
  assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, 12);
  assert.match(block, /- Merge: n0\n/);
});

test("no git, or a commit git does not know: no block, nothing fails", () => {
  const c = group("g-nogit");
  assert.equal(updatedFact(c, fake(undefined)), undefined);
  updatedFact(c, fake("aaa"));
  assert.equal(updatedFact(c, (...a) => (a[0] === "rev-parse" ? "bbb" : undefined)), undefined); // the old commit is unknown
});
