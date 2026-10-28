import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "What I learned overnight" (src/memory/learned.ts): the quiet memory changes (the dream) are recorded where they happen and handed ONCE as a fact to the conversation's next run
// (learnedFact, the same for the owner and a friend; the brief's expert gets it with the rest of the look's context). The run says them in its words; taking one back is an ordinary chat turn. A group has none.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "learned-test-"));

const L = await import("../src/memory/learned.ts");
const { noteContent } = await import("../src/memory/dreamplan.ts");
const { createMemoryServer } = await import("../src/modules/memory/memory-tools.ts");
const F = await import("../src/heartbeat/facts.ts");
const { createDreamer } = await import("../src/conversation/dream.ts");
const { group: groupConversation } = await import("../src/conversation/conversationmodel.ts");
const { groupDir, groupLogFile, groupNotesDir } = await import("../src/conversation/groupstore.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { NOTES_DIR } = await import("../src/memory/notes.ts");
const { convIdOfKey, groupConvId, OWNER_CONV } = await import("../src/core/convpaths.ts");
const { peekConvDb } = await import("../src/core/convdb.ts");

const NOW = Date.parse("2026-10-22T07:30:00Z");
const HOUR = 3_600_000;
let n = 0;
// A friend-like conversation with its own notes folder.
const friend = () => {
  const id = `lrn${++n}`;
  const dir = join(process.env.HARNESS_DATA_DIR!, `notes-${id}`);
  mkdirSync(dir, { recursive: true });
  return { kind: "tenant" as const, key: `tenant:${id}`, convId: convIdOfKey(`tenant:${id}`), tenantId: id, notesDir: dir };
};
const put = (dir: string, file: string, description: string, text: string) => writeFileSync(join(dir, file), noteContent(file, description, text, undefined, new Date(NOW)));
const plan = (actions: object[]) => ({ actions, rejected: [] }) as never;
// The fact a run would be handed now, settled as told (the run spoke): its text, or "" when there is none.
const told = (c: { convId: string; notesDir: string }, now: number): string => {
  const f = L.learnedFact(c.convId, c.notesDir, now);
  f?.told();
  return f?.text ?? "";
};
// A note the dream added at `at`, and its row.
const saved = (c: { convId: string; notesDir: string }, file: string, description: string, at = NOW) => {
  put(c.notesDir, file, description, description);
  L.recordDream(c.convId, plan([{ kind: "add", file, description, content: "", merged: [] }]), c.notesDir, at);
};

test("the list: dream changes, one line each with the note name and gist; merges are one line and a merge's own deletes are not listed twice", () => {
  const c = friend();
  put(c.notesDir, "people-anna.md", "Anna moved to Lisbon", "Anna lives in Lisbon.");
  put(c.notesDir, "triage-merged.md", "Triage rules", "x");
  put(c.notesDir, "style-new.md", "Short replies", "y");
  L.recordDream(c.convId, plan([
    { kind: "add", file: "style-new.md", description: "Short replies", content: "", merged: [] },
    { kind: "merge", file: "triage-merged.md", description: "Triage rules", content: "", merged: ["triage-a.md", "triage-b.md"] },
    { kind: "delete", file: "triage-a.md", why: "merged into triage-merged.md" },
    { kind: "delete", file: "triage-b.md", why: "merged into triage-merged.md" },
    { kind: "delete", file: "context-old.md", why: "expired" },
  ]), c.notesDir, NOW);
  const b = L.planBatch(c.convId, c.notesDir, NOW)!;
  assert.deepEqual(b.items.map((i) => L.lineOf(i)), [
    "- style-new: Short replies (saved)",
    "- triage-merged: Triage rules (merged 2 notes)",
    "- context-old: expired (forgotten)",
  ]);
});

test("no repeats: a list is told once; later changes make a new list", () => {
  const c = friend();
  saved(c, "people-anna.md", "Anna moved to Lisbon");
  assert.match(told(c, NOW), /^[\s\S]*\n- people-anna: Anna moved to Lisbon \(saved\)\n/);
  assert.equal(told(c, NOW + 7 * HOUR), "", "told; nothing new");
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW + 7 * HOUR), undefined);
  saved(c, "people-bo.md", "Bo has a new job", NOW + 8 * HOUR);
  const next = told(c, NOW + 9 * HOUR);
  assert.match(next, /- people-bo: Bo has a new job \(saved\)/);
  assert.doesNotMatch(next, /people-anna/);
});

test("a change to a note that is gone by list time is not listed; an old change is dropped silently", () => {
  const c = friend();
  saved(c, "people-anna.md", "Anna moved to Lisbon");
  saved(c, "people-gone.md", "Gone soon");
  rmSync(join(c.notesDir, "people-gone.md"));
  saved(c, "people-old.md", "Very old", NOW - 8 * 86_400_000);
  const b = L.planBatch(c.convId, c.notesDir, NOW)!;
  assert.deepEqual(b.items.map((i) => L.lineOf(i)), ["- people-anna: Anna moved to Lisbon (saved)"]);
  L.commitBatch(c.convId, b, NOW);
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW), undefined, "the dropped ones are settled too");
});

