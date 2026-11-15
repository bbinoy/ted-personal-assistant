import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { convDbAt } from "../src/core/convdb.ts";
import { layout } from "../src/core/convpaths.ts";
import { readAudit } from "../src/core/audit.ts";
import { snapshotsOf, undoLatest } from "../src/memory/dreamapply.ts";
import { MARKER, migrateAll, PREMIGRATION, unmigrated } from "../src/memory/migrate.ts";
import { makeNotesDir } from "../src/core/state.ts";
import { classOf, readNotes, walkNotes } from "../src/memory/notes.ts";
import { readNoteFiles } from "../src/conversation/dream.ts";
import { fromNote } from "../src/modules/people/people.ts";
import { scheduledIn } from "../src/modules/tasks/routinelist.ts";

// The one-time move of every conversation's flat notes (category = file-name prefix) to pages, on temporary data folders seeded with invented notes. Never the real data.

const note = (body: string, front = "") => `---\nname: x\n${front}---\n\n${body}\n`;
const root = () => mkdtempSync(join(tmpdir(), "migrate-"));
const seed = (r: string, conv: string, files: Record<string, string>) => {
  const notes = layout(r).conv(conv).notes;
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(notes, f)), { recursive: true });
    writeFileSync(join(notes, f), t);
  }
  return notes;
};
const OLD: Record<string, string> = {
  "people-mara-silva.md": note("Mara Silva. Lives in: Lisbon. mara@silva.example", 'description: "Mara Silva, sister"\n'),
  "people-rui.md": note("Lives in Porto, close friend.", ""),
  "context-whereabouts.md": note("At home.", 'description: "Whereabouts: home"\n'),
  "context-hard-names.md": note("Okafor, Szczecin"),
  "scheduling-gym.md": note("Gym on Tuesdays."),
  "triage-newsletters.md": note("Archive newsletters."),
  "brief-radar-topics.md": note("Surf reports."),
  "style-short.md": note("Keep replies short."),
  "style-warm.md": note("Warm and informal,\nfirst names."),
  "setup-calendars.md": note("primary only"),
  "voice-writing.md": note("Sign off with the first name."),
  "status-brief.md": note("headlines", "expires: 2026-05-04\n"),
  "routine-pep-talk.md": note("Send a pep talk.", "when: every day at 08:00\n"),
  "random-thing.md": note("A page with a name the old layout did not know."),
  "Style-loud.md": note("No exclamation marks."),
};

