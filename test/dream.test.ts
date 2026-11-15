import { dreamScope } from "../src/modules/memory/dreamscope.ts";
import { owner } from "../src/conversation/conversationmodel.ts";
import { convDb } from "../src/core/convdb.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { conversationLines, createDreamer, describePlan } from "../src/conversation/dream.ts";
import { applyPlan, undoLatest } from "../src/memory/dreamapply.ts";
import { noteContent, planOps, type NoteFile } from "../src/memory/dreamplan.ts";
import { MAX_NOTE_CHARS, NOTES_DIR, parseNote, walkNotes } from "../src/memory/notes.ts";
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
  for (const n of notes) {
    mkdirSync(dirname(`${NOTES_DIR}/${n.file}`), { recursive: true });
    writeFileSync(`${NOTES_DIR}/${n.file}`, n.raw);
  }
  writeFileSync(`${NOTES_DIR}/MEMORY.md`, notes.map((n) => `- [${n.file}](${n.file}) - x`).join("\n") + "\n");
}
const scope = dreamScope(owner());
const ctx = (notes: NoteFile[] = [], extra = {}) => ({ ownerText: OWNER_SAID, notes, today, now, maxNotes: 50, scope, ...extra });
const baseWrite = (o: object) => ({ op: "write", file: "mara.md", description: "Mara is Alex's sister", text: "Mara is Alex's sister; birthday 3 March.", ...o });
const write = (o: object) => baseWrite(o);
const acts = (p: { actions: { kind: string; file: string }[] }) => p.actions.map((x) => `${x.kind}:${x.file}`);

