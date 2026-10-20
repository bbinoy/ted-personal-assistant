import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { announceMemoryChanges, noteWritten, recordMemoryChange } from "../src/memory/memorynotice.ts";
import { NOTES_DIR } from "../src/memory/notes.ts";

const sent: string[] = [];
const notify = async (t: string) => void sent.push(t);

test("memory notice: a note written in the notes folder is announced once, with its own description", () => {
  sent.length = 0;
  const file = join(NOTES_DIR, "people-sam.md");
  noteWritten("Write", { file_path: file, content: '---\nname: people-sam\ndescription: "Sam is my brother"\n---\n\nSam lives in Leeds.\n' });
  noteWritten("Edit", { file_path: file, new_string: "Sam moved to York." });
  noteWritten("Write", { file_path: join(NOTES_DIR, "MEMORY.md"), content: "- index" }); // the index is not a note
  noteWritten("Write", { file_path: "/tmp/elsewhere.md", content: "x" }); // outside the notes folder
  noteWritten("Read", { file_path: file }); // only writes count
  announceMemoryChanges(notify, "");
  assert.deepEqual(sent, ["🧠 Memory\n➕ saved people-sam.md: Sam is my brother\n✏️ updated people-sam.md: Sam moved to York.\nWrong? Tell me to undo it."]);
});

test("memory notice: no notice when the reply says it, and the list starts over each turn", () => {
  sent.length = 0;
  recordMemoryChange("➖ forgot context-x.md");
  announceMemoryChanges(notify, "Done, forgot that.");
  announceMemoryChanges(notify, "");
  assert.deepEqual(sent, []);
  recordMemoryChange("➖ forgot context-y.md");
  announceMemoryChanges(notify, "[[react: 👍]]");
  assert.deepEqual(sent, ["🧠 Memory\n➖ forgot context-y.md\nWrong? Tell me to undo it."]);
});
