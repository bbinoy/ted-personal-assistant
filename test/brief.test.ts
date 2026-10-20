import { test } from "node:test";
import assert from "node:assert/strict";
import { clockLine } from "../src/core/brief.ts";
import { localDay } from "../src/core/pause.ts";
const at = (iso: string) => new Date(iso); // local time, no zone suffix

test("clock line: exact weekday and date pairs", () => {
  const line = clockLine(at("2026-10-11T09:30:00"));
  assert.match(line, /it is now Sunday 2026-10-11 09:30/);
  assert.match(line, /Yesterday was Saturday 2026-10-10/);
  assert.match(line, /Tomorrow is Monday 2026-10-12/);
  assert.match(line, /day after is Tuesday 2026-10-13/);
});

test("clock line: month and year rollover", () => {
  const line = clockLine(at("2026-12-31T08:00:00"));
  assert.match(line, /Tomorrow is Friday 2027-01-01/);
  assert.equal(localDay(at("2026-01-05T00:00:00")), "2026-01-05");
});

