import { test } from "node:test";
import assert from "node:assert/strict";
import { callGuests, callLabel, forgetCreated, noteCreated } from "../src/approvals/created.ts";
import { forgetGuests, forgetSeen, rememberNames, seenGuests } from "../src/approvals/seennames.ts";
import { objectLines } from "../src/approvals/describe.ts";
import { SYSTEM } from "../src/approvals/approvaljudge.ts";

// An event's guest count in the "Named:" line: written by code from a read result or the creating call, a count only, and nothing when the source does not say.

const when = { startUtc: "2026-05-04T13:00:00Z", endUtc: "2026-05-04T14:00:00Z" };
const DEL = "mcp__mailbird__delete_calendar_event";
const me = { email: "me@example.com", self: true };
const read = (rows: unknown[]) => rememberNames("c", JSON.stringify({ events: rows }));

test("a read event's guests are a count; no list, a hidden list or a self-only list that is not the owner's own is unknown, never 'no guests'", () => {
  forgetSeen();
  read([
    // Google Calendar API shapes: attendees[{email, self, organizer, responseStatus}], organizer{self}, attendeesOmitted
    { id: "g-own", summary: "Mine", ...when, organizer: { email: "me@example.com", self: true } },
    { id: "g-own-solo", summary: "Mine alone", ...when, organizer: { self: true }, attendees: [{ ...me, organizer: true, responseStatus: "accepted" }] },
    { id: "g-two", summary: "Sync", ...when, organizer: { self: true }, attendees: [{ ...me, organizer: true }, { email: "b@example.com", responseStatus: "needsAction" }, { email: "c@example.com" }] },
    { id: "g-omitted", summary: "Big", ...when, organizer: { email: "x@example.com" }, attendeesOmitted: true, attendees: [me] },
    { id: "g-hidden", summary: "Invited", ...when, organizer: { email: "x@example.com", self: false }, attendees: [me] },
    { id: "g-theirs", summary: "Theirs", ...when, organizer: { email: "x@example.com" }, attendees: [me, { email: "x@example.com", organizer: true }] },
    // Mailbird list_calendar_events: rows carry id, subject, startUtc, organizer (an address) and attendees only when there are guests
    { id: "m-none", subject: "Dentist", ...when, organizer: "me@example.com" },
    { id: "m-one", subject: "Pair", ...when, organizer: "me@example.com", attendees: [{ email: "b@example.com" }] },
    { id: "m-empty", subject: "Empty", ...when, organizer: "me@example.com", attendees: [] },
    { id: "mail-1", subject: "A mail", attendees: ["x@example.com"] },
  ]);
  assert.equal(seenGuests("c", "g-own"), undefined, "no attendees field: unknown");
  assert.equal(seenGuests("c", "g-own-solo"), 0, "the owner organizes and lists only themself");
  assert.equal(seenGuests("c", "g-two"), 2);
  assert.equal(seenGuests("c", "g-omitted"), undefined, "attendeesOmitted");
  assert.equal(seenGuests("c", "g-hidden"), undefined, "someone else organizes and only the owner is listed: guests may be hidden");
  assert.equal(seenGuests("c", "g-theirs"), 1, "an invitation: the other organizer counts");
  assert.equal(seenGuests("c", "m-none"), undefined);
  assert.equal(seenGuests("c", "m-one"), 1);
  assert.equal(seenGuests("c", "m-empty"), undefined, "an empty list proves nothing");
  assert.equal(seenGuests("c", "mail-1"), undefined, "not an event");
  forgetSeen();
});

test("what the assistant made: nobody named is no guests, a list is counted, anything else and a non-event say nothing", () => {
  const base = { summary: "Tapas", startTime: "2026-05-04T19:00:00", endTime: "2026-05-04T21:00:00" };
  assert.equal(callGuests(base), 0);
  assert.equal(callGuests({ ...base, attendees: [{ email: "a@example.com" }, { email: "b@example.com" }] }), 2);
  assert.equal(callGuests({ ...base, attendees: "a@example.com" }), undefined);
  assert.equal(callGuests({ properties: { title: "Trip notes" } }), undefined, "a page has no guests");
  assert.equal(callLabel(base), "“Tapas”, Mon 4 May, 19:00–21:00", "the label itself is unchanged: the journal reads it");
});

test("the Named line of a delete carries the count; a later write that names people makes it unknown (read and made)", async () => {
  forgetSeen();
  forgetCreated();
  read([{ id: "e-read", subject: "Sync", ...when, organizer: { self: true }, attendees: [me] }]);
  const base = { summary: "Tapas", startTime: "2026-05-04T19:00:00", endTime: "2026-05-04T21:00:00" };
  noteCreated("c", ["e-new"], Date.now(), callLabel(base), callGuests(base));
  assert.match(await objectLines("c", DEL, { eventId: "e-read" }), /\nNamed: “Sync”[^\n]*\nGuests: none \(counted by code\)$/);
  assert.match(await objectLines("c", DEL, { eventId: "e-new" }), /\(the assistant created it earlier in this conversation\)\nGuests: none \(counted by code\)$/);
  for (const id of ["e-read", "e-new"]) forgetGuests("c", { eventId: id, attendees: [{ email: "a@example.com" }], notifyAttendees: false });
  assert.doesNotMatch(await objectLines("c", DEL, { eventId: "e-read" }), /Guests:/);
  assert.doesNotMatch(await objectLines("c", DEL, { eventId: "e-new" }), /Guests:/, "made with nobody, then an update added a guest: unknown, so the judge asks");
  assert.match(await objectLines("c", DEL, { eventId: "e-new" }), /\nNamed: “Tapas”/);
  forgetSeen();
  forgetCreated();
});

test("the judge's rule: only the owner's own message, now, and a guest count that reads 'no guests'", () => {
  assert.match(SYSTEM, /only when .{1,30}'s own message asks to remove this event, now/);
  assert.match(SYSTEM, /"Guests:" line written by code reads "none"/);
  assert.match(SYSTEM, /a standing task or a look never makes it auto/);
});
