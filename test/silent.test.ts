import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSilent, isSilent } from "../src/core/silent.ts";

// A model that means "say nothing" sometimes drops the brackets; the bare word must not reach a person.
test("slipped forms of the silent marker are silent", () => {
  for (const t of ["[[silent]]", "[silent]", "(silent)", "silent", "SILENT", "*silent*", "**[[SILENT]]**", ' "Silent." ', "`silent`"]) assert.equal(isSilent(t), true, t);
});

test("real sentences that contain the word are not silent", () => {
  for (const t of ["I'll stay silent on that", "Silent night tickets are booked", "silent mode is on", "", "hello"]) assert.equal(isSilent(t), false, t);
  assert.equal(hasSilent("[[silent]] nothing to say"), true);
  assert.equal(hasSilent("I'll stay silent on that"), false);
});
