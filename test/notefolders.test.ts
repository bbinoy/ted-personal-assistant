import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layout } from "../src/core/convpaths.ts";
import { applyPlan, undoLatest } from "../src/memory/dreamapply.ts";
import { planOps } from "../src/memory/dreamplan.ts";
import { forgetNote, NOTE_PATH, NOTES_DIR, readNotes, walkNotes, withinCaps } from "../src/memory/notes.ts";
import { searchConversation, type Scope } from "../src/memory/search.ts";
import { expiredNotesRule } from "../src/heartbeat/retentionrules.ts";
import { classify } from "../src/policy/policy.ts";
import { readNoteFiles } from "../src/conversation/dream.ts";
import { kindOf } from "./runkinds.ts";
import { scratchLog } from "./scratch.ts";

// The notes layer reads one folder level of subfolders everywhere it reads notes: listing, caps, forget, snapshot and undo, search, retention. Temporary folders only.

const tmp = () => mkdtempSync(join(tmpdir(), "folders-"));
const put = (dir: string, file: string, text = "a fact", front = "") => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), `---\n${front}---\n${text}\n`);
};

test("walkNotes: relative paths, sorted; only .md, no index, no dot files, no deeper folders, symlinks not followed", () => {
  const d = tmp();
  put(d, "b.md");
  put(d, "a/x.md");
  put(d, "a/deep/y.md");
  put(d, ".hidden.md");
  put(d, ".git/z.md");
  writeFileSync(join(d, "MEMORY.md"), "- index\n");
  writeFileSync(join(d, "a", "readme.txt"), "x");
  const outside = tmp();
  put(outside, "o.md");
  symlinkSync(outside, join(d, "link"));
  symlinkSync(join(outside, "o.md"), join(d, "l.md"));
  assert.deepEqual(walkNotes(d), ["a/x.md", "b.md"]);
  assert.deepEqual(walkNotes(join(d, "missing")), []);
  assert.deepEqual(readNotes(new Date(), d).map((n) => n.file), []); // (no category in these names: invisible, as an unknown prefix always was)
});

test("note paths: one folder level, no dot, no traversal", () => {
  for (const ok of ["a.md", "people/mara.md", "Style-x.md"]) assert.ok(NOTE_PATH.test(ok), ok);
  for (const bad of ["../a.md", "a/../b.md", ".a.md", "a/b/c.md", "/a.md", "a/.md", "a\\b.md", "a.txt", "..md"]) assert.ok(!NOTE_PATH.test(bad), bad);
});

test("forgetNote: removes a page in a folder and the folder with its last page; refuses a path out of the folder", () => {
  const d = tmp();
  put(d, "people/a.md");
  put(d, "people/b.md");
  assert.equal(forgetNote("people/a.md", d).ok, true);
  assert.ok(existsSync(join(d, "people")));
  assert.equal(forgetNote("people/b.md", d).ok, true);
  assert.ok(!existsSync(join(d, "people")), "an empty folder goes");
  assert.equal(forgetNote("../x.md", d).ok, false);
  assert.equal(forgetNote("people/missing.md", d).ok, false);
});

test("caps: a new page in a folder counts toward the note cap", () => {
  const d = tmp();
  put(d, "a/x.md");
  assert.equal(withinCaps("Write", { file_path: join(d, "a", "new.md"), content: "x" }, d), true);
  assert.equal(withinCaps("Write", { file_path: join(d, "a", "new.md"), content: "x".repeat(20_001) }, d), false);
});

test("dream: the notes it reads include folders, the plan may name one, the snapshot and undo bring folders back", () => {
  const d = tmp();
  const scope = { notesDir: join(d, "notes"), backupsDir: join(d, "backups"), categories: ["people"], maxNotes: 100 };
  put(scope.notesDir, "people-a.md", "old");
  put(scope.notesDir, "trips/lisbon.md", "kept");
  put(scope.notesDir, "status-brief.md", "mine");
  assert.deepEqual(readNoteFiles(scope.notesDir).map((n) => n.file), ["people-a.md", "trips/lisbon.md"], "status is not the dream's");
  const plan = planOps({ ops: [{ op: "write", file: "people-a.md", description: "d", text: "new" }, { op: "write", file: "trips/x.md", description: "d", text: "z" }, { op: "write", file: "a/b/c.md", description: "d", text: "z" }] }, { ownerText: "", notes: readNoteFiles(scope.notesDir), today: "2026-05-03", now: new Date("2026-05-03T10:00:00Z"), scope });
  assert.deepEqual(plan.actions.map((a) => a.file), ["people-a.md"], "(a folder page is writable once classes land; a second folder level never)");
  applyPlan(plan, new Date("2026-05-03T10:00:00Z"), scope);
  put(scope.notesDir, "trips/new.md", "made after");
  const r = undoLatest(scope);
  assert.equal(r.ok, true);
  assert.deepEqual(walkNotes(scope.notesDir), ["people-a.md", "status-brief.md", "trips/lisbon.md"]);
  assert.match(readFileSync(join(scope.notesDir, "people-a.md"), "utf8"), /old/);
  assert.ok(!existsSync(join(scope.notesDir, "trips", "new.md")));
});

test("search: a page in a folder is found by its path words, its text and the targets of its [[links]]", async () => {
  const d = tmp();
  const notesDir = join(d, "notes");
  put(notesDir, "people/mara-silva.md", "Lives by the river. See [[lisbon-trip]].");
  put(notesDir, "trips/lisbon-trip.md", "Flights booked.");
  const scope: Scope = { logFile: scratchLog("folders-search.jsonl"), notesDir, indexPath: join(d, "search.sqlite") };
  const find = (query: string) => searchConversation(scope, { query }, { now: Date.parse("2026-05-03T12:00:00Z"), zone: "UTC" });
  assert.match(await find("river"), /note:people\/mara-silva\.md/);
  assert.match(await find("mara"), /note:people\/mara-silva\.md/);
  assert.match(await find("lisbon trip"), /note:people\/mara-silva\.md/, "the page that links to it is found too");
});

test("retention: an expired page in a folder is set aside under a flat name and its folder goes", () => {
  const d = tmp();
  const L = layout(d);
  const n = L.conv("owner").notes;
  put(n, "trips/old.md", "gone", "expires: 2026-05-01\n");
  put(n, "trips/live.md", "stays", "expires: 2026-12-01\n");
  expiredNotesRule(() => L, () => 30).run(new Date("2026-05-03T03:30:00"), { dryRun: false });
  assert.deepEqual(walkNotes(n), ["trips/live.md"]);
  assert.deepEqual(readdirSync(join(L.conv("owner").notesBackup, "expired")), ["2026-05-01-trips__old.md"]);
});

test("policy: the file tools may create a page in a new folder of the notes folder, never beside or above it", () => {
  for (const tool of ["Write", "Edit"]) {
    assert.equal(classify(tool, { file_path: `${NOTES_DIR}/trips/new.md`, content: "x" }, kindOf("handler")), "allow", `${tool} in a new folder`);
    assert.equal(classify(tool, { file_path: `${NOTES_DIR}/Setup/x.md`, content: "x" }, kindOf("handler")), "allow", `${tool}: a differently written folder is just a folder`);
    assert.equal(classify(tool, { file_path: `${NOTES_DIR}/trips/../../state/x.md`, content: "x" }, kindOf("handler")), "deny", `${tool} ..`);
    assert.equal(classify(tool, { file_path: `${NOTES_DIR}-backup/x.md`, content: "x" }, kindOf("handler")), "deny", `${tool} a sibling`);
  }
});
