import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "What I learned overnight" (src/memory/learned.ts, conversation/learned.ts, conversation/learnedreplies.ts): the quiet memory changes (the dream, inferred notes) are recorded where they happen, listed ONCE as a
// numbered, code-written list (the owner's brief tool, a friend's message after her dream, held by quiet hours), and answered by "confirm N" / "undo N" in code. A group has none.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "learned-test-"));

const L = await import("../src/memory/learned.ts");
const { learnedReply, parseLearned } = await import("../src/conversation/learnedreplies.ts");
const { offerLearned, setLearnedRuntime } = await import("../src/conversation/learned.ts");
const { writeInferredNote } = await import("../src/memory/inferred.ts");
const { noteContent } = await import("../src/memory/dreamplan.ts");
const { createNotesServer } = await import("../src/modules/memory/notestools.ts");
const { createDreamer } = await import("../src/conversation/dream.ts");
const { group: groupConversation } = await import("../src/conversation/conversationmodel.ts");
const { groupDir, groupLogFile, groupNotesDir } = await import("../src/conversation/groupstore.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { NOTES_DIR, parseNote } = await import("../src/memory/notes.ts");
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
const originOf = (dir: string, file: string) => /origin: (\w+)/.exec(readFileSync(join(dir, file), "utf8"))![1];
const inferred = (c: { convId: string; notesDir: string }, file: string, description: string, at = NOW) => {
  const r = writeInferredNote({ file, text: description, description }, { dir: c.notesDir, categories: ["people", "context"], maxNotes: 50, now: new Date(at) });
  assert.ok(r.ok);
  L.recordInferred(c.convId, r.file, r.created, r.gist, at);
};
const plan = (actions: object[]) => ({ actions, rejected: [] }) as never;
const said = () => {
  const out: string[] = [];
  return { out, say: async (t: string) => void out.push(t) };
};
const msg = (text: string, ts?: number) => ({ text, ...(ts ? { quote: { timestamp: ts, author: "x", text: "" } } : {}) }) as never;

test("the list: dream changes and inferred notes, one numbered line each with the note name and gist; merges are one line and a merge's own deletes are not listed twice", () => {
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
    "1. style-new: Short replies (saved)",
    "2. triage-merged: Triage rules (merged 2 notes)",
    "3. context-old: expired (forgotten)",
    "4. people-lena: Lena moved to Lisbon (inferred)",
  ]);
  assert.match(L.learnedMessage(b.items), /^🧠 Learned overnight\n1\. [\s\S]*\n4\. people-lena: .*\nReply 'undo 1' to take one back or 'confirm 4' to keep an inferred note as yours\.$/);
});

test("no repeats: a list is told once; the brief tool hands the same list out again only inside the redo window; later changes make a new list", () => {
  const c = friend();
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  const first = L.briefLearned(c.convId, c.notesDir, NOW);
  assert.match(first, /^1\. people-anna: Anna moved to Lisbon \(inferred\)\nReply 'undo 1'/);
  assert.equal(L.briefLearned(c.convId, c.notesDir, NOW + HOUR), first, "the brief was redone: the same list");
  assert.equal(L.briefLearned(c.convId, c.notesDir, NOW + 7 * HOUR), "", "told; nothing new");
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW + 7 * HOUR), undefined);
  inferred(c, "people-bo.md", "Bo has a new job", NOW + 8 * HOUR);
  assert.match(L.briefLearned(c.convId, c.notesDir, NOW + 9 * HOUR), /^1\. people-bo: Bo has a new job \(inferred\)/, "numbering restarts in each list");
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
  assert.deepEqual(b.items.map((i) => L.lineOf(i)), ["1. people-anna: Anna moved to Porto (inferred)"]);
  L.commitBatch(c.convId, b, NOW);
  assert.equal(L.planBatch(c.convId, c.notesDir, NOW), undefined, "the dropped ones are settled too");
});

test("confirm N: the inferred note becomes the person's (origin owner, index line without 'inferred'), announced with the memory notice", async () => {
  const c = friend();
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  assert.match(readFileSync(join(c.notesDir, "MEMORY.md"), "utf8"), /Anna moved to Lisbon \(inferred\)/);
  const b = L.planBatch(c.convId, c.notesDir, NOW)!;
  L.commitBatch(c.convId, b, NOW, 5_000);
  const s = said();
  assert.equal(await learnedReply(c, msg("confirm 1", 5_000), s.say, NOW + HOUR), true);
  assert.equal(originOf(c.notesDir, "people-anna.md"), "owner");
  assert.equal(parseNote("people-anna.md", readFileSync(join(c.notesDir, "people-anna.md"), "utf8"))!.inferred, undefined);
  assert.doesNotMatch(readFileSync(join(c.notesDir, "MEMORY.md"), "utf8"), /inferred/);
  assert.match(s.out[0]!, /^🧠 Memory\n✅ confirmed people-anna\.md: Anna moved to Lisbon\nWrong\? Tell me to undo it\.$/);
  const again = said();
  await learnedReply(c, msg("confirm 1", 5_000), again.say, NOW + HOUR);
  assert.match(again.out[0]!, /already confirmed/);
});

