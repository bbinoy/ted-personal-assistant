import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/policy/policy.ts";
import { isJudgeable, mayFix, notifyNote } from "../src/approvals/autojudge.ts";
import { describeCall } from "../src/approvals/format.ts";
import { entryFor, isFree } from "../src/policy/toolmanifest.ts";
import { notifyLine } from "../src/policy/guests.ts";
import { OWNER_CHAT, OWNER_LOOK, GROUP_CHAT } from "./runkinds.ts";

// Mailbird's calendar, contacts and folder tools (src/modules/mailbird/calendar.ts, module.ts) under the one floor every calendar has.

const MB = "mcp__mailbird__";
const event = { subject: "Dentist", startUtc: "2026-05-04T13:00:00Z", endUtc: "2026-05-04T14:00:00Z", timeZone: "Europe/Zurich", notifyAttendees: false, confirm: false };

test("calendar: reads are free; event writes, the answer to an invite and a delete are judged or asked, never free", () => {
  for (const t of ["list_calendars", "list_calendar_events", "search_contacts"]) assert.equal(classify(`${MB}${t}`, {}, OWNER_CHAT), "allow", t);
  for (const t of ["create_calendar_event", "update_calendar_event", "respond_to_calendar_event", "delete_calendar_event", "create_contact", "update_contact", "delete_contact", "remove_conversation_from_folder"]) {
    assert.equal(isFree(`${MB}${t}`), false, t);
    assert.equal(classify(`${MB}${t}`, {}, OWNER_CHAT), "ask", t);
  }
  assert.equal(entryFor(`${MB}create_calendar_event`)?.cap, "calendar");
  assert.equal(entryFor(`${MB}create_contact`)?.cap, "mail");
  assert.equal(classify(`${MB}create_calendar_event`, event, GROUP_CHAT), "deny", "a group has no calendar");
});

test("calendar: containers are no rows; deleting a whole calendar is denied for everyone", () => {
  for (const t of ["create_calendar", "update_calendar"]) assert.equal(entryFor(`${MB}${t}`), undefined, t);
  for (const run of [OWNER_CHAT, OWNER_LOOK]) assert.equal(classify(`${MB}delete_calendar`, { calendarId: "c1", confirm: true }, run), "deny");
});

test("calendar: a delete that would email guests is never judged; the judge is told what the call notifies", () => {
  assert.equal(isJudgeable(`${MB}delete_calendar_event`, { eventId: "e1", notifyAttendees: false, confirm: false }), true);
  assert.equal(isJudgeable(`${MB}delete_calendar_event`, { eventId: "e1", notifyAttendees: true, confirm: true }), false);
  assert.equal(mayFix(`${MB}delete_calendar_event`, { input: { eventId: "e1" } }), false);
  assert.equal(mayFix(`${MB}respond_to_calendar_event`), false, "answering an invitation is the owner's call");
  assert.match(notifyNote(`${MB}create_calendar_event`, event), /names no guests; this call asks for no notifications/, "false flags ask for nothing");
  assert.match(notifyNote(`${MB}create_calendar_event`, { ...event, attendees: [{ email: "guest@example.com" }], notifyAttendees: true, confirm: true }), /names guests; notifyAttendees=true, confirm=true/);
  assert.match(notifyLine({ notifyAttendees: "false" }), /asks for no notifications/);
});

test("calendar: the question shows the event in its own zone, and only a flag that is on", () => {
  const text = describeCall(`${MB}create_calendar_event`, event);
  assert.match(text, /Create calendar event/);
  assert.match(text, /Mon 4 May, 15:00–16:00 \(Europe\/Zurich\)/, "UTC converted to the event's zone");
  assert.doesNotMatch(text, /notifyAttendees|confirm|startUtc/);
  assert.match(describeCall(`${MB}create_calendar_event`, { ...event, attendees: ["guest@example.com"], notifyAttendees: true, confirm: true }), /notifyAttendees: true/);
  assert.match(describeCall(`${MB}create_calendar_event`, { subject: "x", startUtc: "2026-05-04T13:00:00Z", endUtc: "2026-05-04T14:00:00Z" }), /13:00–14:00 \(UTC\)/, "no zone: shown as UTC");
  assert.match(describeCall(`${MB}create_calendar_event`, { subject: "Holiday", startUtc: "2026-05-04T00:00:00Z", endUtc: "2026-05-05T00:00:00Z", isAllDay: true }), /Mon 4 May to Tue 5 May, all day/);
});
