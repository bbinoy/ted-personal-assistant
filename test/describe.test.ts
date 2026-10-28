import { test } from "node:test";
import assert from "node:assert/strict";
import { callLabel, forgetCreated, idsInResult, noteCreated } from "../src/approvals/created.ts";
import { rememberNames, forgetSeen } from "../src/approvals/seennames.ts";
import { APPROVAL_SYSTEM } from "../src/approvals/approvalprompt.ts";
import { objectLines } from "../src/approvals/describe.ts";
import { factsOf, validateQuestion } from "../src/approvals/questionfacts.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { resetDeclined } from "../src/approvals/declined.ts";
import { setDraftReader } from "../src/modules/mailbird/module.ts";
import { eventLabel, setEventReader } from "../src/modules/google/module.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { OWNER_CHAT } from "./runkinds.ts";

const CREATE = "mcp__claude_ai_Google_Calendar__create_event";
const DELETE = "mcp__claude_ai_Google_Calendar__delete_event";
const opts = { signal: new AbortController().signal } as never;
const ask: () => Promise<Verdict> = async () => ({ decision: "ask", reason: "x" });

test("a create's title and time are kept with its id for 24 hours, per conversation", () => {
  forgetCreated();
  const input = { summary: "Coffee", startTime: "2026-10-21T09:00:00", endTime: "2026-10-21T10:00:00" };
  assert.equal(callLabel(input), "“Coffee”, Wed 21 Oct, 09:00–10:00");
  assert.equal(callLabel({ properties: { title: "Trip notes" } }), "“Trip notes”");
  assert.equal(callLabel({ start: { dateTime: "2026-10-21T09:00:00" }, summary: "A" }), "“A”, Wed 21 Oct, 09:00");
  assert.equal(callLabel({ foo: 1 }), undefined);
  noteCreated("owner", idsInResult({ id: "bq99vc4x1" }), 1_000, callLabel(input));
});

// The 20 October incident, last part: the delete of the event the assistant just made is asked by its name, not by a raw id.
test("the delete question carries the title and time of what the assistant created, and the title must be in the question", async () => {
  forgetCreated();
  resetDeclined();
  noteCreated("owner", idsInResult('{"id":"bq99vc4x1"}'), Date.now(), callLabel({ summary: "Coffee", startTime: "2026-10-21T09:00:00", endTime: "2026-10-21T10:00:00" }));
  const asked: string[] = [];
  const canUse = makeCanUseTool(async (d) => (asked.push(d), { approved: false }), OWNER_CHAT, undefined, ask as never, undefined, undefined, false, { provenance: () => ({ kind: "owner", message: "m" }), conversation: "owner" });
  await canUse(DELETE, { calendarId: "primary", eventId: "bq99vc4x1" }, opts);
  assert.match(asked[0]!, /\nNamed: “Coffee”, Wed 21 Oct, 09:00–10:00 \(the assistant created it earlier in this conversation\)/);
  const facts = factsOf({ calendarId: "primary", eventId: "bq99vc4x1" }, asked[0]!);
  assert.ok(facts.must.includes("Coffee") && !facts.must.includes("bq99vc4x1"));
  assert.match(validateQuestion("Delete calendar event bq99vc4x1? Nobody will be notified.", facts) ?? "", /Coffee/);
  assert.equal(validateQuestion("Delete the event “Coffee” (bq99vc4x1)? Nobody will be notified.", facts), undefined);
  assert.equal(validateQuestion("Delete “Coffee” on Wed 21 Oct at 09:00? Say yes to go ahead.", facts), undefined, "no id needed when the title is there");
});

test("another conversation's event is not named from this one's record; unknown says so for a delete, and a call that names itself needs no line", async () => {
  forgetCreated();
  noteCreated("g-1", ["abc"], Date.now(), "“Secret”");
  assert.equal(await objectLines("owner", DELETE, { eventId: "abc" }), "\nNamed: unknown (only its id is known: it was not made by the assistant here, not read in this conversation, and could not be looked up)");
  assert.equal(await objectLines("owner", "mcp__claude_ai_Google_Calendar__update_event", { eventId: "abc", startTime: "2026-10-21T09:00:00" }), "", "a change of an unknown event: no claim");
  assert.equal(await objectLines("owner", DELETE, { eventId: "abc", summary: "Coffee" }), "");
  assert.equal(await objectLines("owner", CREATE, { summary: "Coffee" }), "");
});

