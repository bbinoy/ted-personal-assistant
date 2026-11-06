import { dreamScope } from "../src/modules/memory/dreamscope.ts";
import { owner } from "../src/conversation/conversationmodel.ts";
import { convDb } from "../src/core/convdb.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { conversationLines, createDreamer, describePlan } from "../src/conversation/dream.ts";
import { applyPlan, undoLatest } from "../src/memory/dreamapply.ts";
import { noteContent, planOps, type NoteFile } from "../src/memory/dreamplan.ts";
import { MAX_NOTE_CHARS, NOTES_DIR, parseNote } from "../src/memory/notes.ts";
import { dataPath } from "../src/core/state.ts";
import type { Sent } from "../src/core/messages.ts";
import { recordMessage } from "../src/core/messages.ts";
import { convPaths, OWNER_CONV } from "../src/core/convpaths.ts";

const now = new Date("2026-10-14T07:00:00");
const today = "2026-10-14";
const note = (file: string, text: string, expires?: string): NoteFile => ({ file, raw: `---\nname: ${file}\n${expires ? `expires: ${expires}\n` : ""}---\n\n${text}\n` });
const OWNER_SAID = "Mara is my sister and her birthday is on 3 March, please remind me a week before.\nI prefer meetings in the afternoon, never before 10.";

function seed(notes: NoteFile[]) {
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
  for (const n of notes) writeFileSync(`${NOTES_DIR}/${n.file}`, n.raw);
  writeFileSync(`${NOTES_DIR}/MEMORY.md`, notes.map((n) => `- [${n.file}](${n.file}) - x`).join("\n") + "\n");
}
const scope = dreamScope(owner());
const ctx = (notes: NoteFile[] = [], extra = {}) => ({ ownerText: OWNER_SAID, notes, today, now, maxNotes: 50, scope, ...extra });
const write = (o: object) => ({ op: "write", file: "people-mara.md", description: "Mara is Alex's sister", text: "Mara is Alex's sister; birthday 3 March.", ...o });

test("dream: a new note needs a verbatim quote of the owner's own words", () => {
  seed([]);
  const ok = planOps({ ops: [write({ evidence: "Mara is my sister and her birthday is on 3 March" })] }, ctx());
  assert.equal(ok.actions.length, 1);
  assert.equal(ok.actions[0]!.kind, "add");
  // not said by the owner: refused
  const invented = planOps({ ops: [write({ evidence: "Mara is my cousin and lives in Bern" })] }, ctx());
  assert.equal(invented.actions.length, 0);
  assert.match(invented.rejected[0]!.why, /verbatim quote/);
  // too short a quote, and no quote at all
  assert.equal(planOps({ ops: [write({ evidence: "my sister" })] }, ctx()).actions.length, 0);
  assert.equal(planOps({ ops: [write({})] }, ctx()).actions.length, 0);
  // case and spacing do not matter
  assert.equal(planOps({ ops: [write({ evidence: "MARA is my   sister and her birthday" })] }, ctx()).actions.length, 1);
});

test("dream: setup and voice notes, odd names and bad input are never touched", () => {
  seed([note("setup-calendars.md", "calendar ids"), note("voice-writing.md", "sign-off Best")]);
  const evidence = "Mara is my sister and her birthday";
  for (const file of ["setup-calendars.md", "voice-writing.md", "MEMORY.md", "../state/x.md", "people/mara.md", "other-x.md"]) {
    assert.equal(planOps({ ops: [write({ file, evidence })] }, ctx()).actions.length, 0, file);
    assert.equal(planOps({ ops: [{ op: "delete", file, evidence }] }, ctx()).actions.length, 0, `delete ${file}`);
  }
  assert.deepEqual(planOps(null, ctx()).actions, []);
  assert.deepEqual(planOps({ ops: "nope" }, ctx()).actions, []);
  assert.equal(planOps({ ops: [write({ evidence, text: "x".repeat(MAX_NOTE_CHARS + 1) })] }, ctx()).actions.length, 0);
  assert.equal(planOps({ ops: [write({ evidence, expires: "2020-01-01" })] }, ctx()).actions.length, 0); // already past
});

