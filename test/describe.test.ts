import { test } from "node:test";
import assert from "node:assert/strict";
import { callLabel, forgetCreated, idsInResult, noteCreated } from "../src/approvals/created.ts";
import { objectLines } from "../src/approvals/describe.ts";
import { factsOf, validateQuestion } from "../src/approvals/questionfacts.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { resetDeclined } from "../src/approvals/declined.ts";
import { setDraftReader } from "../src/modules/mailbird/module.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";

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
  const canUse = makeCanUseTool(async (d) => (asked.push(d), { approved: false }), "chat", undefined, ask as never, undefined, undefined, false, { provenance: () => ({ kind: "owner", message: "m" }), conversation: "owner" });
  await canUse(DELETE, { calendarId: "primary", eventId: "bq99vc4x1" }, opts);
  assert.match(asked[0]!, /\nNamed: “Coffee”, Wed 21 Oct, 09:00–10:00 \(the assistant created it earlier in this conversation\)/);
  const facts = factsOf({ calendarId: "primary", eventId: "bq99vc4x1" }, asked[0]!);
  assert.ok(facts.must.includes("Coffee") && facts.must.includes("bq99vc4x1"));
  assert.match(validateQuestion("Delete calendar event bq99vc4x1? Nobody will be notified.", facts) ?? "", /Coffee/);
  assert.equal(validateQuestion("Delete the event “Coffee” (bq99vc4x1)? Nobody will be notified.", facts), undefined);
});

test("another conversation's event is not named from this one's record; unknown says so for a delete, and a call that names itself needs no line", async () => {
  forgetCreated();
  noteCreated("g-1", ["abc"], Date.now(), "“Secret”");
  assert.equal(await objectLines("owner", DELETE, { eventId: "abc" }), "\nNamed: unknown (only its id is known: it was not made by the assistant here and could not be looked up)");
  assert.equal(await objectLines("owner", "mcp__claude_ai_Google_Calendar__update_event", { eventId: "abc", startTime: "2026-10-21T09:00:00" }), "", "an update of an unknown event: no claim");
  assert.equal(await objectLines("owner", DELETE, { eventId: "abc", summary: "Coffee" }), "");
  assert.equal(await objectLines("owner", CREATE, { summary: "Coffee" }), "");
});

test("the module's own lookup names an object the assistant did not make; a failing or slow lookup is quiet", async () => {
  forgetCreated();
  setDraftReader(async () => ({ to: ["a@example.com"], cc: [], bcc: [], subject: "Offsite agenda", body: "b", hasAttachments: false }) as never);
  assert.equal(await objectLines("owner", "mcp__mailbird__discard_draft", { messageId: 7 }), "\nNamed: Draft “Offsite agenda” to a@example.com");
  setDraftReader(async () => { throw new Error("down"); });
  assert.match(await objectLines("owner", "mcp__mailbird__discard_draft", { messageId: 7 }), /^\nNamed: unknown/);
  assert.equal(await objectLines("owner", DELETE, { eventId: "zzz" }, async () => { throw new Error("x"); }), "\nNamed: unknown (only its id is known: it was not made by the assistant here and could not be looked up)");
});