test("the module's own lookup names an object the assistant did not make; a failing or slow lookup is quiet", async () => {
  forgetCreated();
  setDraftReader(async () => ({ to: ["a@example.com"], cc: [], bcc: [], subject: "Offsite agenda", body: "b", hasAttachments: false }) as never);
  assert.equal(await objectLines("owner", "mcp__mailbird__discard_draft", { messageId: 7 }), "\nNamed: Draft “Offsite agenda” to a@example.com");
  setDraftReader(async () => { throw new Error("down"); });
  assert.match(await objectLines("owner", "mcp__mailbird__discard_draft", { messageId: 7 }), /^\nNamed: unknown/);
  assert.equal(await objectLines("owner", DELETE, { eventId: "zzz" }, async () => { throw new Error("x"); }), "\nNamed: unknown (only its id is known: it was not made by the assistant here, not read in this conversation, and could not be looked up)");
});

const LIST = JSON.stringify({ events: [{ id: "_clr78bbkdhc46obadh3n6lidedm66h20clr6arjkecn6ot9edlgg", summary: "Embassy reception", start: { dateTime: "2026-11-21T18:00:00" }, end: { dateTime: "2026-11-21T20:00:00" } }] });

test("an event the run read with list_events is named in the details, with its time; another conversation does not know it", async () => {
  forgetCreated();
  forgetSeen();
  rememberNames("owner", LIST);
  const id = "_clr78bbkdhc46obadh3n6lidedm66h20clr6arjkecn6ot9edlgg";
  assert.equal(await objectLines("owner", DELETE, { eventId: id }), "\nNamed: “Embassy reception”, Sat 21 Nov, 18:00–20:00");
  assert.match(await objectLines("g-1", DELETE, { eventId: id }), /^\nNamed: unknown/);
});

test("a delete of an event the run never saw is sent back to be looked up, not asked; the same call again is asked", async () => {
  forgetCreated();
  forgetSeen();
  resetDeclined();
  const asked: string[] = [];
  const canUse = makeCanUseTool(async (d) => (asked.push(d), { approved: false }), OWNER_CHAT, undefined, ask as never, undefined, undefined, false, { provenance: () => ({ kind: "owner", message: "m" }), conversation: "owner" });
  const r = await canUse(DELETE, { calendarId: "primary", eventId: "unseen1" }, opts);
  assert.equal(r?.behavior, "deny");
  assert.match((r as { message: string }).message, /Look the object up first/);
  assert.equal(asked.length, 0);
  await canUse(DELETE, { calendarId: "primary", eventId: "unseen1" }, opts);
  assert.equal(asked.length, 1, "the owner is asked only when it still cannot be named");
  rememberNames("owner", LIST);
  await canUse(DELETE, { calendarId: "primary", eventId: "_clr78bbkdhc46obadh3n6lidedm66h20clr6arjkecn6ot9edlgg" }, opts);
  assert.match(asked[1]!, /Named: “Embassy reception”/);
});

test("questionfacts: a question needs no id, but still the address and the amount", () => {
  const f = factsOf({ eventId: "abc123", summary: "Dentist", attendees: ["a@example.com"], note: "pay 40 EUR" }, "");
  assert.ok(!f.must.includes("abc123"));
  assert.equal(validateQuestion("Cancel Dentist for a@example.com, 40 EUR?", f), undefined);
  assert.match(validateQuestion("Cancel Dentist, 40 EUR?", f) ?? "", /a@example.com/);
  assert.match(validateQuestion("Cancel Dentist for a@example.com?", f) ?? "", /40 EUR/);
});

test("the write prompt tells the writer never to show ids", () => {
  assert.match(APPROVAL_SYSTEM, /Never show ids/);
});

test("a friend's event named only by its id is read back from her own calendar; a failure is 'unknown', another conversation is never asked", async () => {
  forgetCreated();
  forgetSeen();
  const MANAGE = "mcp__google__manage_event";
  const calls: string[][] = [];
  setEventReader(async (tenantId, eventId) => (calls.push([tenantId, eventId]), "Event Details:\n- Title: Piano lesson\n- Starts: 2026-10-29T16:00:00+01:00\n- Ends: 2026-10-29T17:00:00+01:00"));
  assert.equal(await objectLines("tenant:ann", MANAGE, { action: "delete", event_id: "ev1" }), "\nNamed: “Piano lesson”, 2026-10-29T16:00:00+01:00");
  assert.deepEqual(calls, [["ann", "ev1"]]);
  assert.equal(await objectLines("tenant:ann", MANAGE, { action: "create", summary: "x", event_id: "ev2" }), "", "a call that names itself needs no read");
  assert.match(await objectLines("g-1", MANAGE, { action: "delete", event_id: "ev1" }), /^\nNamed: unknown/, "only a friend's own conversation reads her calendar");
  assert.equal(calls.length, 1);
  setEventReader(async () => { throw new Error("down"); });
  assert.match(await objectLines("tenant:ann", MANAGE, { action: "delete", event_id: "ev3" }), /^\nNamed: unknown/);
  assert.equal(eventLabel('{"summary":"Dentist","start":{"dateTime":"2026-10-30T09:00:00Z"}}'), "“Dentist”, 2026-10-30T09:00:00Z");
  assert.equal(eventLabel("nothing useful"), undefined);
});
