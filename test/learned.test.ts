import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "What I learned overnight" (src/memory/learned.ts): the quiet memory changes (the dream, inferred notes) are recorded where they happen and handed ONCE as facts: to the owner's brief (the brief tool)
// and to a friend's next look (learnedFact). The run says them in its words; taking one back is an ordinary chat turn. A group has none.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "learned-test-"));

const L = await import("../src/memory/learned.ts");
const { writeInferredNote } = await import("../src/memory/inferred.ts");
const { noteContent } = await import("../src/memory/dreamplan.ts");
const { createNotesServer } = await import("../src/modules/memory/notestools.ts");
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
const put = (dir: string, file: string, description: string, text: string, origin: "owner" | "inferred" | "dream") => writeFileSync(join(dir, file), noteContent(file, description, text, undefined, new Date(NOW), origin));
const inferred = (c: { convId: string; notesDir: string }, file: string, description: string, at = NOW) => {
  const r = writeInferredNote({ file, text: description, description }, { dir: c.notesDir, categories: ["people", "context"], maxNotes: 50, now: new Date(at) });
  assert.ok(r.ok);
  L.recordInferred(c.convId, r.file, r.created, r.gist, at);
};
const plan = (actions: object[]) => ({ actions, rejected: [] }) as never;

test("the list: dream changes and inferred notes, one line each with the note name and gist; merges are one line and a merge's own deletes are not listed twice", () => {
  const c = friend();
  put(c.notesDir, "people-anna.md", "Anna moved to Lisbon", "Anna lives in Lisbon.", "dream");
  put(c.notesDir, "triage-merged.md", "Triage rules", "x", "dream");
  put(c.notesDir, "style-new.md", "Short replies", "y", "dream");
  L.recordDream(c.convId, plan([
    { kind: "add", file: "style-new.md", description: "Short replies", content: "", merged: [] },
    { kind: "merge", file: "triage-merged.md", description: "Triage rules", content: "", merged: ["triage-a.md", "triage-b.md"] },
    { kind: "delete", file: "triage-a.md", why: "merged into triage-merged.md" },
    { kind: "delete", file: "triage-b.md", why: "merged into triage-merged.md" },
    { kind: "delete", file: "context-old.md", why: "expired" },
  ]), c.notesDir, NOW);
  inferred(c, "people-lena.md", "Lena moved to Lisbon");
  const b = L.planBatch(c.convId, c.notesDir, NOW)!;
  assert.deepEqual(b.items.map((i) => L.lineOf(i)), [
    "- style-new: Short replies (saved)",
    "- triage-merged: Triage rules (merged 2 notes)",
    "- context-old: expired (forgotten)",
    "- people-lena: Lena moved to Lisbon (inferred)",
  ]);
});

test("no repeats: a list is told once; the brief tool hands the same list out again only inside the redo window; later changes make a new list", () => {
  const c = friend();
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  const first = L.briefLearned(c.convId, c.notesDir, NOW);
  assert.match(first, /^- people-anna: Anna moved to Lisbon \(inferred\)$/);
  assert.equal(L.briefLearned(c.convId, c.notesDir, NOW + HOUR), first, "the brief was redone: the same list");
  L.briefDelivered(c.convId); // the brief's status note says delivered
  assert.equal(L.briefLearned(c.convId, c.notesDir, NOW + 7 * HOUR), "", "told; nothing new");
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW + 7 * HOUR), undefined);
  inferred(c, "people-bo.md", "Bo has a new job", NOW + 8 * HOUR);
  assert.match(L.briefLearned(c.convId, c.notesDir, NOW + 9 * HOUR), /^- people-bo: Bo has a new job \(inferred\)/);
});

test("an inferred note written twice overnight is one line, still new; one forgotten or confirmed before the list is not listed; an old change is dropped silently", () => {
  const c = friend();
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  inferred(c, "people-anna.md", "Anna moved to Porto");
  inferred(c, "people-gone.md", "Gone soon");
  inferred(c, "people-yours.md", "Will be confirmed");
  rmSync(join(c.notesDir, "people-gone.md"));
  put(c.notesDir, "people-yours.md", "Will be confirmed", "z", "owner");
  inferred(c, "people-old.md", "Very old", NOW - 8 * 86_400_000);
  const b = L.planBatch(c.convId, c.notesDir, NOW)!;
  assert.deepEqual(b.items.map((i) => L.lineOf(i)), ["- people-anna: Anna moved to Porto (inferred)"]);
  L.commitBatch(c.convId, b, NOW);
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW), undefined, "the dropped ones are settled too");
});