test("undo N: an inferred note is forgotten (it was the assistant's own guess); one the person confirmed meanwhile is left; a dream change points at undoing the whole night", async () => {
  const c = friend();
  put(c.notesDir, "style-new.md", "Short replies", "y", "dream");
  L.recordDream(c.convId, plan([{ kind: "add", file: "style-new.md", description: "Short replies", content: "", merged: [] }]), c.notesDir, NOW);
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  inferred(c, "people-bo.md", "Bo has a new job");
  L.commitBatch(c.convId, L.planBatch(c.convId, c.notesDir, NOW)!, NOW);
  put(c.notesDir, "people-bo.md", "Bo has a new job", "y", "owner"); // confirmed in chat meanwhile
  const s = said();
  assert.equal(await learnedReply(c, msg("undo 2 and 3"), s.say, NOW + HOUR), true, "no quote: the latest list");
  assert.equal(existsSync(join(c.notesDir, "people-anna.md")), false);
  assert.doesNotMatch(readFileSync(join(c.notesDir, "MEMORY.md"), "utf8"), /people-anna/);
  assert.match(s.out.join("\n"), /Forgot people-anna \(it was my own guess\)/);
  assert.match(s.out.join("\n"), /3\. people-bo is not a guess of mine any more/);
  assert.equal(existsSync(join(c.notesDir, "people-bo.md")), true);
  const d = said();
  await learnedReply(c, msg("undo 1"), d.say, NOW + HOUR);
  assert.match(d.out.join("\n"), /came from the nightly dream/);
  assert.match(d.out.join("\n"), /only be undone as a whole night/);
  assert.equal(existsSync(join(c.notesDir, "style-new.md")), true, "nothing was touched");
});

