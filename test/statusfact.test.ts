import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failStartedNote, readStatusNote, statusFact, STALE_STARTED_MINUTES, writeStatusNote } from "../src/modules/status/statusnote.ts";
import { lookInstruction } from "../src/heartbeat/look.ts";
import { parseNote } from "../src/memory/notes.ts";

// The status-brief note is the brief's state, and code is the authority on it: the tool stamps the write time and counts the attempts, a fact line computed from the stamp goes into
// every look's instruction (so the model does no date arithmetic and the zone of the times it wrote does not matter), and a look that was stopped marks a 'started' note failed.

const dir = () => mkdtempSync(join(tmpdir(), "status-fact-"));
const at = (iso: string) => new Date(iso);
const BERLIN = "Europe/Berlin"; // UTC+2 on 21 Oct 2026

test("the tool stamps the note: when it was written (an instant) and how many runs started today; the stamp is front matter, not the model's text", () => {
  const d = dir();
  writeStatusNote("brief", "2026-10-21\nstatus: started", at("2026-10-21T04:35:00Z"), d);
  assert.match(readFileSync(join(d, "status-brief.md"), "utf8"), /^---\nexpires: [\d-]+\nwritten: 2026-10-21T04:35:00\.000Z\nattempts: 1\n---\n2026-10-21\nstatus: started\n$/);
  assert.deepEqual(parseNote("status-brief.md", readFileSync(join(d, "status-brief.md"), "utf8"))?.text, "2026-10-21\nstatus: started", "readers of notes see the text only");
  writeStatusNote("brief", "2026-10-21\nstatus: started", at("2026-10-21T06:00:00Z"), d);
  assert.equal(readStatusNote("brief", d)?.attempts, 2, "a second start the same day");
  writeStatusNote("brief", "2026-10-21\nstatus: delivered at 08:30", at("2026-10-21T06:30:00Z"), d);
  assert.deepEqual([readStatusNote("brief", d)?.status, readStatusNote("brief", d)?.attempts], ["delivered", 2], "delivered keeps the count");
  writeStatusNote("brief", "2026-10-22\nstatus: started", at("2026-10-22T04:35:00Z"), d);
  assert.equal(readStatusNote("brief", d)?.attempts, 1, "the next day starts again");
  assert.equal(readStatusNote("nothing", d), undefined);
});

test("the fact line: none today, started N min ago, stale, delivered at, failed; computed in the conversation's zone from the stamp, not from the times the model wrote", () => {
  const d = dir();
  const fact = (now: string) => statusFact("brief", at(now), BERLIN, d);
  assert.equal(fact("2026-10-21T10:00:00Z"), "status-brief: none today");
  // yesterday's note (in Berlin) is not today's
  writeStatusNote("brief", "status: delivered", at("2026-10-20T21:30:00Z"), d); // 23:30 on the 20th in Berlin
  assert.equal(fact("2026-10-21T04:00:00Z"), "status-brief: none today");
  // today in Berlin, though still the 20th in UTC
  writeStatusNote("brief", "status: delivered", at("2026-10-20T22:30:00Z"), d); // 00:30 on the 21st in Berlin
  assert.equal(fact("2026-10-21T04:00:00Z"), "status-brief: delivered at 00:30");
  // the incident: written at 06:36 local while its text said 07:35
  writeStatusNote("brief", "2026-10-21 07:35\nstatus: started", at("2026-10-21T04:36:00Z"), d);
  assert.equal(fact("2026-10-21T04:48:00Z"), "status-brief: started 12 min ago");
  assert.equal(fact("2026-10-21T05:20:00Z"), "status-brief: started 44 min ago");
  assert.match(fact("2026-10-21T05:40:00Z"), new RegExp(`^status-brief: started 64 min ago, stale \\(over ${STALE_STARTED_MINUTES} min: the run died, this counts as failed\\); attempts today: 1$`));
  assert.match(fact("2026-10-21T09:46:00Z"), /started 310 min ago, stale/, "the 11:46 look of the incident would have seen it");
  writeStatusNote("brief", "2026-10-21\nstatus: delivered at 8:15", at("2026-10-21T06:15:00Z"), d);
  assert.equal(fact("2026-10-21T08:00:00Z"), "status-brief: delivered at 08:15", "the stamp's time in the zone, whatever the text says");
  writeStatusNote("brief", "2026-10-21\nstatus: failed: no network", at("2026-10-21T06:20:00Z"), d);
  assert.equal(fact("2026-10-21T08:00:00Z"), "status-brief: failed at 08:20; attempts today: 1");
  writeStatusNote("brief", "something else", at("2026-10-21T06:25:00Z"), d);
  assert.equal(fact("2026-10-21T08:00:00Z"), "status-brief: written at 08:25 without a clear status; attempts today: 1");
});

test("a note without a stamp (written by hand in a chat turn) is read at the file's time", () => {
  const d = dir();
  const f = join(d, "status-brief.md");
  writeFileSync(f, "---\nexpires: 2026-10-22\n---\n2026-10-21\nstatus: started\n");
  utimesSync(f, at("2026-10-21T04:36:00Z"), at("2026-10-21T04:36:00Z"));
  assert.equal(statusFact("brief", at("2026-10-21T04:50:00Z"), BERLIN, d), "status-brief: started 14 min ago");
});

test("failStartedNote: a 'started' note of today becomes 'failed' with the time and the reason (attempts kept); anything else is left alone", () => {
  const d = dir();
  assert.equal(failStartedNote("brief", "x", at("2026-10-21T05:00:00Z"), d, BERLIN), false, "no note");
  writeStatusNote("brief", "status: started", at("2026-10-21T04:36:00Z"), d);
  writeStatusNote("brief", "status: started", at("2026-10-21T04:40:00Z"), d); // the second attempt
  assert.equal(failStartedNote("brief", "the run timed out", at("2026-10-21T05:00:00Z"), d, BERLIN), true);
  const text = readFileSync(join(d, "status-brief.md"), "utf8");
  assert.match(text, /status: failed\nattempts today: 2, failed: the run timed out \(it started at 06:40, the code stopped it at 07:00\)\./);
  assert.equal(statusFact("brief", at("2026-10-21T05:00:00Z"), BERLIN, d), "status-brief: failed at 07:00; attempts today: 2");
  assert.equal(failStartedNote("brief", "again", at("2026-10-21T05:10:00Z"), d, BERLIN), false, "already failed");
  writeStatusNote("brief", "status: started", at("2026-10-20T20:00:00Z"), d);
  assert.equal(failStartedNote("brief", "late", at("2026-10-21T05:10:00Z"), d, BERLIN), false, "yesterday's note is not today's run");
});

test("the instruction carries the fact line and the 45-minute rule, and tells the expert to write times as the clock line gives them", () => {
  const d = dir();
  const now = new Date(2026, 9, 21, 11, 46);
  writeStatusNote("brief", "2026-10-21 07:35\nstatus: started", new Date(2026, 9, 21, 6, 36), d);
  const text = lookInstruction(now, undefined, undefined, d);
  assert.match(text, /"status-brief: started 310 min ago, stale \(over 45 min: the run died, this counts as failed\); attempts today: 1"/);
  assert.match(text, /with N under 45: the expert is still working, wait/);
  assert.match(text, /if "attempts today" is 0 or 1, delegate the brief again now and say nothing about the earlier failure; if it is 2 or more, tell .+? once/);
  assert.match(text, /exactly as the clock line gives it/);
  assert.doesNotMatch(text, /30 minutes old/);
  assert.match(lookInstruction(now, undefined, undefined, dir()), /"status-brief: none today"/);
});