test("the owner gets the learned changes as the same fact a friend does, once; the brief tool is gone from the one memory server", () => {
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
  type Srv = { instance: { _registeredTools: Record<string, unknown> } };
  const names = Object.keys((createMemoryServer({ source: "background", notesDir: NOTES_DIR }) as unknown as Srv).instance._registeredTools);
  assert.ok(!names.includes("memory_changes_since_brief"));
  const o = { convId: OWNER_CONV, notesDir: NOTES_DIR };
  assert.equal(L.learnedFact(o.convId, o.notesDir, NOW), undefined, "nothing changed");
  saved(o, "people-anna.md", "Anna moved to Lisbon");
  const f = L.learnedFact(o.convId, o.notesDir, NOW)!;
  assert.match(f.text, /- people-anna: Anna moved to Lisbon \(saved\)/);
  assert.match(f.text, /forget <note>/);
  f.told();
  assert.equal(L.learnedFact(o.convId, o.notesDir, NOW + HOUR), undefined, "settled told");
  peekConvDb(OWNER_CONV)?.run("DELETE FROM learned_changes");
  peekConvDb(OWNER_CONV)?.run("DELETE FROM learned_batches"); // (the owner's rows are shared with the tests below)
});

test("factsFor hands the owner's look the learned block (the brief's expert context carries the blocks), settles it when the run spoke, and leaves a group out", async () => {
  const { owner } = await import("../src/conversation/conversationmodel.ts");
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
  saved({ convId: OWNER_CONV, notesDir: NOTES_DIR }, "people-di.md", "Di moved");
  const silent = F.factsFor(owner(), new Date(NOW), false);
  assert.match(silent.blocks.join("\n"), /<notes_changed_facts>[\s\S]*- people-di: Di moved \(saved\)/);
  silent.done({ ended: true, said: false } as never);
  const again = F.factsFor(owner(), new Date(NOW + HOUR), true);
  assert.match(again.blocks.join("\n"), /people-di/, "nothing was said: still owed, to a chat turn too");
  again.done({ ended: true, said: true } as never);
  assert.doesNotMatch(F.factsFor(owner(), new Date(NOW + 2 * HOUR), false).blocks.join("\n"), /people-di/, "told once");
  const g = "R3JvdXAxR3JvdXAxR3JvdXAx";
  groupDir(g, "Chess");
  assert.doesNotMatch(F.factsFor(groupConversation(g), new Date(NOW), false).blocks.join("\n"), /notes_changed_facts/);
  peekConvDb(OWNER_CONV)?.run("DELETE FROM learned_changes");
  peekConvDb(OWNER_CONV)?.run("DELETE FROM learned_batches");
});

test("groups are off: a group's dream records nothing", async () => {
  const g = "R3JvdXAxR3JvdXAxR3JvdXAx";
  groupDir(g, "Chess");
  for (let i = 0; i < 3; i++) recordMessage("member", 300 + i, `Eve (a member): we play on Thursdays ${i} ${"x".repeat(20)}`, new Date("2026-10-13T20:00:00Z"), groupLogFile(g));
  const ran = async () => ({ ops: [{ op: "write", file: "scheduling-games.md", description: "games", text: "Games are on Thursdays.", evidence: "we play on Thursdays" }] });
  await createDreamer({ conversations: () => [groupConversation(g)], run: () => ran }).run(new Date("2026-10-14T07:00:00"));
  assert.equal(existsSync(join(groupNotesDir(g), "scheduling-games.md")), true, "the dream itself still works");
  assert.equal(peekConvDb(groupConvId(g))?.num("SELECT COUNT(*) FROM learned_changes") ?? 0, 0);
  assert.equal(L.recordDream(groupConvId(g), plan([{ kind: "add", file: "scheduling-games.md", description: "x", content: "", merged: [] }]), groupNotesDir(g), NOW), 0);
  assert.equal(L.planBatch(groupConvId(g), groupNotesDir(g), NOW), undefined);
  assert.equal(L.learnedFact(groupConvId(g), groupNotesDir(g), NOW), undefined);
});

