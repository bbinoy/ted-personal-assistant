import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namesPrompt } from "../src/memory/notes.ts";

const folder = () => mkdtempSync(join(tmpdir(), "voicenames-"));
const note = (dir: string, body: string, file = "context-hard-names.md") => writeFileSync(join(dir, file), `---\nname: hard names\ndescription: spellings\n---\n\n${body}\n`);

test("voice names: the prompt is the conversation's own hard-names note, without front matter", () => {
  const mine = folder();
  const other = folder();
  note(mine, "Sam Ortiz,\nQuillfeather Logistics");
  note(other, "Mia Okoye");
  note(mine, "Not Me", "people-nora.md");
  assert.equal(namesPrompt(mine), "Sam Ortiz, Quillfeather Logistics");
  assert.equal(namesPrompt(other), "Mia Okoye");
  rmSync(mine, { recursive: true });
  rmSync(other, { recursive: true });
});

test("voice names: the size is capped", () => {
  const dir = folder();
  note(dir, "Aaa Bbb, ".repeat(100));
  assert.ok(namesPrompt(dir)!.length <= 360);
  assert.equal(namesPrompt(dir, 12), "Aaa Bbb, Aaa");
  rmSync(dir, { recursive: true });
});

test("voice names: no note, an empty one, other notes only or an unreadable folder mean no prompt", () => {
  const dir = folder();
  assert.equal(namesPrompt(dir), undefined);
  note(dir, "Not Me", "people-nora.md");
  assert.equal(namesPrompt(dir), undefined);
  writeFileSync(join(dir, "context-hard-names.md"), "---\nname: x\n---\n\n   \n");
  assert.equal(namesPrompt(dir), undefined);
  assert.equal(namesPrompt(join(dir, "missing")), undefined);
  rmSync(dir, { recursive: true });
});