test("the owner's brief tool: the facts in markers, empty when nothing changed, only for the owner's notes", async () => {
  mkdirSync(NOTES_DIR, { recursive: true });
  const tools = (dir: string) => (createNotesServer({ dir, write: ["people"], maxNotes: 50 }, "background") as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, x: object) => Promise<{ content: { text: string }[] }> }> } }).instance._registeredTools;
  const t = tools(NOTES_DIR);
  assert.ok(t.memory_changes_since_brief);
  assert.match((await t.memory_changes_since_brief!.handler({}, {})).content[0]!.text, /Nothing changed on its own/);
  // the look's write_note records the change; the brief tool lists it
  const w = await t.write_note!.handler({ file: "people-anna.md", text: "Anna moved to Lisbon.", description: "Anna moved to Lisbon" }, {});
  assert.match(w.content[0]!.text, /Saved people-anna.md as inferred/);
  const out = (await t.memory_changes_since_brief!.handler({}, {})).content[0]!.text;
  assert.match(out, /- people-anna: Anna moved to Lisbon \(inferred\)/);
  assert.match(out, /<learned>|learned/);
  assert.match((await t.memory_changes_since_brief!.handler({}, {})).content[0]!.text, /people-anna/, "a redone brief gets the same list");
  const f = friend();
  assert.equal(tools(f.notesDir).memory_changes_since_brief, undefined, "a friend has no brief");
});

test("groups are off: a group's dream and inferred notes record nothing", async () => {
  const g = "R3JvdXAxR3JvdXAxR3JvdXAx";
  groupDir(g, "Chess");
  for (let i = 0; i < 3; i++) recordMessage("member", 300 + i, `Eve (a member): we play on Thursdays ${i} ${"x".repeat(20)}`, new Date("2026-10-13T20:00:00Z"), groupLogFile(g));
  const ran = async () => ({ ops: [{ op: "write", file: "scheduling-games.md", description: "games", text: "Games are on Thursdays.", evidence: "we play on Thursdays" }] });
  await createDreamer({ conversations: () => [groupConversation(g)], run: () => ran }).run(new Date("2026-10-14T07:00:00"));
  assert.equal(existsSync(join(groupNotesDir(g), "scheduling-games.md")), true, "the dream itself still works");
  assert.equal(peekConvDb(groupConvId(g))?.num("SELECT COUNT(*) FROM learned_changes") ?? 0, 0);
  assert.equal(L.recordDream(groupConvId(g), plan([{ kind: "add", file: "scheduling-games.md", description: "x", content: "", merged: [] }]), groupNotesDir(g), NOW), 0);
  L.recordInferred(groupConvId(g), "context-x.md", true, "x", NOW);
  assert.equal(L.planBatch(groupConvId(g), groupNotesDir(g), NOW), undefined);
  assert.equal(L.briefLearned(groupConvId(g), groupNotesDir(g), NOW), "");
  assert.equal(L.learnedFact(groupConvId(g), groupNotesDir(g), NOW), undefined);
  const tools = (createNotesServer({ dir: groupNotesDir(g), write: ["context"], maxNotes: 50 }, "group") as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance._registeredTools;
  assert.equal(tools.memory_changes_since_brief, undefined);
});

test("the owner's dream: what it applied is recorded and listed once (a forgotten note, a saved one), not what it skipped", async () => {
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
  writeFileSync(join(NOTES_DIR, "context-old.md"), "---\nname: old\nexpires: 2026-10-01\n---\n\nPitch booked for 1 Oct.\n");
  recordMessage("owner", 5, "Anna is my sister and her birthday is on 3 March", new Date("2026-10-13T20:00:00Z"));
  const ran = async () => ({ ops: [{ op: "write", file: "people-anna.md", description: "Anna is the owner's sister", text: "Anna is the sister.", evidence: "Anna is my sister" }, { op: "delete", file: "context-old.md", reason: "expired" }] });
  const { owner } = await import("../src/conversation/conversationmodel.ts");
  await createDreamer({ conversations: () => [owner()], run: () => ran }).run(new Date("2026-10-14T07:00:00"));
  const text = L.briefLearned(OWNER_CONV, NOTES_DIR, Date.parse("2026-10-14T08:00:00"));
  assert.match(text, /- people-anna: Anna is the owner's sister \(saved\)\n- context-old: expired \(forgotten\)/);
  L.briefDelivered(OWNER_CONV);
});

test("a whole-dream undo: lines not yet told are never listed; lines already told get one 'the dream of <day> was undone' note in the next list", () => {
  const c = friend();
  put(c.notesDir, "style-new.md", "Short replies", "y", "dream");
  const add = (file: string) => plan([{ kind: "add", file, description: "d", content: "", merged: [] }]);
  L.recordDream(c.convId, add("style-new.md"), c.notesDir, NOW);
  L.dreamUndone(c.convId, NOW + HOUR);
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW + HOUR), undefined, "never told: nothing to say, nothing listed");
  // told first, then undone
  L.recordDream(c.convId, add("style-new.md"), c.notesDir, NOW + 2 * HOUR);
  inferred(c, "people-anna.md", "Anna moved to Lisbon", NOW + 2 * HOUR);
  const first = L.briefLearned(c.convId, c.notesDir, NOW + 3 * HOUR);
  assert.match(first, /- style-new/);
  L.briefDelivered(c.convId);
  L.dreamUndone(c.convId, NOW + 4 * HOUR);
  inferred(c, "people-bo.md", "Bo has a new job", NOW + 4 * HOUR);
  const next = L.briefLearned(c.convId, c.notesDir, NOW + 20 * HOUR);
  assert.match(next, /^- people-bo: Bo has a new job \(inferred\)\n- the dream of 2026-10-22 was undone \(what it changed was put back\)$/);
  L.briefDelivered(c.convId);
  assert.equal(L.briefLearned(c.convId, c.notesDir, NOW + 40 * HOUR), "", "said once");
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
  assert.equal(undoLatest().ok, true);
  assert.equal(L.briefLearned(OWNER_CONV, NOTES_DIR, Date.parse("2026-10-15T08:00:00")), "", "its lines are never listed");
});

