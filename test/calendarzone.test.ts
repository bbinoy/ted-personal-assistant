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

// Mailbird's list_calendar_events: a top-level array of rows with UTC times and no zone; code adds the wall times in the conversation's zone and keeps the UTC ones.
const MB_TOOL = "mcp__mailbird__list_calendar_events";
const rows = (r: unknown[]) => ({ content: [{ type: "text", text: JSON.stringify(r) }] });
const rowsOut = (r: { output: unknown } | undefined) => JSON.parse(((r!.output as ReturnType<typeof rows>).content[0] as { text: string }).text);

test("a Mailbird row gets start and end in the owner's zone, summer time included, and keeps startUtc and endUtc", () => {
  const ev = (startUtc: string, endUtc: string) => ({ id: 7, calendarId: 1, calendarName: "Home", subject: "Call", startUtc, endUtc, isAllDay: false, location: "", organizerEmail: "a@example.com", status: "confirmed", isRecurring: false, isRecurringInstance: false });
  const [a, b] = rowsOut(cleanToolOutput(MB_TOOL, rows([ev("2026-11-04T16:00:00Z", "2026-11-04T16:30:00Z"), ev("2026-07-01T14:00:00Z", "2026-07-01T15:00:00Z")]), undefined, ZONE));
  assert.deepEqual([a.start, a.end, a.startUtc], ["2026-11-04T17:00:00+01:00", "2026-11-04T17:30:00+01:00", "2026-11-04T16:00:00Z"]);
  assert.deepEqual([b.start, b.end], ["2026-07-01T16:00:00+02:00", "2026-07-01T17:00:00+02:00"]);
});

test("an all-day Mailbird row is its UTC dates, not shifted; without a zone or for another tool nothing changes", () => {
  const ev = { id: 8, subject: "Holiday", startUtc: "2026-11-04T00:00:00Z", endUtc: "2026-11-05T00:00:00Z", isAllDay: true };
  const [out] = rowsOut(cleanToolOutput(MB_TOOL, rows([ev]), undefined, "America/New_York"));
  assert.deepEqual([out.start, out.end], ["2026-11-04", "2026-11-05"]);
  assert.equal(cleanToolOutput(MB_TOOL, rows([ev])), undefined);
  assert.equal(cleanToolOutput("mcp__mailbird__get_message", rows([ev]), undefined, ZONE), undefined);
});
