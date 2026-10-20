import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCommitMessage, SUBJECT_MAX } from "../scripts/check-commit-msg.ts";

test("commit messages: a typed, short, lower-case subject is accepted", () => {
  for (const m of ["feat: add the drawing tool", "fix(policy): deny spam by one rule", "refactor!: one payer for every loop", "docs: update the architecture diagram"]) {
    assert.deepEqual(checkCommitMessage(m), [], m);
  }
});

test("commit messages: a missing type, a long or capitalised subject and a full stop are refused", () => {
  assert.equal(checkCommitMessage("Add the drawing tool").length, 1);
  assert.equal(checkCommitMessage("update: add the drawing tool").length, 1);
  assert.match(checkCommitMessage(`feat: ${"x".repeat(SUBJECT_MAX)}`).join(" "), /characters/);
  assert.match(checkCommitMessage("fix: Deny spam").join(" "), /lower case/);
  assert.match(checkCommitMessage("fix: deny spam.").join(" "), /full stop/);
  assert.deepEqual(checkCommitMessage(""), ["the message is empty"]);
});

test("commit messages: body needs a blank line first, long prose lines are refused, trailers and web addresses may be long", () => {
  assert.match(checkCommitMessage("fix: deny spam\nbody right away").join(" "), /blank line/);
  assert.match(checkCommitMessage(`fix: deny spam\n\n${"word ".repeat(30)}`).join(" "), /wrap/);
  const long = "Claude-Session: https://claude.ai/code/session_01HXaTHLZ2VrER5HW64dRp2h-and-a-very-long-identifier-that-goes-on-and-on";
  assert.deepEqual(checkCommitMessage(`fix: deny spam\n\nWhy: the old rule missed the name.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${long}\n`), []);
});

test("commit messages: merge, revert, fixup and squash commits and comment lines are not checked", () => {
  for (const m of ["Merge: one dreamer for everyone", "Merge branch 'x' into main", 'Revert "feat: add x"', "fixup! feat: add x", "squash! fix: y"]) assert.deepEqual(checkCommitMessage(m), [], m);
  assert.deepEqual(checkCommitMessage("fix: deny spam\n# Please enter the commit message\n# lines starting with # are ignored"), []);
});