test("the owner's dream: what it applied is recorded and listed once (a forgotten note, a saved one), not what it skipped", async () => {
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
  writeFileSync(join(NOTES_DIR, "context-old.md"), "---\nname: old\nexpires: 2026-10-01\n---\n\nPitch booked for 1 Oct.\n");
  recordMessage("owner", 5, "Anna is my sister and her birthday is on 3 March", new Date("2026-10-13T20:00:00Z"));
  const ran = async () => ({ ops: [{ op: "write", file: "people-anna.md", description: "Anna is the owner's sister", text: "Anna is the sister.", evidence: "Anna is my sister" }, { op: "delete", file: "context-old.md", reason: "expired" }] });
  const { owner } = await import("../src/conversation/conversationmodel.ts");
  await createDreamer({ conversations: () => [owner()], run: () => ran }).run(new Date("2026-10-14T07:00:00"));
  const text = told({ convId: OWNER_CONV, notesDir: NOTES_DIR }, Date.parse("2026-10-14T08:00:00"));
  assert.match(text, /- people-anna: Anna is the owner's sister \(saved\)\n- context-old: expired \(forgotten\)/);
});

test("a whole-dream undo: lines not yet told are never listed; lines already told get one 'the dream of <day> was undone' note in the next list", () => {
  const c = friend();
  put(c.notesDir, "style-new.md", "Short replies", "y");
  const add = (file: string) => plan([{ kind: "add", file, description: "d", content: "", merged: [] }]);
  L.recordDream(c.convId, add("style-new.md"), c.notesDir, NOW);
  L.dreamUndone(c.convId, NOW + HOUR);
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW + HOUR), undefined, "never told: nothing to say, nothing listed");
  // told first, then undone
  L.recordDream(c.convId, add("style-new.md"), c.notesDir, NOW + 2 * HOUR);
  assert.match(told(c, NOW + 3 * HOUR), /- style-new/);
  L.dreamUndone(c.convId, NOW + 4 * HOUR);
  saved(c, "people-bo.md", "Bo has a new job", NOW + 4 * HOUR);
  assert.match(told(c, NOW + 20 * HOUR), /\n- people-bo: Bo has a new job \(saved\)\n- the dream of 2026-10-22 was undone \(what it changed was put back\)\n/);
  assert.equal(told(c, NOW + 40 * HOUR), "", "said once");
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW + 40 * HOUR), undefined);
});

test("undo_dream's own path (undoLatest) marks the owner's dream lines undone", async () => {
  const { undoLatest } = await import("../src/memory/dreamapply.ts");
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
  recordMessage("owner", 9, "Bo is my brother and he lives in Basel", new Date("2026-10-14T20:00:00Z"));
  const ran = async () => ({ ops: [{ op: "write", file: "people-bo.md", description: "Bo is the owner's brother", text: "Bo is the brother.", evidence: "Bo is my brother" }] });
  const { owner } = await import("../src/conversation/conversationmodel.ts");
  await createDreamer({ conversations: () => [owner()], run: () => ran }).run(new Date("2026-10-15T07:00:00"));
  const { dreamScope } = await import("../src/modules/memory/dreamscope.ts");
  assert.equal(undoLatest(dreamScope(owner())).ok, true);
  assert.equal(told({ convId: OWNER_CONV, notesDir: NOTES_DIR }, Date.parse("2026-10-15T08:00:00")), "", "its lines are never listed");
});

test("a run is handed what changed in the conversation's notes as a fact; it counts as told only once the look spoke, and an empty or stale list says nothing", () => {
  const c = friend();
  assert.equal(L.learnedFact(c.convId, c.notesDir, NOW), undefined, "nothing changed");
  saved(c, "people-anna.md", "Anna moved to Lisbon");
  const f = L.learnedFact(c.convId, c.notesDir, NOW)!;
  assert.match(f.text, /- people-anna: Anna moved to Lisbon \(saved\)/);
  assert.match(f.text, /forget <note>/);
  assert.ok(L.learnedFact(c.convId, c.notesDir, NOW + HOUR), "the look stayed silent: still owed");
  f.told();
  assert.equal(L.learnedFact(c.convId, c.notesDir, NOW + 2 * HOUR), undefined, "told once");
  saved(c, "people-old.md", "Very old", NOW - 8 * 86_400_000);
  assert.equal(L.learnedFact(c.convId, c.notesDir, NOW), undefined, "a stale change is dropped without a word");
});

test("a note a look saved is a learned change again, unmarked: one line per note, new stays new, listed once; a group records nothing", () => {
  const c = friend();
  put(c.notesDir, "people-anna.md", "Anna moved to Lisbon", "Anna lives in Lisbon.");
  L.recordLook(c.convId, "people-anna.md", true, "Anna moved to Lisbon", NOW);
  L.recordLook(c.convId, "people-anna.md", false, "Anna moved to Porto", NOW + HOUR);
  assert.doesNotMatch(readFileSync(join(c.notesDir, "people-anna.md"), "utf8"), /origin|inferred/, "the note itself carries no mark");
  const b = L.planBatch(c.convId, c.notesDir, NOW + 2 * HOUR)!;
  assert.deepEqual(b.items.map((i) => L.lineOf(i)), ["- people-anna: Anna moved to Porto (saved)"]);
  L.commitBatch(c.convId, b, NOW + 2 * HOUR);
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW + 3 * HOUR), undefined);
  const g = "R3JvdXAxR3JvdXAxR3JvdXAx";
  L.recordLook(groupConvId(g), "context-x.md", true, "x", NOW);
  assert.equal(L.planBatch(groupConvId(g), groupNotesDir(g), NOW), undefined);
});
