import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTerms, mainCheckout, promptDates, termRegex } from "../scripts/private-terms.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "terms-"));
}

test("terms: slug words of 4+ letters from people-note file names, plus deny and allow lines; allow wins", () => {
  const r = root();
  try {
    mkdirSync(join(r, "conversations", "owner", "notes"), { recursive: true });
    mkdirSync(join(r, "plans"));
    for (const f of ["people-zorbel-quint.md", "people-bo.md", "context-trip.md"]) writeFileSync(join(r, "conversations", "owner", "notes", f), "x");
    writeFileSync(join(r, "plans", "private-terms.txt"), "deny: Vlorp Street\nallow: Quint\nallow-file: ^docs/fiction\\.md$\n# a comment\n");
    const t = loadTerms(r)!;
    assert.deepEqual([...t.deny].sort(), ["Vlorp Street", "Zorbel"]);
    assert.equal(t.allowFiles[0]!.test("docs/fiction.md"), true);
    const re = termRegex(t)!;
    assert.equal(re.test("hello Zorbel!"), true);
    assert.equal(re.test("Zorbels"), false, "whole words");
    assert.equal(re.test("id zorbel-1a"), true, "any case");
    assert.equal(termRegex({ deny: ["Zörbel"], allowFiles: [] })!.test("Zo\u0308rbel".normalize("NFC")), true, "decomposed text, once normalised");
    assert.equal(re.test("on Vlorp Street today"), true);
    assert.equal(re.test("Quint"), false, "allowed");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("terms: neither source there means no list (skipped)", () => {
  const r = root();
  try {
    assert.equal(loadTerms(r), undefined);
    assert.equal(loadTerms(undefined), undefined);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("mainCheckout: the parent of git's common dir, the same from a worktree", () => {
  assert.match(mainCheckout()!, /^\//);
  assert.equal(mainCheckout(tmpdir()), undefined, "not a repository");
});

test("prompt dates: only May passes", () => {
  const bad = ["on 12 Nov", "12-26 Nov", "Nov 12", "2026-10-21", "Sat 25 Oct", "Birthday 14 March", "on 1 Sept"];
  const ok = ["on 3 May", "May 3", "2026-05-03T10:00", "last wrote in March", "in November", "3 more messages", "Oct 2026", "model 12 Nova"];
  for (const l of bad) assert.equal(promptDates.re.test(l), true, l);
  for (const l of ok) assert.equal(promptDates.re.test(l), false, l);
});
