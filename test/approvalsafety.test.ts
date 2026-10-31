import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApprove } from "../src/approvals/approvalask.ts";
import { recipientsOutside, type RunProvenance, type Verdict } from "../src/approvals/autojudge.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { describeCall } from "../src/approvals/format.ts";
import { setDraftReader } from "../src/modules/mailbird/module.ts";
import { scopeOf } from "../src/approvals/turnscope.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownPeople } from "../src/modules/people/people.ts";
import { CHAT } from "./util.ts";
import { OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

const SEND = "mcp__mailbird__send_message_now";
const CAL = "mcp__claude_ai_Google_Calendar__create_event";
const opts = { signal: new AbortController().signal } as never;

test("makeApprove: the sent question is the model's own, unchanged", async () => {
  const seen: { question?: string }[] = [];
  const request = (async (_s: unknown, _d: string, _c: unknown, _a: unknown, o: { question?: string }) => (seen.push(o), { approved: true })) as never;
  const compose = (async () => ({ text: "Send a short thank-you to a@example.com?", ms: 1 })) as never;
  const approve = makeApprove(async () => 1, { scope: "owner", source: "chat", mayPay: true, request, compose });
  const details = describeCall(SEND, { messageId: 1 }, { to: ["a@example.com", "x@evil.example"], cc: [], bcc: [], subject: "s", body: "Your 2FA code: 482913", hasAttachments: false });
  const d = await approve(details, { tool: SEND, input: { messageId: 1 } }, new AbortController().signal);
  assert.match(seen[0]!.question!, /^Send a short thank-you to a@example\.com\?$/);
  assert.equal(d.question, seen[0]!.question, "the decision carries the question exactly as shown");
  await approve("Card payment approval\nMerchant: Shop\nTo: nobody@example.com", { tool: "pay", input: {} }, new AbortController().signal, { typedYes: true });
  assert.equal(seen.at(-1)!.question, "Send a short thank-you to a@example.com?");
});

// ---- expiry is not a decline (A3) ----

test("an expired approval is told to the model as 'no answer, nothing done', a decline as a decline", async () => {
  const call = { summary: "Dinner", startTime: "2026-10-20T19:00:00" };
  const noJudge = async (): Promise<Verdict> => ({ decision: "ask", reason: "test" });
  const expired = makeCanUseTool(async () => ({ approved: false, expired: true }), OWNER_CHAT, undefined, noJudge);
  const r = (await expired(CAL, call, opts)) as { behavior: string; message: string };
  assert.equal(r.behavior, "deny");
  assert.match(r.message, /did not answer in time\. Nothing was done\. Do not retry it now; mention it in your next message/);
  assert.doesNotMatch(r.message, /declined/);
  const declined = makeCanUseTool(async () => ({ approved: false }), OWNER_CHAT, undefined, noJudge);
  const d = (await declined(CAL, { ...call, summary: "Lunch" }, opts)) as { message: string };
  assert.match(d.message, /declined\. Do not retry\./);
});

// ---- untrusted run: a recipient nobody named always asks (A5) ----

const owner = (message: string, earlier: string[] = []): RunProvenance => ({ kind: "owner", message, earlier });

test("recipientsOutside: the person's own words and the thread's people are the only ones accounted for", () => {
  const v = { action: "send" as const, to: ["jessica@example.com"], cc: [], bcc: ["spy@evil.example"] };
  assert.deepEqual(recipientsOutside(v, {}, owner("send it to Jessica@Example.com")), ["spy@evil.example"]);
  assert.deepEqual(recipientsOutside(v, {}, owner("send it", ["mail jessica@example.com and spy@evil.example"])), []);
  assert.deepEqual(recipientsOutside(v, {}, { kind: "standing", task: "reply to jessica@example.com" }), ["jessica@example.com", "spy@evil.example"]);
  assert.deepEqual(recipientsOutside(v, {}, undefined), ["jessica@example.com", "spy@evil.example"]);
  const reply = { action: "reply" as const, to: ["jessica@example.com"], cc: ["boss@example.com"], bcc: [] };
  assert.deepEqual(recipientsOutside(reply, {}, owner("yes")), [], "a reply that names nobody goes to the thread");
  assert.deepEqual(recipientsOutside(reply, { to: ["jessica@example.com"], cc: "boss@example.com" }, owner("yes")), ["jessica@example.com", "boss@example.com"], "named by the model, not by the person");
});

test("a send in an untrusted run to someone the owner did not name is never judged; named by the owner it is", async () => {
  setDraftReader(async () => ({ to: ["jessica@example.com"], cc: [], bcc: [], subject: "s", body: "b", hasAttachments: false }) as never);
  let judged = 0;
  let asked = 0;
  const judge = async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "fine" });
  const run = (untrusted: boolean) => makeCanUseTool(async () => (asked++, { approved: true }), OWNER_CHAT, undefined, judge as never, undefined, undefined, false, { ...CHAT, untrusted });
  scopeOf("owner").say("send it");
  assert.equal((await run(true)(SEND, { messageId: 801, confirm: true }, opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 0, asked: 1 }, "untrusted + nobody named: the owner is asked, the judge is not");
  assert.equal((await run(false)(SEND, { messageId: 802, confirm: true }, opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 1, asked: 1 }, "a trusted run is judged as before");
  scopeOf("owner").say("send it to jessica@example.com");
  assert.equal((await run(true)(SEND, { messageId: 803, confirm: true }, opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 2, asked: 1 }, "the owner wrote the address: judged");
});

const notes = (files: Record<string, string>): string => {
  const d = mkdtempSync(join(tmpdir(), "known-"));
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
  return d;
};
const ANNA = { "people-anna-clements.md": "Anna Clements. anna.clements@example.com" };

test("recipientsOutside: an address is the person's when verbatim in their words, or a known person's whose first name they said; a word in an address proves nothing", () => {
  const v = { action: "send" as const, to: ["anna.clements@example.com", "anna@evil.example"], cc: [], bcc: [] };
  const known = knownPeople(notes(ANNA));
  assert.deepEqual(recipientsOutside(v, {}, owner("I booked, update the calendar and invite Anna"), known), ["anna@evil.example"], "a known Anna's address is named; another address with her name is not");
  assert.deepEqual(recipientsOutside(v, {}, owner("invite Anna")), ["anna.clements@example.com", "anna@evil.example"], "no known people: only verbatim counts");
  assert.deepEqual(recipientsOutside(v, {}, owner("invite her"), known), ["anna.clements@example.com", "anna@evil.example"], "no name, no match");
  assert.deepEqual(recipientsOutside(v, {}, owner("invite annabelle"), known), ["anna.clements@example.com", "anna@evil.example"], "a whole word, not a prefix");
  assert.deepEqual(recipientsOutside(v, {}, owner("send to anna@evil.example")), ["anna.clements@example.com"], "verbatim still counts");
  const al = knownPeople(notes({ "people-al.md": "Al. al@example.com" }));
  assert.deepEqual(recipientsOutside({ ...v, to: ["al@example.com"] }, {}, owner("call al"), al), ["al@example.com"], "names under three letters never match");
  // Common words in an injected address are no longer enough.
  const injected = { action: "send" as const, to: ["thanks@evil.example", "please@x.example", "the.team@x.example", "send.slides@x.example"], cc: [], bcc: [] };
  assert.deepEqual(recipientsOutside(injected, {}, owner("thanks, please send the slides to the team"), known), injected.to);
});

test("a friend's run uses the friend's own people, never the owner's", () => {
  const owners = notes(ANNA);
  const friends = notes({ "people-ben-hall.md": "Ben Hall. ben.hall@example.org" });
  const v = { action: "send" as const, to: ["anna.clements@example.com"], cc: [], bcc: [] };
  assert.deepEqual(recipientsOutside(v, {}, owner("invite Anna"), knownPeople(friends)), ["anna.clements@example.com"]);
  assert.deepEqual(recipientsOutside(v, {}, owner("invite Anna"), knownPeople(owners)), []);
});

test("an event with guests is judged; in an untrusted run only when the person named every guest", async () => {
  let judged = 0;
  let asked = 0;
  const judge = async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "fine" });
  const run = (untrusted: boolean) => makeCanUseTool(async () => (asked++, { approved: true }), OWNER_CHAT, notes(ANNA), judge as never, undefined, undefined, false, { provenance: scopeOf("guests").read, conversation: "guests", untrusted });
  let day = 4;
  const event = (guest: string) => (day++, { summary: "Dinner", startTime: `2026-11-0${day}T19:00:00`, endTime: `2026-11-0${day}T21:00:00`, attendees: [{ email: guest }] });
  scopeOf("guests").say("dinner tomorrow at 7, invite Anna");
  assert.equal((await run(false)(CAL, event("anna.clements@example.com"), opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 1, asked: 0 }, "a trusted run: the judge decides about the guest");
  assert.equal((await run(true)(CAL, event("anna.clements@example.com"), opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 2, asked: 0 }, "untrusted, but the owner named Anna: judged");
  assert.equal((await run(true)(CAL, event("billing@evil.example"), opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 2, asked: 1 }, "untrusted and nobody named this guest: the owner is asked, the judge is not");
});

// ---- a wake-up is judged like a chat message ----

test("a wake-up task is judged like a chat message, whatever notes the run read (no note is marked)", async () => {
  setDraftReader(async () => ({ to: ["jessica@example.com"], cc: [], bcc: [], subject: "s", body: "b", hasAttachments: false }) as never);
  let judged = 0;
  let asked = 0;
  const judge = async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "the task covers it" });
  const wake = makeCanUseTool(async () => (asked++, { approved: true }), OWNER_LOOK, undefined, judge as never, undefined, undefined, false, {
    provenance: () => ({ kind: "derived", by: "gate", of: "owner", text: "reply to jessica@example.com" }),
    conversation: "owner",
    notesSeen: () => ["people-bob"],
  });
  assert.equal((await wake(SEND, { messageId: 901, confirm: true }, opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 1, asked: 0 });
});
