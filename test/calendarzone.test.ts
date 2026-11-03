import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanToolOutput } from "../src/core/toolclean.ts";

// Calendar results state every event time in the conversation's zone: a booking tagged with another zone must not read as a wall-clock in that zone.

const TOOL = "mcp__claude_ai_Google_Calendar__list_events";
const ZONE = "Europe/Zurich";
const result = (events: unknown[]) => ({ content: [{ type: "text", text: JSON.stringify({ events }) }] });
const read = (r: { output: unknown } | undefined) => JSON.parse(((r!.output as ReturnType<typeof result>).content[0] as { text: string }).text).events;

test("a Lisbon-tagged booking whose offset is already the owner's reads 17:00 Zurich, with no Lisbon left", () => {
  const ev = { summary: "Call", start: { dateTime: "2026-11-04T17:00:00+01:00", timeZone: "Europe/Lisbon" }, end: { dateTime: "2026-11-04T17:30:00+01:00", timeZone: "Europe/Lisbon" } };
  const [out] = read(cleanToolOutput(TOOL, result([ev]), undefined, ZONE));
  assert.deepEqual(out.start, { dateTime: "2026-11-04T17:00:00+01:00", timeZone: ZONE });
  assert.deepEqual(out.end, { dateTime: "2026-11-04T17:30:00+01:00", timeZone: ZONE });
  assert.doesNotMatch(JSON.stringify(out), /Lisbon/);
});

test("a UTC or other-offset time is moved to the zone, summer time included", () => {
  const evs = [
    { start: { dateTime: "2026-11-04T16:00:00Z" } },
    { start: { dateTime: "2026-07-01T10:00:00-04:00", timeZone: "America/New_York" } },
  ];
  const [a, b] = read(cleanToolOutput(TOOL, result(evs), undefined, ZONE));
  assert.deepEqual(a.start, { dateTime: "2026-11-04T17:00:00+01:00", timeZone: ZONE });
  assert.deepEqual(b.start, { dateTime: "2026-07-01T16:00:00+02:00", timeZone: ZONE });
});

test("an all-day event is left alone", () => {
  const ev = { start: { date: "2026-11-04" }, end: { date: "2026-11-05" } };
  assert.equal(cleanToolOutput(TOOL, result([ev]), undefined, ZONE), undefined);
});

test("without a known zone, or for another tool, the result is untouched", () => {
  const ev = { start: { dateTime: "2026-11-04T17:00:00+01:00", timeZone: "Europe/Lisbon" } };
  assert.equal(cleanToolOutput(TOOL, result([ev])), undefined);
  assert.equal(cleanToolOutput("mcp__claude_ai_Notion__notion-fetch", result([ev]), undefined, ZONE), undefined);
});
