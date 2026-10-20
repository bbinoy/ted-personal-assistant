import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, undoLatest } from "../src/memory/dreamapply.ts";
import { dreamTrigger, readNoteFiles } from "../src/conversation/dream.ts";
import { loadSettings } from "../src/settings.ts";
import { presetFor } from "../src/preset.ts";

// The dream has its own daily trigger (a tick job at DREAM_HOUR); nothing else starts it. It stays plain code, never sees a status note, and never undoes one.

const at = (h: number, m = 0, d = 14) => new Date(2026, 9, d, h, m);

test("DREAM_HOUR: the preset's default (4), overridable, validated", () => {
  assert.equal(presetFor().rhythm.dream.hour, 4);
  assert.equal(loadSettings({}).dreamHour, 4);
  assert.equal(loadSettings({ DREAM_HOUR: "5" }).dreamHour, 5);
  assert.throws(() => loadSettings({ DREAM_HOUR: "24" }), /DREAM_HOUR/);
  assert.equal(loadSettings({}).model, "sonnet", "the dream's model is the harness model, Sonnet by default");
  assert.equal(loadSettings({ HARNESS_MODEL: "opus" }).model, "opus");
});

test("the trigger: nothing before the hour, the first tick at or after it runs, then at most once an hour until tomorrow", () => {
  const ran: string[] = [];
  const hit = () => void ran.push("dream");
  const tick = dreamTrigger(hit, { hour: () => 4, enabled: () => true });
  tick(at(3, 55));
  tick(at(0, 5));
  assert.deepEqual(ran, [], "before DREAM_HOUR");
  tick(at(4, 0));
  assert.deepEqual(ran, ["dream"], "the first tick at the hour");
  tick(at(4, 5));
  tick(at(4, 50));
  assert.equal(ran.length, 1, "within the hour: not again");
  tick(at(5, 1));
  assert.equal(ran.length, 2, "an hour later it looks again (a conversation may have more to dream about)");
  tick(at(5, 6));
  assert.equal(ran.length, 2);
  // a Mac that slept through the night: the first tick after waking runs it
  const late = dreamTrigger(hit, { hour: () => 4, enabled: () => true });
  late(at(9, 30));
  assert.equal(ran.length, 3);
  // the next day starts over
  const before = ran.length;
  tick(at(3, 0, 15));
  assert.equal(ran.length, before, "tomorrow before the hour");
  tick(at(4, 10, 15));
  assert.equal(ran.length, before + 1, "tomorrow's first tick after the hour");
});

test("the trigger: DREAM=off means no run", () => {
  let n = 0;
  const tick = dreamTrigger(() => void n++, { hour: () => 4, enabled: () => false });
  tick(at(6));
  assert.equal(n, 0);
});

test("the dream is not shown a status note, and its snapshot and undo leave it alone", () => {
  const notes = mkdtempSync(join(tmpdir(), "dnotes-"));
  const backups = mkdtempSync(join(tmpdir(), "dback-"));
  writeFileSync(join(notes, "people-anna.md"), "Anna is my sister\n");
  writeFileSync(join(notes, "status-brief.md"), "---\nexpires: 2026-10-15\n---\nstatus: started\n");
  assert.deepEqual(readNoteFiles(notes).map((n) => n.file), ["people-anna.md"], "not in the dream's prompt");
  const scope = { notesDir: notes, backupsDir: backups, categories: ["people"], index: false, maxNotes: 100 };
  const plan = { actions: [{ kind: "add" as const, file: "people-eve.md", content: "Eve is a friend\n", description: "eve" }], rejected: [] };
  const snap = applyPlan(plan as never, at(4), scope);
  assert.ok(snap && !existsSync(join(snap, "status-brief.md")), "not in the snapshot");
  // the brief is delivered after the dream; an undo later must not bring yesterday's note back or remove today's
  writeFileSync(join(notes, "status-brief.md"), "---\nexpires: 2026-10-16\n---\nstatus: delivered\n");
  const undone = undoLatest(scope);
  assert.ok(undone.ok);
  assert.deepEqual(readdirSync(notes).sort(), ["people-anna.md", "status-brief.md"]);
  assert.match(readFileSync(join(notes, "status-brief.md"), "utf8"), /delivered/);
});
