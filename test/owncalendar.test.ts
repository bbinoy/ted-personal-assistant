import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isJudgeable, notifyNote, type JudgeInput, type Verdict } from "../src/approvals/autojudge.ts";
import { SYSTEM } from "../src/approvals/approvaljudge.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { settings } from "../src/core/settings.ts";

// An event on the owner's OWN calendar with nobody else on it is routine (the owner, 22 Oct: "it's just an event for me"): the judge autos it even when the day or time is the assistant's
// best guess, and the assistant says in its reply which date and time it chose. Events that invite or notify people keep the careful rule; deletes keep theirs.

const CAL = "mcp__claude_ai_Google_Calendar__";
const opts = { signal: new AbortController().signal } as never;
(settings as unknown as { autoApprove: string }).autoApprove = "auto";
const UNCLE = { summary: "Visit godmother Uschi", startTime: "2026-10-24T10:00:00+02:00", endTime: "2026-10-24T13:30:00+02:00" };

function chat(verdict: Verdict["decision"]) {
  const judged: JudgeInput[] = [];
  const asked: string[] = [];
  const can = makeCanUseTool(async (d) => (asked.push(d), { approved: false }), "chat", undefined, async (i) => (judged.push(i), { decision: verdict, reason: "test" }), undefined, undefined, false, { conversation: `own-cal-${Math.random()}`, provenance: () => ({ kind: "owner", message: "put the visit to my godmother Uschi on Saturday in my calendar" }) as never });
  return { can, judged, asked };
}

test("the judge's rule: own calendar, no guests, no notifications is auto even with a guessed day or time; inviting, notifying and deleting keep their rules", () => {
  assert.match(SYSTEM, /creating, moving or editing an event on .*'s OWN calendar whose action names no guests or attendees and asks for no notifications/);
  assert.match(SYSTEM, /even when the request left the day or the time open and the assistant chose the most likely reading/);
  assert.match(SYSTEM, /Ambiguity of the date or the time alone is never a reason to ask for such an event/);
  assert.match(SYSTEM, /An event that names guests, invites or notifies anyone, or sits on a calendar that is not .*'s own keeps the careful rule above; a delete keeps the delete rule below/);
  assert.match(SYSTEM, /see the own-calendar rule below: a guessed day or time of an event nobody else sees is not ambiguity to ask about/);
});

test("a no-guest create with a guessed time reaches the judge with the 'names no guests' line, and its auto runs it without a question", async () => {
  assert.equal(isJudgeable(`${CAL}create_event`, UNCLE), true);
  assert.match(notifyNote(`${CAL}create_event`, UNCLE), /this call names no guests; this call asks for no notifications/);
  const c = chat("auto");
  assert.equal(((await c.can(`${CAL}create_event`, UNCLE, opts)) as { behavior: string }).behavior, "allow");
  assert.equal(c.asked.length, 0);
  assert.match(c.judged[0]!.description, /Notifies: this call names no guests; this call asks for no notifications/);
});

test("an update of the owner's own no-guest event is judged the same way (auto runs it)", async () => {
  const c = chat("auto");
  assert.equal(isJudgeable(`${CAL}update_event`, { eventId: "e1", startTime: "2026-10-24T11:00:00+02:00" }), true);
  assert.equal(((await c.can(`${CAL}update_event`, { eventId: "e1", startTime: "2026-10-24T11:00:00+02:00" }, opts)) as { behavior: string }).behavior, "allow");
  assert.equal(c.asked.length, 0);
});

test("an event with an attendee is still the owner's call: never judged, asked in chat", async () => {
  const withGuest = { ...UNCLE, attendees: ["uschi@example.com"] };
  assert.equal(isJudgeable(`${CAL}create_event`, withGuest), false);
  const c = chat("auto");
  assert.equal(((await c.can(`${CAL}create_event`, withGuest, opts)) as { behavior: string }).behavior, "deny", "the stub owner said no");
  assert.deepEqual([c.judged.length, c.asked.length], [0, 1]);
});

test("the calendar skill and the chat persona say: create it, pick the likely day and time, and say which", () => {
  const skill = readFileSync("plugin/skills/calendar/SKILL.md", "utf8");
  assert.match(skill, /## The owner's own events, nobody else on them \(in chat\)/);
  assert.match(skill, /SAY in your reply which date and time you chose/);
  const chatMd = readFileSync("assistants/ted/persona/chat.md", "utf8");
  assert.match(chatMd, /pick the most likely one and say in your reply which date and time you chose/);
});