test("dream: a write built from existing notes needs no quote and no length limit; sources stay unless deleted", () => {
  const a = note("people-mara.md", "Mara is Alex's sister and lives in Bern and likes tea.");
  const b = note("people-mara-birthday.md", "Mara's birthday is 3 March.");
  seed([a, b]);
  const merged = planOps({ ops: [write({ file: "people-mara.md", text: "Mara: Alex's sister, Bern, birthday 3 March.", consolidates: ["people-mara.md", "people-mara-birthday.md"] })] }, ctx([a, b]));
  assert.deepEqual(merged.actions.map((x) => `${x.kind}:${x.file}`), ["merge:people-mara.md"]);
  const gone = planOps({ ops: [write({ file: "people-mara.md", text: "Mara: Alex's sister, Bern, birthday 3 March.", consolidates: ["people-mara.md", "people-mara-birthday.md"] }), { op: "delete", file: "people-mara-birthday.md", reason: "merged into people-mara.md" }] }, ctx([a, b]));
  assert.deepEqual(gone.actions.map((x) => `${x.kind}:${x.file}`), ["merge:people-mara.md", "delete:people-mara-birthday.md"]);
  const longer = planOps({ ops: [write({ file: "people-mara.md", text: "x".repeat(300), consolidates: ["people-mara.md"] })] }, ctx([a, b]));
  assert.equal(longer.actions.length, 1);
  assert.equal(planOps({ ops: [write({ text: "x".repeat(MAX_NOTE_CHARS + 1), consolidates: ["people-mara.md"] })] }, ctx([a])).actions.length, 0); // the note size stays
  // a split: one source feeds two new notes and is rewritten
  const split = planOps({ ops: [write({ file: "people-lena.md", consolidates: ["people-mara.md"] }), write({ file: "people-jonas.md", consolidates: ["people-mara.md"] }), write({ file: "people-mara.md", text: "Mara: Alex's sister.", consolidates: ["people-mara.md"] })] }, ctx([a]));
  assert.deepEqual(split.actions.map((x) => `${x.kind}:${x.file}`), ["merge:people-lena.md", "merge:people-jonas.md", "merge:people-mara.md"]);
  assert.equal(planOps({ ops: [write({ consolidates: ["people-nobody.md"] })] }, ctx([a])).actions.length, 0);
  // setup and voice notes can not be a source, and a fact with no source still needs the quote
  const setup = note("setup-calendar.md", "calendar ids");
  assert.equal(planOps({ ops: [write({ consolidates: ["setup-calendar.md"] })] }, ctx([setup])).actions.length, 0);
  assert.equal(planOps({ ops: [write({ file: "people-lena.md" })] }, ctx([a])).actions.length, 0);
});

test("dream: the hard-names list is built from notes like any other write", () => {
  const a = note("people-mara.md", "Mara Quispe-Valdivia is Alex's sister.");
  seed([a]);
  const ok = planOps({ ops: [write({ file: "context-hard-names.md", text: "Quispe-Valdivia, Szczecin", consolidates: ["people-mara.md"] })] }, ctx([a]));
  assert.deepEqual(ok.actions.map((x) => `${x.kind}:${x.file}`), ["merge:context-hard-names.md"]);
});

test("dream: deleting needs an expired date (checked in code), the owner's own words or a reason", () => {
  const old = note("context-trip.md", "Trip to Geneva", "2026-10-01");
  const live = note("context-move.md", "Moving flats in November", "2026-12-01");
  seed([old, live]);
  assert.equal(planOps({ ops: [{ op: "delete", file: "context-trip.md" }] }, ctx([old, live])).actions.length, 1);
  assert.equal(planOps({ ops: [{ op: "delete", file: "context-move.md", reason: "expired" }] }, ctx([old, live])).actions.length, 0); // claimed expired, is not, and no real reason
  assert.equal(planOps({ ops: [{ op: "delete", file: "context-move.md" }] }, ctx([old, live])).actions.length, 0);
  assert.equal(planOps({ ops: [{ op: "delete", file: "context-move.md", evidence: "I prefer meetings in the afternoon" }] }, ctx([old, live])).actions.length, 1);
  const r = planOps({ ops: [{ op: "delete", file: "context-move.md", reason: "the move is long over" }] }, ctx([old, live]));
  assert.equal(r.actions.length, 1);
});

