import { test } from "node:test";
import assert from "node:assert/strict";
import { callLabel, forgetCreated, noteCreated } from "../src/approvals/created.ts";
import { forgetSeen, rememberNames, seenName } from "../src/approvals/seennames.ts";
import { objectLines } from "../src/approvals/describe.ts";
import { SYSTEM } from "../src/approvals/approvaljudge.ts";

// An event's guest count in the "Named:" line: written by code from a read result or the creating call, a count only, and nothing when the source does not say.

const when = { startUtc: "2026-05-04T13:00:00Z", endUtc: "2026-05-04T14:00:00Z" };

test("a read event's guests are kept as a count; no attendees field is unknown, never 'no guests'", () => {
  forgetSeen();
  rememberNames("c", JSON.stringify({ events: [
    { id: "e-none", subject: "Solo", ...when, attendees: [] },
    { id: "e-self", subject: "Alone", ...when, attendees: [{ email: "me@example.com", self: true }] },
    { id: "e-three", subject: "Sync", ...when, attendees: [{ email: "a@example.com", self: true }, { email: "b@example.com" }, { email: "c@example.com" }, { displayName: "Dee" }] },
    { id: "e-one", subject: "Pair", ...when, attendees: [{ email: "b@example.com" }] },
    { id: "e-unknown", subject: "Maybe", ...when },
    { id: "m-1", subject: "A mail", attendees: ["x@example.com"] },
  ] }));
  assert.match(seenName("c", "e-none")!, /, no guests$/);
  assert.match(seenName("c", "e-self")!, /, no guests$/, "the person themself is no guest");
  assert.match(seenName("c", "e-three")!, /, 3 guests$/);
  assert.match(seenName("c", "e-one")!, /, 1 guest$/);
  assert.doesNotMatch(seenName("c", "e-unknown")!, /guest/);
  assert.doesNotMatch(seenName("c", "m-1")!, /guest/, "not an event");
  assert.doesNotMatch(seenName("c", "e-three")!, /Dee|example/, "a count only, never a name");
  forgetSeen();
});

test("what the assistant made: nobody named is no guests, a list is counted, anything else says nothing", () => {
  const base = { summary: "Tapas", startTime: "2026-05-04T19:00:00", endTime: "2026-05-04T21:00:00" };
  assert.match(callLabel(base)!, /, no guests$/);
  assert.match(callLabel({ ...base, attendees: [{ email: "a@example.com" }, { email: "b@example.com" }] })!, /, 2 guests$/);
  assert.doesNotMatch(callLabel({ ...base, attendees: "a@example.com" })!, /guest/);
  assert.equal(callLabel({ properties: { title: "Trip notes" } }), "“Trip notes”", "a page has no guests");
});

test("the Named line of a delete carries the count, and the judge's rule names it", async () => {
  forgetSeen();
  forgetCreated();
  rememberNames("c", JSON.stringify({ events: [{ id: "e-three", subject: "Sync", ...when, attendees: [{ email: "b@example.com" }] }] }));
  assert.match(await objectLines("c", "mcp__mailbird__delete_calendar_event", { eventId: "e-three" }), /\nNamed: “Sync”.*, 1 guest$/);
  noteCreated("c", ["e-new"], Date.now(), callLabel({ summary: "Tapas", startTime: "2026-05-04T19:00:00", endTime: "2026-05-04T21:00:00" }));
  assert.match(await objectLines("c", "mcp__mailbird__delete_calendar_event", { eventId: "e-new" }), /, no guests \(the assistant created it earlier in this conversation\)$/);
  assert.match(SYSTEM, /Named line itself ends in "no guests" .*no guest count on the Named line, ask/);
  forgetSeen();
  forgetCreated();
});
