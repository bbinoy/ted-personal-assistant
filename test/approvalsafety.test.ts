import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questionFooter } from "../src/approvals/questionfooter.ts";
import { makeApprove } from "../src/approvals/approvalask.ts";
import { createNotesServer } from "../src/modules/memory/notestools.ts";
import { recipientsOutside, type RunProvenance, type Verdict } from "../src/approvals/autojudge.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { describeCall } from "../src/approvals/format.ts";
import { setDraftReader } from "../src/modules/mailbird/module.ts";
import { scopeOf } from "../src/approvals/turnscope.ts";
import { CHAT } from "./util.ts";

const SEND = "mcp__mailbird__send_message_now";
const CAL = "mcp__claude_ai_Google_Calendar__create_event";
const opts = { signal: new AbortController().signal } as never;

// ---- the code-rendered footer on every question (A1) ----

test("questionFooter: a mail shows every recipient, the attachments and the start of the text, whatever the question says", () => {
  const details = describeCall(SEND, { messageId: 1 }, { to: ["a@example.com"], cc: ["c@example.com"], bcc: ["spy@evil.example"], subject: "Re: hi", body: `Thanks!\n${"your code is 123456 ".repeat(40)}`, hasAttachments: true, attachments: ["id.pdf"] });
  const f = questionFooter(details);
  assert.match(f, /^\n\n— exactly what will go —\nTo: a@example\.com\nCc: c@example\.com\nBcc: spy@evil\.example\nAttachments: id\.pdf\nText: “Thanks! your code is 123456/);
  assert.match(f, /… \(\+\d+ more characters not shown\)”$/); // clipped, and says so
  assert.ok(f.split("\n").length <= 8, "compact");
  assert.equal(questionFooter("✉️ Send email now\nTo: a@example.com\nSubject: s\n\nhi\n\n(the quoted original follows below it in the email)").includes("quoted original"), false);
});

test("questionFooter: an invite shows its guests; a call with nothing to show adds nothing", () => {
  assert.match(questionFooter(describeCall(CAL, { summary: "Dinner", startTime: "2026-10-20T19:00:00", attendees: [{ email: "x@example.com" }, { email: "y@example.com" }] })), /With: x@example\.com, y@example\.com/);
  assert.equal(questionFooter(describeCall(CAL, { summary: "Dinner", startTime: "2026-10-20T19:00:00" })), "");
  assert.equal(questionFooter("Open a page"), "");
});

test("makeApprove: the sent question is the model's plus the footer; a card payment keeps its own text", async () => {
  const seen: { question?: string }[] = [];
  const request = (async (_s: unknown, _d: string, _c: unknown, _a: unknown, o: { question?: string }) => (seen.push(o), { approved: true })) as never;
  const compose = (async () => ({ text: "Send a short thank-you to a@example.com?", ms: 1 })) as never;
  const approve = makeApprove(async () => 1, { scope: "owner", source: "chat", mayPay: true, request, compose });
  const details = describeCall(SEND, { messageId: 1 }, { to: ["a@example.com", "x@evil.example"], cc: [], bcc: [], subject: "s", body: "Your 2FA code: 482913", hasAttachments: false });
  const d = await approve(details, { tool: SEND, input: { messageId: 1 } }, new AbortController().signal);
  assert.match(seen[0]!.question!, /^Send a short thank-you to a@example\.com\?\n\n— exactly what will go —\nTo: a@example\.com, x@evil\.example\nText: “Your 2FA code: 482913”$/);
  assert.equal(d.question, seen[0]!.question, "the decision carries the question exactly as shown");
  await approve("Card payment approval\nMerchant: Shop\nTo: nobody@example.com", { tool: "pay", input: {} }, new AbortController().signal, { typedYes: true });
  assert.equal(seen.at(-1)!.question, "Send a short thank-you to a@example.com?");
});

// ---- expiry is not a decline (A3) ----

test("an expired approval is told to the model as 'no answer, nothing done', a decline as a decline", async () => {
  const call = { summary: "Dinner", startTime: "2026-10-20T19:00:00" };
  const noJudge = async (): Promise<Verdict> => ({ decision: "ask", reason: "test" });
  const expired = makeCanUseTool(async () => ({ approved: false, expired: true }), "chat", undefined, noJudge);
  const r = (await expired(CAL, call, opts)) as { behavior: string; message: string };
  assert.equal(r.behavior, "deny");
  assert.match(r.message, /did not answer in time\. Nothing was done\. Do not retry it now; mention it in your next message/);
  assert.doesNotMatch(r.message, /declined/);
  const declined = makeCanUseTool(async () => ({ approved: false }), "chat", undefined, noJudge);
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
  const run = (untrusted: boolean) => makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined, judge as never, undefined, undefined, false, { ...CHAT, untrusted });
  scopeOf("owner").say("send it");
  assert.equal((await run(true)(SEND, { messageId: 801, confirm: true }, opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 0, asked: 1 }, "untrusted + nobody named: the owner is asked, the judge is not");
  assert.equal((await run(false)(SEND, { messageId: 802, confirm: true }, opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 1, asked: 1 }, "a trusted run is judged as before");
  scopeOf("owner").say("send it to jessica@example.com");
  assert.equal((await run(true)(SEND, { messageId: 803, confirm: true }, opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 2, asked: 1 }, "the owner wrote the address: judged");
});

// ---- a wake-up in a run that read an inferred note is not trusted (A5) ----

test("a wake-up task is judged unless the run itself read an inferred note; then it is not done (an unattended run asks nobody)", async () => {
  setDraftReader(async () => ({ to: ["jessica@example.com"], cc: [], bcc: [], subject: "s", body: "b", hasAttachments: false }) as never);
  let judged = 0;
  let asked = 0;
  let readInferred = false; // what agentrun.ts keeps from read_note's onRead
  const judge = async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "the task covers it" });
  const wake = makeCanUseTool(async () => (asked++, { approved: true }), "background", undefined, judge as never, undefined, undefined, false, {
    provenance: () => ({ kind: "derived", by: "gate", of: "owner", text: "reply to jessica@example.com" }),
    conversation: "owner",
    inferredNoteRead: () => readInferred,
  });
  assert.equal((await wake(SEND, { messageId: 901, confirm: true }, opts))!.behavior, "allow");
  assert.deepEqual({ judged, asked }, { judged: 1, asked: 0 }, "nothing inferred was read (the folder may hold some): judged like a chat message");
  readInferred = true;
  assert.equal((await wake(SEND, { messageId: 902, confirm: true }, opts))!.behavior, "deny");
  assert.deepEqual({ judged, asked }, { judged: 1, asked: 0 }, "an inferred note was read: not judged, and skipped without a question");
});

test("read_note reports whether the note it returned was inferred", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-"));
  try {
    writeFileSync(join(dir, "people-anna.md"), "---\nname: anna\n---\nAnna likes tea\n");
    writeFileSync(join(dir, "people-bob.md"), "---\nname: bob\norigin: inferred\n---\nBob moved\n");
    const seen: { file: string; inferred?: boolean }[] = [];
    const server = createNotesServer({ dir, write: [], maxNotes: 10, onRead: (n) => seen.push(n) }, "background") as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> } };
    const read = server.instance._registeredTools.read_note!.handler;
    await read({ file: "people-anna.md" });
    await read({ file: "people-bob.md" });
    await read({ file: "people-nobody.md" });
    assert.deepEqual(seen, [{ file: "people-anna.md", inferred: undefined }, { file: "people-bob.md", inferred: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