test("the brief tool is its own manifest action (not a read), and a list handed out for a brief that was never sent is offered again at the next one", async () => {
  const { entryFor } = await import("../src/policy/toolmanifest.ts");
  const { PREP_ACTIONS } = await import("../src/run/prep.ts");
  const action = entryFor("mcp__notes__memory_changes_since_brief")?.action;
  assert.equal(action, "memory-told");
  assert.equal(PREP_ACTIONS.has(action!), false, "the meeting prep run cannot consume it");
  const { writeStatusNote } = await import("../src/modules/status/statusnote.ts");
  const c = friend();
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  const first = L.briefLearned(c.convId, c.notesDir, NOW);
  inferred(c, "people-bo.md", "Bo has a new job", NOW + HOUR);
  const second = L.briefLearned(c.convId, c.notesDir, NOW + 2 * HOUR);
  assert.match(second, /^- people-anna[\s\S]*\n- people-bo/, "not delivered: the old line is offered again with the new one");
  assert.ok(first.includes("people-anna"));
  L.briefDelivered(c.convId);
  assert.equal(L.briefLearned(c.convId, c.notesDir, NOW + 30 * HOUR), "", "delivered: told");
  // the real trigger: the brief's status note saying delivered, for the owner
  mkdirSync(NOTES_DIR, { recursive: true });
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
  inferred({ convId: OWNER_CONV, notesDir: NOTES_DIR }, "people-di.md", "Di moved");
  assert.match(L.briefLearned(OWNER_CONV, NOTES_DIR, NOW), /people-di/);
  assert.match(L.briefLearned(OWNER_CONV, NOTES_DIR, NOW + HOUR), /people-di/, "still offered");
  assert.ok(writeStatusNote("brief", "status: started", new Date(NOW), NOTES_DIR).ok);
  assert.match(L.briefLearned(OWNER_CONV, NOTES_DIR, NOW + 2 * HOUR), /people-di/, "started is not delivered");
  assert.ok(writeStatusNote("brief", "status: delivered", new Date(NOW), NOTES_DIR).ok);
  assert.equal(L.briefLearned(OWNER_CONV, NOTES_DIR, NOW + 3 * HOUR), "");
});

test("a friend's look is handed what changed in her notes as a fact; it counts as told only once the look spoke, and an empty or stale list says nothing", () => {
  const c = friend();
  assert.equal(L.learnedFact(c.convId, c.notesDir, NOW), undefined, "nothing changed");
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  const f = L.learnedFact(c.convId, c.notesDir, NOW)!;
  assert.match(f.text, /- people-anna: Anna moved to Lisbon \(inferred\)/);
  assert.match(f.text, /forget <note>/);
  assert.ok(L.learnedFact(c.convId, c.notesDir, NOW + HOUR), "the look stayed silent: still owed");
  f.told();
  assert.equal(L.learnedFact(c.convId, c.notesDir, NOW + 2 * HOUR), undefined, "told once");
  inferred(c, "people-old.md", "Very old", NOW - 8 * 86_400_000);
  assert.equal(L.learnedFact(c.convId, c.notesDir, NOW), undefined, "a stale change is dropped without a word");
});
