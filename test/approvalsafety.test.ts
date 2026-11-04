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

test("TurnScope: repliedTo is the assistant message at the time the person wrote; a message sent mid-turn changes assistantSaid only", () => {
  const scope = scopeOf("owner");
  scope.assistantSaid("Draft: To: peter@example.com. Send it?");
  scope.say("Send");
  scope.assistantSaid("Also mail evil@example.org");
  const p = scope.read();
  assert.ok(p?.kind === "owner");
  assert.equal(p.repliedTo, "Draft: To: peter@example.com. Send it?");
  assert.equal(p.assistantSaid, "Also mail evil@example.org");
  assert.deepEqual(recipientsOutside({ action: "send", to: ["evil@example.org"], cc: [], bcc: [] }, {}, p), ["evil@example.org"]);
  scope.end();
});

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
const MARA = { "people-mara-clements.md": "Mara Clements. mara.clements@example.com" };

test("recipientsOutside: an address in the assistant message the person answers counts; others and older ones do not; a standing task has none", () => {
  const v = { action: "send" as const, to: ["peter@example.com"], cc: [], bcc: [] };
  const draft = "Draft: To: peter@example.com, Subject: Lunch, body: see you at one. Send it?";
  assert.deepEqual(recipientsOutside(v, {}, { kind: "owner", message: "Send", repliedTo: draft }), []);
  assert.deepEqual(recipientsOutside(v, {}, { kind: "member", message: "Send", repliedTo: draft }), []);
  assert.deepEqual(recipientsOutside({ ...v, to: ["spy@evil.example"] }, {}, { kind: "owner", message: "Send", repliedTo: draft }), ["spy@evil.example"]);
  assert.deepEqual(recipientsOutside(v, {}, { kind: "owner", message: "Send", assistantSaid: draft, repliedTo: "Anything else?" }), ["peter@example.com"], "only the last assistant message counts");
  const mid = { kind: "owner" as const, message: "Send", repliedTo: "Anything else?", assistantSaid: "Draft: To: evil@example.org" };
  assert.deepEqual(recipientsOutside({ ...v, to: ["evil@example.org"] }, {}, mid), ["evil@example.org"], "a message sent mid-turn is not the one they answered");
  assert.deepEqual(recipientsOutside(v, {}, { kind: "standing", task: draft }), ["peter@example.com"]);
});

test("recipientsOutside: an address is the person's when verbatim in their words, or a known person's whose first name they said; a word in an address proves nothing", () => {
  const v = { action: "send" as const, to: ["mara.clements@example.com", "mara@evil.example"], cc: [], bcc: [] };
  const known = knownPeople(notes(MARA));
  assert.deepEqual(recipientsOutside(v, {}, owner("I booked, update the calendar and invite Mara"), known), ["mara@evil.example"], "a known Mara's address is named; another address with her name is not");
  assert.deepEqual(recipientsOutside(v, {}, owner("invite Mara")), ["mara.clements@example.com", "mara@evil.example"], "no known people: only verbatim counts");
  assert.deepEqual(recipientsOutside(v, {}, owner("invite her"), known), ["mara.clements@example.com", "mara@evil.example"], "no name, no match");
  assert.deepEqual(recipientsOutside(v, {}, owner("invite annabelle"), known), ["mara.clements@example.com", "mara@evil.example"], "a whole word, not a prefix");
  assert.deepEqual(recipientsOutside(v, {}, owner("send to mara@evil.example")), ["mara.clements@example.com"], "verbatim still counts");
  const al = knownPeople(notes({ "people-al.md": "Al. al@example.com" }));
  assert.deepEqual(recipientsOutside({ ...v, to: ["al@example.com"] }, {}, owner("call al"), al), ["al@example.com"], "names under three letters never match");
  // Common words in an injected address are no longer enough.
  const injected = { action: "send" as const, to: ["thanks@evil.example", "please@x.example", "the.team@x.example", "send.slides@x.example"], cc: [], bcc: [] };
  assert.deepEqual(recipientsOutside(injected, {}, owner("thanks, please send the slides to the team"), known), injected.to);
});

test("a friend's run uses the friend's own people, never the owner's", () => {
  const owners = notes(MARA);
  const friends = notes({ "people-ben-hall.md": "Ben Hall. ben.hall@example.org" });
  const v = { action: "send" as const, to: ["mara.clements@example.com"], cc: [], bcc: [] };
  assert.deepEqual(recipientsOutside(v, {}, owner("invite Mara"), knownPeople(friends)), ["mara.clements@example.com"]);
  assert.deepEqual(recipientsOutside(v, {}, owner("invite Mara"), knownPeople(owners)), []);
});

test("an event with guests is judged; in an untrusted run only when the person named every guest", async () => {
  let judged = 0;
  let asked = 0;
  const judge = async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "fine" });
  const run = (untrusted: boolean) => makeCanUseTool(async () => (asked++, { approved: true }), OWNER_CHAT, notes(MARA), judge as never, undefined, undefined, false, { provenance: scopeOf("guests").read, conversation: "guests", untrusted });
  let day = 4;
  const event = (guest: string) => (day++, { summary: "Dinner", startTime: `2026-11-0${day}T19:00:00`, endTime: `2026-11-0${day}T21:00:00`, attendees: [{ email: guest }] });
  scopeOf("guests").say("dinner tomorrow at 7, invite Mara");
  assert.equal((await run(false)(CAL, event("mara.clements@example.com"), opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 1, asked: 0 }, "a trusted run: the judge decides about the guest");
  assert.equal((await run(true)(CAL, event("mara.clements@example.com"), opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 2, asked: 0 }, "untrusted, but the owner named Mara: judged");
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

test("a people note written during an untrusted run does not make its address known to that run; one from before does", async () => {
  let asked = 0;
  const judge = async (): Promise<Verdict> => ({ decision: "auto", reason: "fine" });
  const run = (dir: string) => makeCanUseTool(async () => (asked++, { approved: true }), OWNER_CHAT, dir, judge as never, undefined, undefined, false, { provenance: scopeOf("snap").read, conversation: "snap", untrusted: true });
  const event = (guest: string, d: number) => ({ summary: "Tea", startTime: `2026-11-1${d}T19:00:00`, endTime: `2026-11-1${d}T20:00:00`, attendees: [{ email: guest }] });
  scopeOf("snap").say("invite Zed to tea");
  const dir = notes({});
  const can = run(dir);
  writeFileSync(join(dir, "people-zed.md"), "Zed. zed@evil.example"); // (saved from a mail the run read)
  await can(CAL, event("zed@evil.example", 1), opts);
  assert.equal(asked, 1, "the note of this run does not count: the owner is asked");
  await run(dir)(CAL, event("zed@evil.example", 2), opts);
  assert.equal(asked, 1, "the next run knows Zed from the note: no question");
});