test("migration: every old prefix moves to its folder or name, style notes become one page, people get person:, nothing is lost", () => {
  const r = root();
  const notes = seed(r, "owner", OLD);
  writeFileSync(join(notes, "MEMORY.md"), "- stale index\n");
  migrateAll(r);
  assert.deepEqual(walkNotes(notes), [
    "gym.md", "hard-names.md", "mara-silva.md", "newsletters.md", "radar-topics.md", "random-thing.md", "routines/pep-talk.md", "rui.md", "setup/calendars.md", "setup/voice-writing.md", "status/brief.md", "style.md", "whereabouts.md",
  ]);
  assert.equal(classOf("setup/voice-writing.md"), "setup");
  const style = readFileSync(join(notes, "style.md"), "utf8");
  assert.match(style, /- Keep replies short\./);
  assert.match(style, /- Warm and informal, first names\./, "a body on one line, nothing reworded");
  assert.match(style, /- No exclamation marks\./, "a prefix in capitals counts too");
  const people = readNotes(new Date(), notes).filter((n) => n.person);
  assert.deepEqual(people.map((n) => n.person).sort(), ["Mara Silva", "Rui"], "the name as the people module read it: the opening words when they carry the file's name, else the file's");
  assert.equal(fromNote(people.find((n) => n.person === "Mara Silva")!)?.emails[0], "mara@silva.example");
  assert.equal(readFileSync(join(notes, "routines", "pep-talk.md"), "utf8").includes("when: every day at 08:00"), true);
  assert.deepEqual(scheduledIn({ notesDir: notes, zone: "UTC", now: new Date("2026-05-03T12:00:00Z") }).routines.map((x) => x.name), ["pep-talk"]);
  assert.ok(!readNoteFiles(notes).some((n) => n.file.startsWith("status/")), "a status page is not the dream's");
  const index = readFileSync(join(notes, "MEMORY.md"), "utf8");
  assert.match(index, /## routines\n- \[routines\/pep-talk\]/);
  assert.match(index, /## setup\n- \[setup\/calendars\]/);
  assert.doesNotMatch(index, /stale index|status\/brief/);
  assert.equal(existsSync(join(notes, MARKER)), true);
  assert.equal(unmigrated(r), 0);
  assert.equal(existsSync(join(layout(r).conv("owner").dir, PREMIGRATION, "people-mara-silva.md")), true, "the copy of the old folder, status included");
  assert.equal(existsSync(join(layout(r).conv("owner").dir, PREMIGRATION, "status-brief.md")), true);
  rmSync(r, { recursive: true, force: true });
});

test("migration: names that are not page names as they stand are made safe, accented ones stay", () => {
  const r = root();
  const notes = seed(r, "owner", { "people-.md": note("Nobody. Lives in: Oslo."), "context-café-été.md": note("Accents."), "setup-.hidden.md": note("odd"), "routine-.md": note("r", "when: every day at 08:00\n") });
  migrateAll(r);
  assert.deepEqual(walkNotes(notes), ["café-été.md", "page.md", "routines/page.md", "setup/hidden.md"]);
  assert.equal(readNotes(new Date(), notes).filter((n) => n.person).length, 1);
  rmSync(r, { recursive: true, force: true });
});

test("migration: a notes folder born after the upgrade carries the marker, so a routine-foo page there keeps its name and key", () => {
  const r = root();
  const notes = layout(r).conv("group-0123456789abcdef").notes;
  makeNotesDir(notes);
  assert.equal(existsSync(join(notes, MARKER)), true);
  makeNotesDir(notes); // idempotent
  writeFileSync(join(notes, "routine-foo.md"), note("A page the model named like that."));
  migrateAll(r);
  assert.deepEqual(walkNotes(notes), ["routine-foo.md"]);
  assert.equal(existsSync(join(layout(r).conv("group-0123456789abcdef").dir, PREMIGRATION)), false);
  rmSync(r, { recursive: true, force: true });
});

test("migration: a taken name gets -2; a run twice changes nothing; a folder with no old prefix just gets its marker", () => {
  const r = root();
  const notes = seed(r, "owner", { "context-trip.md": note("Trip A."), "scheduling-trip.md": note("Trip B."), "trip.md": note("Trip C, already a page.") });
  migrateAll(r);
  assert.deepEqual(walkNotes(notes), ["trip-2.md", "trip-3.md", "trip.md"]);
  assert.match(readFileSync(join(notes, "trip.md"), "utf8"), /Trip C/, "the existing page keeps its name");
  const before = walkNotes(notes).map((f) => readFileSync(join(notes, f), "utf8"));
  migrateAll(r);
  assert.deepEqual(walkNotes(notes).map((f) => readFileSync(join(notes, f), "utf8")), before);
  const fresh = seed(r, "group-0123456789abcdef", { "lisbon-trip.md": note("A new-layout page.") });
  migrateAll(r);
  assert.equal(existsSync(join(fresh, MARKER)), true);
  assert.equal(existsSync(join(layout(r).conv("group-0123456789abcdef").dir, PREMIGRATION)), false, "nothing moved, no copy");
  assert.deepEqual(walkNotes(fresh), ["lisbon-trip.md"]);
  rmSync(r, { recursive: true, force: true });
});

test("migration: an interrupted run resumes without losing or doubling a file, and keeps the first copy", () => {
  const r = root();
  const notes = seed(r, "owner", { "people-mara.md": note("Mara Quist. Lives in: Bern."), "style-a.md": note("A rule."), "style-b.md": note("Another rule."), "setup-calendars.md": note("primary"), "routine-x.md": note("do x", "when: every day at 08:00\n") });
  // the state a crash leaves: one file written to its new place and not yet removed, style.md written, one style note still there
  mkdirSync(join(notes, "setup"));
  writeFileSync(join(notes, "setup", "calendars.md"), readFileSync(join(notes, "setup-calendars.md"), "utf8"));
  writeFileSync(join(notes, "style.md"), "---\nname: style\n---\n\n- A rule.\n- Another rule.\n");
  rmSync(join(notes, "style-a.md"));
  const keep = join(layout(r).conv("owner").dir, PREMIGRATION);
  mkdirSync(keep);
  writeFileSync(join(keep, "marker.md"), "the first copy");
  migrateAll(r);
  assert.deepEqual(walkNotes(notes), ["mara.md", "routines/x.md", "setup/calendars.md", "style.md"]);
  assert.equal(readFileSync(join(notes, "style.md"), "utf8").match(/- A rule\./g)?.length, 1, "no rule twice");
  assert.equal(readFileSync(join(notes, "style.md"), "utf8").match(/- Another rule\./g)?.length, 1);
  assert.equal(readFileSync(join(keep, "marker.md"), "utf8"), "the first copy", "the copy of the first attempt is not replaced");
  assert.equal(existsSync(join(notes, MARKER)), true);
  rmSync(r, { recursive: true, force: true });
});

test("migration: the routines' run records get the new key, other records are left", () => {
  const r = root();
  seed(r, "owner", { "routine-pep-talk.md": note("x", "when: every day at 08:00\n"), "routine-gone.md": note("y", "when: every day at 09:00\n") });
  const db = convDbAt(r, "owner");
  for (const name of ["routine-pep-talk", "pep-talk", "routine-orphan", "other"]) db.run("INSERT INTO routine_runs (name, since) VALUES (?, ?)", name, 1);
  migrateAll(r);
  assert.deepEqual(db.all<{ name: string }>("SELECT name FROM routine_runs ORDER BY name").map((x) => x.name), ["other", "pep-talk", "routine-orphan"], "the record of the new name wins over the renamed old one; a record of no routine is left to the retention rule");
  rmSync(r, { recursive: true, force: true });
});

const quiet = (fn: () => void): string => {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return lines.join("\n") + JSON.stringify(readAudit((e) => e.tool === "memory_migrated"));
};

test("migration: a failing friend does not stop the start, keeps its old files, is counted by the doctor, and no file is named in the log or the audit", () => {
  const r = root();
  const owner = seed(r, "owner", { "people-zorbel-quint.md": note("Zorbel Quint. Lives in: Oslo."), "context-ok.md": note("fine") });
  const friend = seed(r, "friend-ab12cd34", { "people-vanka-roth.md": note("Vanka Roth. Lives in: Riga."), "context-trip.md": note("trip") });
  writeFileSync(join(layout(r).conv("friend-ab12cd34").dir, `${PREMIGRATION}.tmp`), "in the way"); // the copy cannot be made
  const text = quiet(() => migrateAll(r)); // (does not throw)
  assert.equal(existsSync(join(owner, MARKER)), true, "the owner was done first");
  assert.ok(existsSync(join(friend, "people-vanka-roth.md")), "the friend's old files stay");
  assert.equal(existsSync(join(friend, MARKER)), false, "no marker: tried again at the next start");
  assert.equal(unmigrated(r), 1, "the doctor counts conversations, not files");
  assert.match(text, /memory migrated: owner moved 2, merged-style 0, collided 0/);
  assert.match(text, /friend-ab12cd34: failed at step 1/);
  assert.doesNotMatch(text, /zorbel|quint|vanka|roth|people-|context-|trip|\.md/i, "ids and counts only");
  rmSync(join(layout(r).conv("friend-ab12cd34").dir, `${PREMIGRATION}.tmp`));
  migrateAll(r);
  assert.ok(existsSync(join(friend, "vanka-roth.md")), "the next start moves it");
  assert.equal(unmigrated(r), 0);
  rmSync(r, { recursive: true, force: true });
});

test("migration: a failing OWNER conversation refuses the start and names nothing", () => {
  const r = root();
  const owner = seed(r, "owner", { "people-zorbel-quint.md": note("Zorbel Quint. Lives in: Oslo.") });
  const friend = seed(r, "friend-ab12cd34", { "context-trip.md": note("trip") });
  writeFileSync(join(layout(r).conv("owner").dir, `${PREMIGRATION}.tmp`), "in the way");
  const text = quiet(() => assert.throws(() => migrateAll(r), /owner's conversation/));
  assert.ok(existsSync(join(owner, "people-zorbel-quint.md")));
  assert.equal(existsSync(join(friend, MARKER)), false);
  assert.match(text, /owner: failed at step 1/);
  assert.doesNotMatch(text, /zorbel|quint|people-|\.md/i);
  rmSync(r, { recursive: true, force: true });
});

test("migration: the dream's old snapshots go into the copy, so an undo never restores a flat file over pages", () => {
  const r = root();
  const notes = seed(r, "owner", { "people-mara.md": note("Mara. Lives in: Bern."), "routine-x.md": note("x", "when: every day at 08:00\n") });
  const backups = layout(r).conv("owner").notesBackup;
  mkdirSync(join(backups, "2026-05-02T04-00-00-000Z"), { recursive: true });
  writeFileSync(join(backups, "2026-05-02T04-00-00-000Z", "people-mara.md"), note("the old snapshot"));
  migrateAll(r);
  assert.deepEqual(snapshotsOf(backups), [], "no snapshot of the old layout is left to undo");
  const scope = { notesDir: notes, backupsDir: backups, maxNotes: 100 };
  assert.equal(undoLatest(scope).ok, false);
  assert.deepEqual(walkNotes(notes), ["mara.md", "routines/x.md"], "the pages are as the migration left them");
  assert.equal(existsSync(join(layout(r).conv("owner").dir, PREMIGRATION, "dream-snapshots", "2026-05-02T04-00-00-000Z", "people-mara.md")), true);
  rmSync(r, { recursive: true, force: true });
});

test("restore: the script puts the copy and the old snapshots back, removes the marker, replays the routine keys (collisions included) and sets the copy aside", () => {
  const r = root();
  const notes = seed(r, "owner", { "people-mara.md": note("Mara. Lives in: Bern."), "routine-x.md": note("x", "when: every day at 08:00\n"), "x.md": note("a page that takes the name x"), "style-a.md": note("A rule.") });
  const backups = layout(r).conv("owner").notesBackup;
  mkdirSync(join(backups, "2026-05-02T04-00-00-000Z"), { recursive: true });
  writeFileSync(join(backups, "2026-05-02T04-00-00-000Z", "people-mara.md"), note("old snapshot"));
  convDbAt(r, "owner").run("INSERT INTO routine_runs (name, since) VALUES ('routine-x', 1)");
  migrateAll(r);
  assert.deepEqual(walkNotes(notes), ["mara.md", "routines/x.md", "style.md", "x.md"], "the routine's stem x is free inside routines/, the page x.md is another folder");
  assert.deepEqual(convDbAt(r, "owner").all<{ name: string }>("SELECT name FROM routine_runs").map((x) => x.name), ["x"]);
  convDbAt(r, "owner").close();
  const run = () => execFileSync(process.execPath, ["--conditions=workspace-source", "scripts/restore-premigration.ts", "owner"], { env: { ...process.env, HARNESS_DATA_DIR: r }, encoding: "utf8" });
  const out = run();
  assert.match(out, /^owner: notes restored/);
  assert.deepEqual(walkNotes(notes).sort(), ["people-mara.md", "routine-x.md", "style-a.md", "x.md"]);
  assert.equal(existsSync(join(notes, MARKER)), false);
  assert.equal(existsSync(join(notes, "dream-snapshots")), false, "the snapshots are not notes");
  assert.deepEqual(snapshotsOf(backups), ["2026-05-02T04-00-00-000Z"]);
  assert.deepEqual(convDbAt(r, "owner").all<{ name: string }>("SELECT name FROM routine_runs").map((x) => x.name), ["routine-x"]);
  assert.equal(existsSync(join(layout(r).conv("owner").dir, PREMIGRATION)), false);
  assert.equal(readdirSync(layout(r).conv("owner").dir).filter((f) => f.startsWith(`${PREMIGRATION}.restored-`)).length, 1, "set aside, so a later migration takes a fresh copy");
  assert.throws(() => execFileSync(process.execPath, ["--conditions=workspace-source", "scripts/restore-premigration.ts", "owner"], { env: { ...process.env, HARNESS_DATA_DIR: r }, stdio: "pipe" }), /status 1|Command failed/);
  migrateAll(r); // the restored folder is migrated again, from a fresh copy
  assert.equal(existsSync(join(layout(r).conv("owner").dir, PREMIGRATION)), true);
  rmSync(r, { recursive: true, force: true });
});
