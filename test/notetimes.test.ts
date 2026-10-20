import { test } from "node:test";
import assert from "node:assert/strict";
import { dayPart, namedTimes, namesTimeInQuietHours, passedTimes } from "../src/notetimes.ts";

const ats = (t: string) => namedTimes(t).flatMap((x) => [x.at / 60, ...(x.alt === undefined ? [] : [x.alt / 60])]);

test("notetimes: clock strings, am/pm, Uhr, bare hours, noon and midnight are found", () => {
  assert.deepEqual(ats("Post at 9:40"), [9 + 40 / 60]);
  assert.deepEqual(ats("every day 18.30"), [18.5]);
  assert.deepEqual(ats("at 5pm"), [17]);
  assert.deepEqual(ats("12am"), [0]);
  assert.deepEqual(ats("ab 18 Uhr"), [18]);
  assert.deepEqual(ats("at 5"), [5, 17]); // a bare hour may be the afternoon
  assert.deepEqual(ats("at noon"), [12]);
  assert.deepEqual(ats("until midnight"), [0]);
  assert.deepEqual(ats("every 2h"), []); // an interval is not a time of day
  assert.deepEqual(ats("a fun fact every morning"), []);
  assert.deepEqual(ats("(until 2026-10-20) nothing"), []);
  assert.deepEqual(ats("at 25:99"), []);
});

test("notetimes: passed times change exactly when a named time is crossed; day parts are coarse", () => {
  const t = namedTimes("at 9:40");
  assert.notEqual(passedTimes(t, new Date(2026, 9, 14, 9, 39)), passedTimes(t, new Date(2026, 9, 14, 9, 40)));
  assert.equal(passedTimes(t, new Date(2026, 9, 14, 10, 0)), passedTimes(t, new Date(2026, 9, 14, 23, 0)));
  assert.deepEqual([3, 8, 13, 19, 23].map((h) => dayPart(new Date(2026, 9, 14, h))), ["night", "morning", "afternoon", "evening", "late"]);
});

test("notetimes: a time inside the quiet window (wrapping midnight) is named, one outside is not", () => {
  assert.equal(namesTimeInQuietHours("weather at 6:30", 22, 7), true);
  assert.equal(namesTimeInQuietHours("party at 23:15", 22, 7), true);
  assert.equal(namesTimeInQuietHours("lunch at 12:30 and 18 Uhr", 22, 7), false);
  assert.equal(namesTimeInQuietHours("at 9", 22, 7), false); // bare 9 is read as written, not as 21
  assert.equal(namesTimeInQuietHours("nothing", 22, 7), false);
});
