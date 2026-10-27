import { test } from "node:test";
import assert from "node:assert/strict";
import { splitReaction } from "../src/core/reaction.ts";
import { NOTES_DIR } from "../src/memory/notes.ts";

test("reaction: one emoji at the very start is a reaction; the rest is still said", () => {
  assert.deepEqual(splitReaction("[[react: 👍]]"), { reaction: "👍", text: "" });
  assert.deepEqual(splitReaction("[[react:😂]] Good one, Captain."), { reaction: "😂", text: "Good one, Captain." });
  assert.deepEqual(splitReaction("  [[react: ❤️]]\n\nThanks!"), { reaction: "❤️", text: "Thanks!" });
  assert.deepEqual(splitReaction("[[react: 👍🏽]] ok"), { reaction: "👍🏽", text: "ok" }); // skin tone is one emoji
});

test("reaction: anything else is plain text, never a reaction", () => {
  for (const s of ["Sure thing [[react: 👍]]", "[[react: ok]]", "[[react: 👍👍]]", "[[react: ]]", "[[react: 1]]", "react: 👍", "Hello"]) assert.deepEqual(splitReaction(s), { text: s }, s);
});

test("memory: a note write tells the model to mention it, so a reply that is only a reaction still comes with words", async () => {
  const { noteSavedHint } = await import("../src/memory/notes.ts");
  const dir = NOTES_DIR;
  assert.match(noteSavedHint("Write", { file_path: `${dir}/people-sam.md`, content: "x" }, dir) ?? "", /Mention what you saved.*even if you only react/);
  assert.match(noteSavedHint("Edit", { file_path: `${dir}/people-sam.md` }, dir) ?? "", /Mention/);
  for (const [tool, file] of [["Write", "MEMORY.md"], ["Write", "status-brief.md"], ["Write", "routine-x.md"], ["Read", "people-sam.md"]] as const) assert.equal(noteSavedHint(tool, { file_path: `${dir}/${file}` }, dir), undefined, file);
  assert.equal(noteSavedHint("Write", { file_path: "/tmp/elsewhere.md" }, dir), undefined);
  assert.equal(noteSavedHint("Write", { file_path: `${dir}/a.md` }, undefined), undefined);
});
