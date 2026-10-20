import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The pieces of a friend's mail check that are pure or small: the parsers of her Google server's text results, the triage call made for her (her name, her notes, the
// instance key, her cost file), and that the owner's triage prompt is the one it always was.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "google-mail-"));
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token";

const { parseSearch, parseMessage, senderOf, GoogleMail } = await import("../src/googlemail.ts");
const { triageBatch, triageSystem } = await import("../src/triage.ts");
const { settings } = await import("../src/settings.ts");
const { spentToday } = await import("../src/budget.ts");

const SEARCH = `Found 2 messages matching 'in:inbox newer_than:2d':

📧 MESSAGES:
  1. Message ID: 18f0a1
     Subject: Lunch on Thursday?
     From: Carl Example <Carl@Example.org>
     Date: Tue, 20 Oct 2026 08:00:00 +0000
     Web Link: https://mail.google.com/mail/u/0/#all/18f0a1
     Thread ID: 18f0a0
     Thread Link: https://mail.google.com/mail/u/0/#all/18f0a0

  2. Message ID: 18f0a2
     Subject: Re: invoice
     From: anna@example.com
     Date: Tue, 20 Oct 2026 09:30:00 +0000
     Web Link: x
     Thread ID: 18f0a2

💡 USAGE:
  • Pass the Message IDs **as a list** to get_gmail_messages_content_batch()`;

test("google mail: the search result becomes one row per message; her own address is 'me'; nothing is invented from a shape that does not parse", () => {
  const rows = parseSearch(SEARCH, "anna@example.com");
  assert.deepEqual(rows.map((r) => [r.conversationId, r.lastMessageId, r.subject, r.lastSender]), [
    ["18f0a1", "18f0a1", "Lunch on Thursday?", "Carl Example"],
    ["18f0a2", "18f0a2", "Re: invoice", "me"],
  ]);
  assert.equal(rows[0]!.receivedAtUtc, "2026-10-20T08:00:00.000Z");
  assert.deepEqual(parseSearch("No messages found for query: 'x'", undefined), []);
  assert.deepEqual(parseSearch("something else entirely", undefined), []);
  assert.deepEqual(parseSearch("  1. Message ID: unknown\n     Subject: x", undefined), []);
});

test("google mail: a message's headers and body, the attachment list left out", () => {
  const m = parseMessage(["Subject: Lunch", "From: \"Carl, E.\" <Carl@Example.org>", "Date: x", "To: anna@example.com", "Cc: [not present in Gmail response]", "", "--- BODY ---", "Are you free?", "", "--- ATTACHMENTS ---", "1. plan.pdf (application/pdf, 12.0 KB)"].join("\n"));
  assert.equal(m.body.trim(), "Are you free?");
  assert.deepEqual(m.from, { displayName: "Carl, E.", email: "carl@example.org" });
  assert.deepEqual(parseMessage("garbage").from, { displayName: "", email: "" });
  assert.deepEqual(senderOf("a@b.c"), { name: "", email: "a@b.c" });
});

test("google mail: only a search, a read and the INBOX label exist; archive removes INBOX; a failing tool is a plain error", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let fail = false;
  const session = {
    account: async () => "anna@example.com",
    call: async (tool: string, args: Record<string, unknown>) => (calls.push({ tool, args }), { text: fail ? "server words that quote a mail" : SEARCH, isError: fail, content: [] }),
  };
  const mb = new GoogleMail(session, { query: () => "in:inbox newer_than:2d" });
  assert.deepEqual((await mb.inboxes())[0], { accountId: 0, email: "anna@example.com", senderName: "me", folderId: 0 });
  assert.equal((await mb.call<unknown[]>("list_conversations", { folderId: 0, limit: 100 })).length, 2);
  assert.deepEqual(calls[0], { tool: "search_gmail_messages", args: { query: "in:inbox newer_than:2d", page_size: 50, include_headers: true } });
  await mb.call("archive_conversation", { conversationId: "18f0a1" });
  assert.deepEqual(calls[1], { tool: "modify_gmail_message_labels", args: { message_id: "18f0a1", remove_label_ids: ["INBOX"] } });
  await mb.call("move_conversation_to_inbox", { conversationId: "18f0a1" });
  assert.deepEqual(calls[2]!.args, { message_id: "18f0a1", add_label_ids: ["INBOX"] });
  await assert.rejects(mb.call("send_message", {}), /not supported/);
  await assert.rejects(mb.call("trash_conversation", { conversationId: "x" }), /not supported/);
  fail = true;
  await assert.rejects(mb.call("get_message", { messageId: "1" }), (e: Error) => e.message === "google get_gmail_message_content failed" && !/quote/.test(e.message));
});

function stream(seen: { options?: Record<string, any> }) {
  return (({ options }: { options: Record<string, any> }) => {
    seen.options = options;
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.003, structured_output: { items: [{ index: 1, label: "read_later", kind: "personal_or_work", reason: "ok" }] } };
    })();
  }) as never;
}
const mail = { account: "anna@example.com", fromName: "Carl", fromEmail: "carl@example.org", subject: "Lunch?", receivedAtUtc: "2026-10-20", body: "Free Thursday?" };

test("triage for a friend: her name and notes in the prompt, the instance key in the call's environment (never the owner's login), her cost file; the owner's call is as it was", async () => {
  const notes = join(process.env.HARNESS_DATA_DIR!, "annanotes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "people-eve.md"), "Eve is Anna's sister; her mail is never urgent.\n");
  const costFile = join(process.env.HARNESS_DATA_DIR!, "anna-cost.json");
  const seen: { options?: Record<string, any> } = {};
  const r = await triageBatch([mail], stream(seen), { who: { name: "Anna" }, notesDir: notes, payer: { kind: "instance", id: "anna", apiKey: "instance-key-not-real", costFile } });
  assert.equal(r[0]!.label, "read_later");
  const system = String(seen.options!.systemPrompt);
  assert.match(system, /You triage incoming emails for Anna/);
  assert.match(system, /Eve is Anna's sister/);
  assert.doesNotMatch(system, new RegExp(`emails for ${settings.owner},`));
  assert.equal(seen.options!.env.ANTHROPIC_API_KEY, "instance-key-not-real");
  assert.equal(seen.options!.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(JSON.parse(readFileSync(costFile, "utf8")).usd, 0.003, "her ledger");
  assert.equal(spentToday(), 0, "not the owner's");
  // the owner's: unchanged
  const own: { options?: Record<string, any> } = {};
  await triageBatch([mail], stream(own));
  assert.equal(String(own.options!.systemPrompt), triageSystem(""));
  assert.match(String(own.options!.systemPrompt), new RegExp(`You triage incoming emails for ${settings.owner}`));
  assert.equal(own.options!.env, undefined);
  assert.equal(spentToday(), 0.003, "the owner's call is billed to the owner");
});
