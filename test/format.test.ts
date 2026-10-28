import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCall } from "../src/approvals/format.ts";

test("approval text: a long email body is shown generously and the cut is announced", () => {
  const body = "Hello. ".repeat(600); // 4200 chars
  const text = describeCall("mcp__mailbird__send_message_now", { to: "x@example.com", subject: "Hi", body });
  assert.match(text, /^✉️ Send email now/);
  assert.match(text, /more characters not shown\)/);
  assert.ok(text.length > 3000);
});

test("approval text: nothing is cut silently", () => {
  const text = describeCall("mcp__x__do", { note: "y".repeat(500) });
  assert.match(text, /\(\+300 more characters not shown\)/);
});

test("approval text: people shown as addresses, any other object shown in full", () => {
  const text = describeCall("mcp__claude_ai_Google_Calendar__create_event", {
    summary: "Sync",
    startTime: "2026-10-14T15:00:00",
    endTime: "2026-10-14T16:00:00",
    attendees: [{ email: "a@example.com", responseStatus: "needsAction" }],
    extra: { email: "b@example.com", webhook: "https://example.com/hook" },
  });
  assert.match(text, /With: a@example\.com/);
  assert.match(text, /webhook/); // not hidden behind its email field
  assert.match(text, /🕒 Wed 14 Oct, 15:00–16:00/);
});

test("approval text: text-direction controls are stripped, so what shows is what runs", () => {
  const text = describeCall("mcp__mailbird__send_message_now", { to: "x@example.com", body: "archive ‮ecnab‬ mail" });
  assert.doesNotMatch(text, /[‪-‮⁦-⁩]/);
  assert.match(text, /archive ecnab mail/);
});

test("approval text: characters with no width are shown as code points, so two look-alike addresses differ on screen", () => {
  const plain = describeCall("mcp__mailbird__send_message_now", { to: "anna@example.com", subject: "Hi" });
  const sneaky = describeCall("mcp__mailbird__send_message_now", { to: "anna​@example.com", subject: "H﻿i" });
  assert.notEqual(plain, sneaky);
  assert.match(sneaky, /To: anna⟨U\+200B⟩@example\.com/);
  assert.match(sneaky, /Subject: H⟨U\+FEFF⟩i/);
  // a recipient given as an object is cleaned too, and emoji joiners and plain text are untouched
  assert.match(describeCall("mcp__x__do", { attendees: [{ email: "a⁠b@example.com" }] }), /With: a⟨U\+2060⟩b@example\.com/);
  assert.match(describeCall("mcp__x__do", { note: "👨‍👩‍👧 and \u0007bell" }), /note: 👨‍👩‍👧 and bell/);
});

test("approval text: opening a web page shows the exact address", () => {
  const text = describeCall("WebFetch", { url: "https://calendly.com/someone/intro?utm=a", prompt: "free slots on Tuesday" });
  assert.match(text, /^🌐 Open a web page/);
  assert.match(text, /Address: https:\/\/calendly\.com\/someone\/intro\?utm=a/);
});

test("approval text: a send looks the same for every provider and always shows bcc, attachments and an empty recipient list", () => {
  const mailbird = describeCall("mcp__mailbird__send_message_now", { messageId: 1 }, { to: ["a@example.com"], cc: ["c@example.com"], bcc: ["b@example.com"], subject: "Hi", body: "Text", hasAttachments: true, attachments: ["tax.pdf", "mailbird://mcp/messages/1/attachments/2"] });
  assert.equal(mailbird, "✉️ Send email now\nTo: a@example.com\nCc: c@example.com\nBcc: b@example.com\nSubject: Hi\nAttachments: tax.pdf, mailbird://mcp/messages/1/attachments/2\n\nText");
  assert.match(describeCall("mcp__mailbird__send_message_now", { messageId: 1 }, { to: ["a@example.com"], cc: [], bcc: [], subject: "Hi", body: "Text", hasAttachments: true }), /Attachments: yes \(the mail client gave no names\)/); // a read-back that names none still says there are some
  assert.match(describeCall("mcp__mailbird__forward_conversation", { conversationId: "g", body: "FYI" }), /^✉️ Forward email\nTo: \(nobody yet\)/);
  assert.match(describeCall("mcp__mailbird__create_draft", { accountId: 1, to: [{ email: "a@example.com" }], bcc: [{ email: "b@example.com" }], subject: "S", body: "B" }), /^✉️ Save email draft\nTo: a@example\.com\nBcc: b@example\.com\nSubject: S/);
});