test("a bare 'undo' asks which, only right after a list or when it quotes one; a number not on the list, an old list, a quote of another message and a group are ordinary messages or told so", async () => {
  const c = friend();
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  L.commitBatch(c.convId, L.planBatch(c.convId, c.notesDir, NOW)!, NOW, 7_000);
  let s = said();
  assert.equal(await learnedReply(c, msg("undo"), s.say, NOW + 60_000), true);
  assert.match(s.out[0]!, /Undo which one\?/);
  s = said();
  assert.equal(await learnedReply(c, msg("undo"), s.say, NOW + HOUR), false, "an hour later a bare undo is the model's (undo_dream)");
  s = said();
  assert.equal(await learnedReply(c, msg("undo", 7_000), s.say, NOW + HOUR), true, "quoting the list it is clear which one it is about");
  assert.equal(await learnedReply(c, msg("undo 1", 9_999), said().say, NOW), false, "quotes some other message");
  s = said();
  await learnedReply(c, msg("undo 7"), s.say, NOW + HOUR);
  assert.match(s.out[0]!, /#7 is not on that list/);
  assert.equal(await learnedReply(c, msg("undo 1"), said().say, NOW + 3 * 86_400_000), false, "a list older than two days no longer answers");
  assert.equal(await learnedReply({ ...c, kind: "group" }, msg("undo 1"), said().say, NOW), false);
  assert.equal(await learnedReply(c, msg("please undo 1 for me"), said().say, NOW), false);
  assert.deepEqual([parseLearned("Undo #1, 3"), parseLearned("confirm 1 and 2."), parseLearned("undo all")], [{ verb: "undo", nums: [1, 3] }, { verb: "confirm", nums: [1, 2] }, undefined]);
});

test("a friend: one message after her dream with the quote-able numbers; quiet hours hold it and the next look sends it; an empty list says nothing", async () => {
  const c = friend();
  const sent: { text: string }[] = [];
  let quiet = true;
  let ts = 100;
  setLearnedRuntime({ send: async (_c, text) => (sent.push({ text }), ++ts), holding: () => quiet });
  const conv = c as never;
  assert.equal(await offerLearned(conv, new Date(NOW), { afterDream: true }), "none", "nothing changed: no message");
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  assert.equal(await offerLearned(conv, new Date(NOW), { afterDream: true }), "held");
  assert.equal(sent.length, 0);
  quiet = false;
  assert.equal(await offerLearned(conv, new Date(NOW + 5 * HOUR)), "sent", "the next look after quiet hours");
  assert.match(sent[0]!.text, /^🧠 Learned overnight\n1\. people-anna: Anna moved to Lisbon \(inferred\)/);
  assert.equal(await offerLearned(conv, new Date(NOW + 6 * HOUR), { afterDream: true }), "none", "told once");
  const s = said();
  await learnedReply(c, msg("undo 1", 101), s.say, NOW + 6 * HOUR);
  assert.equal(existsSync(join(c.notesDir, "people-anna.md")), false, "the quoted message's number");
  // an inferred note saved at noon is not announced by a look; the next dream does
  inferred(c, "people-bo.md", "Bo has a new job", NOW + 6 * HOUR);
  assert.equal(await offerLearned(conv, new Date(NOW + 6 * HOUR)), "none");
  assert.equal(await offerLearned(conv, new Date(NOW + 20 * HOUR), { afterDream: true }), "sent");
  setLearnedRuntime(undefined);
});

test("the owner's brief tool: the code-written text in markers, empty when nothing changed, only for the owner's notes", async () => {
  mkdirSync(NOTES_DIR, { recursive: true });
  const tools = (dir: string) => (createNotesServer({ dir, write: ["people"], maxNotes: 50 }, "background") as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, x: object) => Promise<{ content: { text: string }[] }> }> } }).instance._registeredTools;
  const t = tools(NOTES_DIR);
  assert.ok(t.memory_changes_since_brief);
  assert.match((await t.memory_changes_since_brief!.handler({}, {})).content[0]!.text, /Nothing changed on its own/);
  // the look's write_note records the change; the brief tool lists it
  const w = await t.write_note!.handler({ file: "people-anna.md", text: "Anna moved to Lisbon.", description: "Anna moved to Lisbon" }, {});
  assert.match(w.content[0]!.text, /Saved people-anna.md as inferred/);
  const out = (await t.memory_changes_since_brief!.handler({}, {})).content[0]!.text;
  assert.match(out, /1\. people-anna: Anna moved to Lisbon \(inferred\)\nReply 'undo 1' to take one back or 'confirm 1'/);
  assert.match(out, /<learned>|learned/);
  assert.match((await t.memory_changes_since_brief!.handler({}, {})).content[0]!.text, /people-anna/, "a redone brief gets the same list");
  const f = friend();
  assert.equal(tools(f.notesDir).memory_changes_since_brief, undefined, "a friend has no brief");
});

test("groups are off: a group's dream and inferred notes record nothing, and a reply is never read against a list", async () => {
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
  const s = said();
  assert.equal(await learnedReply({ kind: "group", convId: groupConvId(g), notesDir: groupNotesDir(g) }, msg("undo 1"), s.say, NOW), false);
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
  assert.match(text, /1\. people-anna: Anna is the owner's sister \(saved\)\n2\. context-old: expired \(forgotten\)\nReply 'undo 1'/);
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
  assert.match(first, /1\. style-new/);
  L.dreamUndone(c.convId, NOW + 4 * HOUR);
  inferred(c, "people-bo.md", "Bo has a new job", NOW + 4 * HOUR);
  const next = L.briefLearned(c.convId, c.notesDir, NOW + 20 * HOUR);
  assert.match(next, /^1\. people-bo: Bo has a new job \(inferred\)\n- the dream of 2026-10-22 was undone \(what it changed was put back\)\nReply 'undo 1'/);
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

test("a friend's held list is owed in her assistant.db, not in memory: it survives a restart and is cleared once sent", async () => {
  const c = friend();
  let quiet = true;
  setLearnedRuntime({ send: async () => 1, holding: () => quiet });
  inferred(c, "people-anna.md", "Anna moved to Lisbon");
  assert.equal(L.isOwed(c.convId), false);
  assert.equal(await offerLearned(c as never, new Date(NOW), { afterDream: true }), "held");
  assert.equal(L.isOwed(c.convId), true);
  assert.equal(peekConvDb(c.convId)!.num("SELECT COUNT(*) FROM learned_owed"), 1, "a row, so a restart keeps it");
  quiet = false;
  assert.equal(await offerLearned(c as never, new Date(NOW + HOUR)), "sent", "a look, with no dream change waiting, still sends what is owed");
  assert.equal(L.isOwed(c.convId), false);
  setLearnedRuntime(undefined);
});