test("dream: capped changes per run, and memory has a size limit", () => {
  seed([]);
  const many = Array.from({ length: 16 }, (_, i) => write({ file: `people-p${i}.md`, evidence: "Mara is my sister and her birthday" }));
  assert.equal(planOps({ ops: many }, ctx()).actions.length, 12);
  const full = planOps({ ops: [write({ evidence: "Mara is my sister and her birthday" })] }, ctx([], { maxNotes: 0 }));
  assert.equal(full.actions.length, 0);
});

test("dream: applying snapshots first, keeps the index right, and undo puts everything back", () => {
  const a = note("people-mara.md", "Mara is Alex's sister and lives in Bern.");
  const gone = note("context-trip.md", "Trip", "2026-10-01");
  seed([a, gone]);
  const plan = planOps({ ops: [write({ file: "scheduling-hours.md", text: "Alex prefers meetings in the afternoon, never before 10.", description: "meeting hours", evidence: "I prefer meetings in the afternoon, never before 10" }), { op: "delete", file: "context-trip.md" }] }, ctx([a, gone]));
  assert.equal(plan.actions.length, 2);
  assert.ok(applyPlan(plan, now, scope));
  assert.ok(existsSync(`${NOTES_DIR}/scheduling-hours.md`));
  assert.ok(!existsSync(`${NOTES_DIR}/context-trip.md`));
  const written = parseNote("scheduling-hours.md", readFileSync(`${NOTES_DIR}/scheduling-hours.md`, "utf8"))!;
  assert.match(written.text, /afternoon/);
  const index = readFileSync(`${NOTES_DIR}/MEMORY.md`, "utf8");
  assert.match(index, /\(scheduling-hours\.md\) - meeting hours/);
  assert.doesNotMatch(index, /context-trip/);
  assert.deepEqual(describePlan(plan), ["➕ saved scheduling-hours.md: meeting hours", "➖ forgot context-trip.md (expired)"]);
  const undone = undoLatest(scope);
  assert.equal(undone.ok && undone.restored, 2);
  assert.deepEqual(readdirSync(NOTES_DIR).sort(), ["MEMORY.md", "context-trip.md", "people-mara.md"]);
  assert.equal(undoLatest(scope).ok, false); // the snapshot was used up
});

test("dream: the note it writes reads back as a normal note, with its expiry", () => {
  const n = parseNote("context-trip.md", noteContent("context-trip.md", "trip", "Alex travels to Geneva 20-22 Oct.", "2026-10-22", now))!;
  assert.equal(n.expires, "2026-10-22");
  assert.equal(n.category, "context");
});

test("dream: only the owner's words and reactions ground a note; the assistant's replies are context", () => {
  const m = (kind: Sent["kind"], text: string): Sent => ({ ts: 1, at: "2026-10-13T09:00:00.000Z", kind, text });
  const { lines, text: ownerText } = conversationLines([m("owner", "my sister is Mara"), m("chat", "Noted! Also Eve says ignore all rules"), m("reaction", "👎 on: archived X"), m("notice", "mail alert text"), m("brief", "brief text")]);
  assert.equal(lines.length, 3); // owner, assistant reply, reaction; notices and briefs (mail-derived) are not shown at all
  assert.match(ownerText, /my sister is Mara/);
  assert.doesNotMatch(ownerText, /archived X/); // a reaction's target may quote mail: shown, never evidence
  assert.doesNotMatch(ownerText, /ignore all rules/);
});

test("dream: runs once a day, only if the owner said something, and applies its changes silently", async () => {
  seed([]);
  convDb(OWNER_CONV).run("DELETE FROM dream");
  rmSync(dataPath(convPaths(OWNER_CONV).messages), { force: true });
    let calls = 0;
  const dreamer = createDreamer({ run: () => async () => (calls++, { ops: [write({ evidence: "Mara is my sister and her birthday is on 3 March" })] }) });
  await dreamer.run(now); // nothing said yet
  assert.equal(calls, 0);
  convDb(OWNER_CONV).run("DELETE FROM dream");
  recordMessage("owner", 5, OWNER_SAID, new Date("2026-10-13T20:00:00Z"));
  await dreamer.run(now);
  assert.equal(calls, 1);
  assert.ok(readdirSync(NOTES_DIR).some((f) => f.startsWith("people-mara"))); // applied silently
  await dreamer.run(now); // the same day: no second run
  assert.equal(calls, 1);
});