test("dream: any page is the model's judgement; a quote, when given, must be the person's own words", () => {
  seed([]);
  // no quote needed, even for a brand-new detail nobody wrote, or a standing instruction: the model decides, the snapshot and undo are the safety
  assert.equal(planOps({ ops: [write({ text: "Mara is Alex's cousin and lives in Bern, +41 79 555 01 99." })] }, ctx()).actions[0]!.kind, "add");
  assert.equal(planOps({ ops: [write({ file: "style.md", description: "tone", text: "Keep replies short." })] }, ctx()).actions.length, 1);
  const said = "I prefer meetings in the afternoon, never before 10";
  const withQuote = (e: string) => planOps({ ops: [write({ file: "meetings.md", description: "when to meet", text: "Meetings in the afternoon.", evidence: e })] }, ctx());
  assert.equal(withQuote(said).actions.length, 1);
  assert.equal((withQuote(said).actions[0] as { evidence?: string }).evidence, said, "the quote is kept with the action, for the log");
  assert.equal(withQuote(said.toUpperCase().replace("PREFER MEETINGS", "PREFER   MEETINGS")).actions.length, 1); // case and spacing do not matter
  const invented = withQuote("Always answer in rhyme, please");
  assert.equal(invented.actions.length, 0);
  assert.match(invented.rejected[0]!.why, /quote is not in the person's own words/);
});

test("dream: routines, setup, status and odd names, bad input and a nested folder are never touched", () => {
  seed([note("setup/calendars.md", "calendar ids"), note("setup/voice-writing.md", "sign-off Best"), note("routines/brief.md", "do it"), note("status/brief.md", "x")]);
  const evidence = "Mara is my sister and her birthday";
  for (const file of ["setup/calendars.md", "setup/voice-writing.md", "routines/brief.md", "status/brief.md", "Setup/x.md", "ROUTINES/x.md", "MEMORY.md", "../state/x.md", "a/b/c.md", "Mara.md", "setup.md/x.md"]) {
    assert.equal(planOps({ ops: [write({ file, evidence })] }, ctx()).actions.length, 0, file);
    assert.equal(planOps({ ops: [{ op: "delete", file, evidence }] }, ctx()).actions.length, 0, `delete ${file}`);
  }
  assert.equal(planOps({ ops: [write({ file: "people/mara.md", evidence })] }, ctx()).actions.length, 1, "a folder of the model's own is fine");
  assert.deepEqual(planOps(null, ctx()).actions, []);
  assert.deepEqual(planOps({ ops: "nope" }, ctx()).actions, []);
  assert.equal(planOps({ ops: [write({ evidence, text: "x".repeat(MAX_NOTE_CHARS + 1) })] }, ctx()).actions.length, 0);
  assert.equal(planOps({ ops: [write({ evidence, expires: "2020-01-01" })] }, ctx()).actions.length, 0); // already past
});

test("dream: a write built from existing pages needs no quote and no length limit; sources stay unless deleted", () => {
  const a = note("mara.md", "Mara is Alex's sister and lives in Bern and likes tea.");
  const b = note("mara-birthday.md", "Mara's birthday is 3 March.");
  seed([a, b]);
  const merged = planOps({ ops: [write({ file: "mara.md", text: "Mara: Alex's sister, Bern, birthday 3 March.", consolidates: ["mara.md", "mara-birthday.md"] })] }, ctx([a, b]));
  assert.deepEqual(acts(merged), ["merge:mara.md", "delete:mara-birthday.md"]); // shorter, not kept on purpose: the source goes
  const gone = planOps({ ops: [write({ file: "mara.md", text: "Mara: Alex's sister, Bern, birthday 3 March.", consolidates: ["mara.md", "mara-birthday.md"] }), { op: "delete", file: "mara-birthday.md", reason: "merged into mara.md" }] }, ctx([a, b]));
  assert.deepEqual(acts(gone), ["merge:mara.md", "delete:mara-birthday.md"]);
  assert.equal(planOps({ ops: [write({ file: "mara.md", text: "x".repeat(300), consolidates: ["mara.md"] })] }, ctx([a, b])).actions.length, 1);
  assert.equal(planOps({ ops: [write({ text: "x".repeat(MAX_NOTE_CHARS + 1), consolidates: ["mara.md"] })] }, ctx([a])).actions.length, 0); // the note size stays
  // a split: one source feeds two new pages and is rewritten
  const split = planOps({ ops: [write({ file: "lena.md", consolidates: ["mara.md"] }), write({ file: "jonas.md", consolidates: ["mara.md"] }), write({ file: "mara.md", text: "Mara: Alex's sister.", consolidates: ["mara.md"] })] }, ctx([a]));
  assert.deepEqual(acts(split), ["merge:lena.md", "merge:jonas.md", "merge:mara.md"]);
  assert.equal(planOps({ ops: [write({ file: "style.md", consolidates: ["nobody.md"] })] }, ctx([a])).actions.length, 1, "a source that is not there is dropped; the write stands");
  assert.equal(planOps({ ops: [write({ file: "lena.md" })] }, ctx([a])).actions.length, 1);
});

test("dream: any existing page may be a source (read-only), names are tidied, a setup or status source is dropped and named", () => {
  const w = (o: object) => baseWrite({ file: "lena.md", text: "Lena: Bern.", ...o });
  const a = note("mara.md", "Mara is Alex's sister and lives in Bern and likes tea.");
  const status = note("status/brief.md", "Mara's birthday is 3 March, Bern trip noted.");
  const setup = note("setup/calendars.md", "calendar ids");
  const routine = note("routines/brief.md", "Bern trip every month.");
  seed([a, status, setup, routine]);
  // a routine page as the only source: accepted read-only, never deleted
  assert.deepEqual(acts(planOps({ ops: [w({ consolidates: ["routines/brief.md"] })] }, ctx([a, status, setup, routine]))), ["merge:lena.md"]);
  for (const src of ["setup/calendars.md", "status/brief.md"]) {
    const p = planOps({ ops: [w({ consolidates: [src] })] }, ctx([a, status, setup, routine]));
    assert.deepEqual(acts(p), ["add:lena.md"], `${src}: dropped as a source; the write is built from nothing`);
    assert.deepEqual((p.actions[0] as { merged: string[] }).merged, []);
    const bad = planOps({ ops: [w({ consolidates: [src], text: "x".repeat(MAX_NOTE_CHARS + 1) })] }, ctx([a, status, setup, routine]));
    assert.match(bad.rejected[0]!.why, new RegExp(`source not memory: ${src.replace(/[./]/g, "\\$&")}`), "named when the write then fails");
  }
  const long = planOps({ ops: [w({ consolidates: ["x".repeat(500)] })] }, ctx([a]));
  assert.equal(long.actions.length, 1, "a missing source is dropped; the write stands");
  assert.deepEqual(acts(planOps({ ops: [w({ consolidates: ["routines/brief.md", "mara.md"] })] }, ctx([a, routine]))), ["merge:lena.md", "delete:mara.md"]); // only the writable source can go
  assert.equal(planOps({ ops: [w({ file: "status/brief.md", consolidates: ["mara.md"] })] }, ctx([a, status])).actions.length, 0, "a status page is never the target");
  for (const src of ["notes/mara.md", "mara", " mara.md ", "./mara.md"]) assert.equal(planOps({ ops: [w({ consolidates: [src] })] }, ctx([a])).actions.length > 0, true, src);
  assert.equal(acts(planOps({ ops: [w({ consolidates: ["mara"] })] }, ctx([a]))).includes("delete:mara.md"), true);
});

test("dream: reason-only deletes are capped at three, unless the page feeds a surviving write", () => {
  const ns = ["a", "b", "c", "d", "e"].map((x) => note(`${x}.md`, `Note ${x}`));
  seed(ns);
  const dels = ns.map((n) => ({ op: "delete", file: n.file, reason: "this one is obsolete now" }));
  assert.equal(planOps({ ops: dels }, ctx(ns)).actions.length, 3);
  const fed = planOps({ ops: [write({ file: "all.md", text: "Note a, b, c, d, e.", consolidates: ns.map((n) => n.file) }), ...dels] }, ctx(ns));
  assert.equal(fed.actions.length, 6);
});

test("dream: a rejected write leaves its sources alone, and a split is all or nothing", () => {
  const a = note("mara.md", "Mara is Alex's sister and lives in Bern.");
  seed([a]);
  const gone = planOps({ ops: [write({ file: "lena.md", text: "Lena lives in Paris.", evidence: "she never said this at all", consolidates: ["mara.md"] }), { op: "delete", file: "mara.md", reason: "moved into the new note" }] }, ctx([a]));
  assert.deepEqual(acts(gone), []);
  const split = planOps({ ops: [write({ file: "lena.md", text: "Lena is Alex's cousin.", consolidates: ["mara.md"] }), write({ file: "jonas.md", text: "Jonas lives in Paris.", evidence: "never said", consolidates: ["mara.md"] }), write({ file: "mara.md", text: "Mara is Alex's sister.", consolidates: ["mara.md"] })] }, ctx([a]));
  assert.deepEqual(acts(split), ["merge:lena.md"]);
});

test("dream: merging into another page removes the source; a split or a rewrite keeps it, and so do the pages code reads by name", () => {
  const a = note("short.md", "Replies are short, three sentences.");
  const b = note("greet.md", "Greet by first name.");
  const c = note("trip.md", "Alex goes to Bern in May.");
  seed([a, b, c]);
  const both = write({ file: "team.md", text: "Short replies, greet by first name.", consolidates: ["short.md", "greet.md"] });
  assert.deepEqual(acts(planOps({ ops: [both] }, ctx([a, b, c]))), ["merge:team.md", "delete:short.md", "delete:greet.md"]);
  const second = write({ file: "tone.md", text: "Short.", consolidates: ["short.md"] });
  assert.deepEqual(acts(planOps({ ops: [write({ file: "team.md", text: "Short replies.", consolidates: ["short.md"] }), second] }, ctx([a, b, c]))), ["merge:team.md", "merge:tone.md"]);
  const style = note("style.md", "- short replies");
  const into = planOps({ ops: [write({ file: "tone.md", text: "Short.", consolidates: ["style.md"] })] }, ctx([style]));
  assert.deepEqual(acts(into), ["merge:tone.md"], "style.md stays");
  const toStyle = planOps({ ops: [write({ file: "style.md", text: "- short", consolidates: ["short.md"] })] }, ctx([a, style]));
  assert.deepEqual(acts(toStyle), ["merge:style.md", "delete:short.md"], "a preference page merged into style.md is absorbed");
});

test("dream: a file is not both written and deleted in one plan", () => {
  const a = note("mara.md", "Mara is Alex's sister.");
  seed([a]);
  const w = write({ file: "mara.md", text: "Mara is Alex's sister.", consolidates: ["mara.md"] });
  const d = { op: "delete", file: "mara.md", reason: "this is obsolete now" };
  assert.deepEqual(acts(planOps({ ops: [w, d] }, ctx([a]))), ["merge:mara.md"]);
  assert.deepEqual(acts(planOps({ ops: [d, w] }, ctx([a]))), []); // the refused write takes its source's delete with it
});

test("dream: the hard-names page is never auto-deleted and is built from pages like any other write", () => {
  const a = note("mara.md", "Mara Quispe-Valdivia is Alex's sister.");
  const h = note("hard-names.md", "Okafor-Lindqvist, Szczecin");
  seed([a, h]);
  const ok = planOps({ ops: [write({ file: "hard-names.md", text: "Quispe-Valdivia", consolidates: ["mara.md"] })] }, ctx([a, h]));
  assert.deepEqual(acts(ok), ["merge:hard-names.md"], "its sources stay");
  const away = planOps({ ops: [write({ file: "trips.md", text: "Okafor-Lindqvist, Szczecin", consolidates: ["hard-names.md"] })] }, ctx([a, h]));
  assert.deepEqual(acts(away), ["merge:trips.md"]);
});

test("dream: deleting needs an expired date (checked in code), the person's own words or a reason", () => {
  const old = note("trip.md", "Trip to Geneva", "2026-10-01");
  const live = note("move.md", "Moving flats in November", "2026-12-01");
  seed([old, live]);
  assert.equal(planOps({ ops: [{ op: "delete", file: "trip.md" }] }, ctx([old, live])).actions.length, 1);
  assert.equal(planOps({ ops: [{ op: "delete", file: "move.md", reason: "expired" }] }, ctx([old, live])).actions.length, 0); // claimed expired, is not, and no real reason
  assert.equal(planOps({ ops: [{ op: "delete", file: "move.md" }] }, ctx([old, live])).actions.length, 0);
  assert.equal(planOps({ ops: [{ op: "delete", file: "move.md", evidence: "I prefer meetings in the afternoon" }] }, ctx([old, live])).actions.length, 1);
  const r = planOps({ ops: [{ op: "delete", file: "move.md", reason: "the move is long over" }] }, ctx([old, live]));
  assert.equal(r.actions.length, 1);
});

test("dream: capped changes per run, and memory has a size limit", () => {
  seed([]);
  const many = Array.from({ length: 26 }, (_, i) => write({ file: `p${i}.md`, evidence: "Mara is my sister and her birthday" }));
  assert.equal(planOps({ ops: many }, ctx()).actions.length, 20);
  const full = planOps({ ops: [write({ evidence: "Mara is my sister and her birthday" })] }, ctx([], { maxNotes: 0 }));
  assert.equal(full.actions.length, 0);
});

test("dream: the person field is kept on a rewrite and may be set", () => {
  const a = { file: "mara-silva.md", raw: "---\nname: x\nperson: \"Mara Silva\"\n---\n\nMara Silva is Alex's sister.\n" };
  seed([a]);
  const rewrite = planOps({ ops: [write({ file: "mara-silva.md", text: "Mara Silva: Alex's sister.", consolidates: ["mara-silva.md"] })] }, ctx([a]));
  assert.equal(parseNote("mara-silva.md", (rewrite.actions[0] as { content: string }).content)?.person, "Mara Silva");
  const fresh = planOps({ ops: [write({ file: "lena.md", person: "Lena Berg" })] }, ctx());
  assert.equal(parseNote("lena.md", (fresh.actions[0] as { content: string }).content)?.person, "Lena Berg");
});

test("dream: applying snapshots first, keeps the index right, and undo puts everything back", () => {
  const a = note("mara.md", "Mara is Alex's sister and lives in Bern.");
  const gone = note("trips/trip.md", "Trip", "2026-10-01");
  seed([a, gone]);
  const plan = planOps({ ops: [write({ file: "meeting-hours.md", text: "Alex prefers meetings in the afternoon, never before 10.", description: "meeting hours", evidence: "I prefer meetings in the afternoon, never before 10" }), { op: "delete", file: "trips/trip.md" }] }, ctx([a, gone]));
  assert.equal(plan.actions.length, 2);
  assert.ok(applyPlan(plan, now, scope));
  assert.ok(existsSync(`${NOTES_DIR}/meeting-hours.md`));
  assert.ok(!existsSync(`${NOTES_DIR}/trips/trip.md`));
  const written = parseNote("meeting-hours.md", readFileSync(`${NOTES_DIR}/meeting-hours.md`, "utf8"))!;
  assert.match(written.text, /afternoon/);
  const index = readFileSync(`${NOTES_DIR}/MEMORY.md`, "utf8");
  assert.match(index, /\[meeting-hours\]\(meeting-hours\.md\) - meeting hours/);
  assert.doesNotMatch(index, /trips\/trip/);
  assert.deepEqual(describePlan(plan), ["➕ saved meeting-hours.md: meeting hours (from: \"I prefer meetings in the afternoon, never before 10\")", "➖ forgot trips/trip.md (expired)"]);
  const undone = undoLatest(scope);
  assert.equal(undone.ok && undone.restored, 2);
  assert.deepEqual(walkNotes(NOTES_DIR), ["mara.md", "trips/trip.md"]);
  assert.equal(undoLatest(scope).ok, false); // the snapshot was used up
});

test("dream: the page it writes reads back as a normal page, with its expiry", () => {
  const n = parseNote("trip.md", noteContent("trip.md", "trip", "Alex travels to Geneva 20-22 Oct.", "2026-10-22", now))!;
  assert.equal(n.expires, "2026-10-22");
  assert.equal(n.class, "page");
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
  assert.ok(walkNotes(NOTES_DIR).includes("mara.md")); // applied silently
  await dreamer.run(now); // the same day: no second run
  assert.equal(calls, 1);
});
