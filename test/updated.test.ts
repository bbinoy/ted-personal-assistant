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

// A fake git: the log between two commits is `subjects`. markUpdated is what agent.ts calls once a chat run went through, with the session it ended on; `head` is the commit the process started at.
const git = (subjects: string[] = []) => (..._a: string[]) => subjects.join("\n");

test("a resumed session is told until a run goes through, then not again; again after the next update", () => {
  const c = owner();
  markUpdated(c, "s1", "aaa");
  const block = updatedFact(c, "s1", "bbb", git(["Merge: files in chat are usable by every tool"]));
  assert.match(block!, /Ted was updated since the last run/);
  assert.match(block!, /- Merge: files in chat are usable by every tool/);
  assert.match(block!, /try it\.$/);
  assert.ok(updatedFact(c, "s1", "bbb", git(["x"]))); // the run died: the block waits for the next one
  markUpdated(c, "s1", "bbb");
  assert.equal(updatedFact(c, "s1", "bbb", git(["x"])), undefined);
  assert.ok(updatedFact(c, "s1", "ccc", git(["y"])));
});

test("a fresh session gets none; a session with no row is stored without a block; a look does not use up the chat's notice", () => {
  const c = group("g-sessions");
  assert.equal(updatedFact(c, undefined, "bbb", git(["x"])), undefined); // fresh: no session to be stale
  assert.equal(updatedFact(c, "old", "bbb", git(["x"])), undefined); // older than this feature: no row
  markUpdated(c, "old", "bbb");
  markUpdated(c, "chat", "aaa");
  markUpdated(c, "look-1", "bbb"); // a fresh session finishing (what a new chat session does after its first run)
  assert.ok(updatedFact(c, "chat", "bbb", git(["x"]))); // the chat session still gets its block
  assert.equal(updatedFact(c, "look-1", "bbb", git(["x"])), undefined);
});

test("only the last few sessions are kept", () => {
  const c = group("g-prune");
  for (let i = 0; i < 9; i++) markUpdated(c, `s${i}`, "aaa");
  assert.equal(updatedFact(c, "s0", "bbb", git(["x"])), undefined); // forgotten: no row
});

test("the commit is read once at start: a HEAD that moves later is not asked for", () => {
  assert.equal(startHead(), startHead());
  const c = group("g-start");
  markUpdated(c, "s", startHead() ?? "none");
  assert.equal(updatedFact(c, "s"), undefined);
});

test("the same block for every kind of conversation", () => {
  const blocks = [owner(), group("g-updated"), friend()].map((c) => {
    markUpdated(c, "s", "aaa");
    return updatedFact(c, "s", "bbb", git(["Merge: one", "Merge: two"]));
  });
  assert.ok(blocks[0]);
  assert.equal(new Set(blocks).size, 1);
});

test("capped at 12 subjects", () => {
  const c = group("g-cap");
  markUpdated(c, "s", "aaa");
  const block = updatedFact(c, "s", "bbb", git(Array.from({ length: 40 }, (_, i) => `Merge: n${i}`)))!;
  assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, 12);
  assert.match(block, /- Merge: n0\n/);
});

test("no git, or a commit git does not know: no block, nothing fails", () => {
  const c = group("g-nogit");
  markUpdated(c, "s", "aaa");
  assert.equal(updatedFact(c, "s", "bbb", () => undefined), undefined); // the old commit is unknown
});
