import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// run/updated.ts: "Ted was updated" is told once per conversation after the code moves to a new commit; the same for the owner, a group and a friend; capped; no git, no block.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "updated-"));
const { owner, group, tenant } = await import("../src/conversation/conversationmodel.ts");
const { updatedFact, markUpdated, startHead } = await import("../src/run/updated.ts");
const T = await import("../src/tenants/tenants.ts");
const friend = () => tenant(T.addTenant({ aci: "00000000-0000-4000-8000-0000000000dd", name: "Bea" })!.id);

// A fake git: the log between two commits is `subjects`. A run that went through is `markUpdated` (agent.ts); `at` is the commit the process started at.
const git = (subjects: string[] = []) => (..._a: string[]) => subjects.join("\n");
const ran = (c: Parameters<typeof markUpdated>[0], at: string) => markUpdated(c, at);

test("told until a run goes through, then not again; again after the next update", () => {
  const c = owner();
  ran(c, "aaa");
  const block = updatedFact(c, "bbb", git(["Merge: files in chat are usable by every tool"]));
  assert.match(block!, /Ted was updated since the last run/);
  assert.match(block!, /- Merge: files in chat are usable by every tool/);
  assert.match(block!, /try it\.$/);
  assert.ok(updatedFact(c, "bbb", git(["x"]))); // the run died: the block waits for the next one
  ran(c, "bbb");
  assert.equal(updatedFact(c, "bbb", git(["x"])), undefined);
  assert.ok(updatedFact(c, "ccc", git(["y"])));
});

test("a first-ever run stores the commit and has no block", () => {
  const c = group("g-first");
  assert.equal(updatedFact(c, "aaa", git(["x"])), undefined);
  ran(c, "aaa");
  assert.equal(updatedFact(c, "aaa", git(["x"])), undefined);
  assert.ok(updatedFact(c, "bbb", git(["x"])));
});

test("the commit is read once at start: a HEAD that moves later is not asked for", () => {
  assert.equal(startHead(), startHead());
  const c = group("g-start");
  ran(c, startHead() ?? "none");
  assert.equal(updatedFact(c), undefined);
});

test("the same block for every kind of conversation", () => {
  const blocks = [owner(), group("g-updated"), friend()].map((c) => {
    ran(c, "aaa");
    return updatedFact(c, "bbb", git(["Merge: one", "Merge: two"]));
  });
  assert.ok(blocks[0]);
  assert.equal(new Set(blocks).size, 1);
});

test("capped at 12 subjects", () => {
  const c = group("g-cap");
  ran(c, "aaa");
  const block = updatedFact(c, "bbb", git(Array.from({ length: 40 }, (_, i) => `Merge: n${i}`)))!;
  assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, 12);
  assert.match(block, /- Merge: n0\n/);
});

test("no git, or a commit git does not know: no block, nothing fails", () => {
  const c = group("g-nogit");
  ran(c, "aaa");
  assert.equal(updatedFact(c, "bbb", () => undefined), undefined); // the old commit is unknown
});
