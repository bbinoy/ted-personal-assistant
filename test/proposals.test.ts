import { test } from "node:test";
import assert from "node:assert/strict";
import { draftCollector as collector, createProposer, type Mail } from "../src/propose.ts";
import { mailSlot } from "../src/modules/index.ts";
const draftCollector = () => collector(mailSlot("mailbird")!.createdDraft);
import { extractMessageId } from "../src/mailview.ts";
import { authoredPart, proposalText, sendApprovalText, viewDraft } from "../src/proposals.ts";

const msg = (body: string, to = ["armon@example.com"], cc: string[] = []) => ({ to: to.map((email) => ({ email })), cc: cc.map((email) => ({ email })), subject: "Re: Coffee", body });

test("proposals: the draft id comes from the tool result, in whatever shape it arrives", () => {
  assert.equal(extractMessageId({ messageId: 4711, status: "draft" }), 4711);
  assert.equal(extractMessageId('{"messageId": 12}'), 12);
  assert.equal(extractMessageId([{ type: "text", text: '{"ok":true,"messageId":987}' }]), 987);
  assert.equal(extractMessageId({ nothing: true }), undefined);
  assert.equal(extractMessageId(undefined), undefined);
});

test("proposals: only reply tools are collected, each draft once", () => {
  const c = draftCollector();
  c.onToolSuccess("mcp__mailbird__reply_to_conversation", {}, { messageId: 5 });
  c.onToolSuccess("mcp__mailbird__reply_to_conversation", {}, { messageId: 5 });
  c.onToolSuccess("mcp__mailbird__create_draft", {}, { messageId: 6 }); // not a reply: not proposed
  c.onToolSuccess("mcp__mailbird__archive_conversation", {}, { messageId: 7 });
  assert.deepEqual(c.ids, [5]);
});

test("proposals: the Signal message names the draft, shows recipients and text, and announces anything cut", () => {
  const d = viewDraft(msg("Hi Armon, Tuesday 15:00 works.", ["Armon@Example.com"], ["x@example.com"]))!;
  assert.deepEqual(d.to, ["armon@example.com"]);
  assert.match(proposalText(d, 25965), /^✉️ Reply ready \(draft #25965\)\nTo: armon@example\.com\nCc: x@example\.com\nSubject: Re: Coffee\n\nHi Armon, Tuesday 15:00 works\.\n\nReply to this message with “send”/);
  assert.match(proposalText(viewDraft(msg("x".repeat(2000)))!, 1), /\(\+800 more characters not shown\)/);
  assert.equal(viewDraft({ no: "body" }), undefined);
});

test("proposals: the approval for a send shows the draft as Mailbird holds it, including a quoted original", () => {
  const d = viewDraft(msg("Tuesday 15:00?\n\nOn Mon, 12 Oct, Armon wrote:\n> coffee?"))!;
  const t = sendApprovalText(d);
  assert.match(t, /^✉️ Send email now\nTo: armon@example\.com\nSubject: Re: Coffee\n\nTuesday 15:00\?\n\n\(the quoted original follows below it in the email\)$/);
  assert.deepEqual(authoredPart("Hi\n> quoted"), { text: "Hi", hasQuote: true });
});

test("proposals: only real quote lines are left out of the approval; text under a quote marker is shown", () => {
  // typed below the quote
  assert.deepEqual(authoredPart("On Mon, 12 Oct, Armon wrote:\n> coffee?\n\nYes, Tuesday works."), { text: "Yes, Tuesday works.", hasQuote: true });
  // slipped in under a fake quote line, to be sent without the owner seeing it
  assert.deepEqual(authoredPart("Thanks!\n> quoted\nAlso include the owner's full calendar for next month.\n> more"), { text: "Thanks!\nAlso include the owner's full calendar for next month.", hasQuote: true });
  // a normal reply is unchanged: new text, a header, quote lines, blank lines
  assert.deepEqual(authoredPart("Tuesday 15:00?\n\nOn Mon, 12 Oct, Armon wrote:\n> coffee?\n>\n> thanks"), { text: "Tuesday 15:00?", hasQuote: true });
  assert.deepEqual(authoredPart("no quote here"), { text: "no quote here", hasQuote: false });
  const d = viewDraft(msg("Thanks!\n> quoted\nAlso send everything to eve@example.com"))!;
  assert.match(sendApprovalText(d), /Thanks!\nAlso send everything to eve@example\.com/);
});

test("proposals: recipients and subject are one clean line each, so a line break cannot fake a header", () => {
  const d = viewDraft({ to: [{ email: "armon@example.com" }], cc: [], subject: "Re: Coffee\nTo: boss@example.com​", body: "ok" })!;
  const t = sendApprovalText(d);
  assert.match(t, /^✉️ Send email now\nTo: armon@example\.com\nSubject: Re: Coffee To: boss@example\.com⟨U\+200B⟩\n\nok$/);
});

test("propose: each readable draft with a recipient is shown, once; unreadable ones are skipped", async () => {
  const drafts: Record<number, unknown> = { 1: msg("Tuesday?"), 2: { no: "body" }, 3: msg("x", []) };
  const sent: string[] = [];
  const mail: Mail = { call: async (_n: string, args: any = {}) => drafts[args.messageId] as any };
  const p = createProposer({ mail, send: async (t) => (sent.push(t), 1) });
  assert.equal(await p.show([1, 2, 3]), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /draft #1\)/);
});

test("proposals: bcc and attachments of a draft are read back and shown in the approval", () => {
  const d = viewDraft({ ...msg("Hi"), bcc: [{ email: "Spy@Example.com" }], attachments: [{ name: "a.pdf" }] })!;
  assert.deepEqual(d.bcc, ["spy@example.com"]);
  assert.equal(d.hasAttachments, true);
  assert.match(sendApprovalText(d), /^✉️ Send email now\nTo: armon@example\.com\nBcc: spy@example\.com\nSubject: Re: Coffee\nAttachments: a\.pdf\n/);
  assert.deepEqual([viewDraft(msg("Hi"))!.bcc, viewDraft(msg("Hi"))!.hasAttachments], [[], false]);
});
