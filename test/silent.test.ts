import { test } from "node:test";
import assert from "node:assert/strict";
import { isSilent, withoutSilent } from "../src/core/silent.ts";

// A model that means "say nothing" sometimes drops the brackets; the bare word must not reach a person.
test("slipped forms of the silent marker are silent", () => {
  for (const t of ["[[silent]]", "[silent]", "(silent)", "silent", "SILENT", "*silent*", "**[[SILENT]]**", ' "Silent." ', "`silent`"]) assert.equal(isSilent(t), true, t);
});

test("real sentences that contain the word are not silent", () => {
  for (const t of ["I'll stay silent on that", "Silent night tickets are booked", "silent mode is on", "", "hello"]) assert.equal(isSilent(t), false, t);
});

test("the marker is removed from words that carry it, the words stay", () => {
  assert.equal(withoutSilent("Calendar is done.\n\n[[silent]]"), "Calendar is done.");
  assert.equal(withoutSilent("[[SILENT]] Done."), "Done.");
  assert.equal(withoutSilent("[[silent]]"), "");
  assert.equal(withoutSilent("I'll stay silent on that"), "I'll stay silent on that");
});

test("a text that is only JSON (an echoed structured answer) is silent; words around braces are not", () => {
  for (const t of ['{"nextCheckMinutes":30}', ' {"nextCheckMinutes": 45, "urgent": false} ', '```json\n{"nextCheckMinutes":30}\n```', "[]"]) assert.equal(isSilent(t), true, t);
  for (const t of ['Done. {"a":1}', "{not json}", "Your code is {x}", "[1] see the note"]) assert.equal(isSilent(t), false, t);
});

