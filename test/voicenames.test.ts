import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namesPrompt } from "../src/memory/notes.ts";

const folder = () => mkdtempSync(join(tmpdir(), "voicenames-"));
const person = (dir: string, file: string, name: string, age = 0) => {
  writeFileSync(join(dir, file), `---\nname: ${name}\ndescription: someone\n---\n\nLives far away.\n`);
  const t = new Date(Date.now() - age * 1000);
  utimesSync(join(dir, file), t, t);
};

test("voice names: only this conversation's people notes make the prompt", () => {
  const mine = folder();
  const other = folder();
  person(mine, "people-sam.md", "Sam Ortiz");
  person(mine, "triage-bills.md", "Bills Sorting");
  person(other, "people-mia.md", "Mia Okoye");
  assert.equal(namesPrompt(mine), "Names: Sam Ortiz.");
  assert.equal(namesPrompt(other), "Names: Mia Okoye.");
  rmSync(mine, { recursive: true });
  rmSync(other, { recursive: true });
});

test("voice names: the newest notes come first and the size is capped", () => {
  const dir = folder();
  person(dir, "people-a.md", "Old Person", 1000);
  person(dir, "people-b.md", "Middle Person", 500);
  person(dir, "people-c.md", "New Person", 1);
  assert.equal(namesPrompt(dir), "Names: New Person, Middle Person, Old Person.");
  const capped = namesPrompt(dir, 40);
  assert.equal(capped, "Names: New Person, Middle Person.");
  assert.ok(capped!.length <= 40);
  rmSync(dir, { recursive: true });
});

test("voice names: a slug name reads as words, a note with no name adds nothing", () => {
  const dir = folder();
  person(dir, "people-x.md", "people-nora-lindqvist");
  writeFileSync(join(dir, "people-y.md"), "Just text.\n");
  assert.equal(namesPrompt(dir), "Names: nora lindqvist.");
  rmSync(dir, { recursive: true });
});

test("voice names: no notes or an unreadable folder means no prompt", () => {
  const dir = folder();
  assert.equal(namesPrompt(dir), undefined);
  assert.equal(namesPrompt(join(dir, "missing")), undefined);
  rmSync(dir, { recursive: true });
});
