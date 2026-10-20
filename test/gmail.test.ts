import { test } from "node:test";
import assert from "node:assert/strict";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { readAudit } from "../src/audit.ts";
import { briefInstructions, briefDelivery, runBriefAttempt } from "../src/brief.ts";
import { requiredSkills } from "../src/doctor.ts";
import { buildDigest } from "../src/digest.ts";
import { GmailMail, gmailReaders, parseDraft, parseMessage, parseOriginal, parseThreads, payload, relayAllowed, type Call, type Relay } from "../src/gmail.ts";
import { isInboxArchive, isSelfSend } from "../src/gmailrules.ts";
import { startHeartbeat, type MailSource } from "../src/heartbeat.ts";
import { setGmailReaders } from "../src/modules/gmail.ts";
import { gmailChecks } from "../src/modules/runtime.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { classify, hiddenTools } from "../src/policy/policy.ts";
import { ownerSkills } from "../src/skills.ts";
import { loadSettings, settings } from "../src/settings.ts";
import { readJson, writeJson } from "../src/state.ts";
import { cleanToolOutput } from "../src/toolclean.ts";
import { addrs, mailView } from "../src/policy/toolmanifest.ts";

// MAIL_PROVIDER=gmail. Everything here runs on fake connector output (the shapes follow the connector's published tool descriptions);
// none of it has met the live connector.

const GM = "mcp__claude_ai_Gmail__";
const SELF = "owner@example.com";
const opts = { signal: new AbortController().signal } as never;
const noJudge = async (): Promise<Verdict> => ({ decision: "ask", reason: "test" });

async function withGmail<T>(over: Record<string, unknown>, f: () => Promise<T> | T): Promise<T> {
  const s = settings as unknown as Record<string, unknown>;
  const keys = ["mail", "mailProvider", "mailSelfAddress", "archiveLive", "briefEmail", "quietStartHour", "quietEndHour"];
  const was = Object.fromEntries(keys.map((k) => [k, s[k]]));
  Object.assign(s, { mail: true, mailProvider: "gmail", mailSelfAddress: SELF, archiveLive: false, briefEmail: false, quietStartHour: 0, quietEndHour: 0 }, over);
  try {
    return await f();
  } finally {
    Object.assign(s, was);
  }
}

// ---- settings ----

test("settings: gmail is accepted; archiving follows the one ARCHIVE switch and the email brief is off by default; the Gmail connector stays visible, Mailbird hidden", () => {
  const g = loadSettings({ MAIL_PROVIDER: "gmail", MAIL_SELF_ADDRESS: " Owner@Example.com " });
  assert.equal(g.mailProvider, "gmail");
  assert.equal(g.mail, true);
  assert.equal(g.mailSelfAddress, SELF);
  assert.equal(g.archiveLive, true);
  assert.equal(g.briefEmail, false);
  assert.ok(!hiddenTools([], g).includes("mcp__claude_ai_Gmail"));
  assert.ok(hiddenTools([], g).includes("mcp__mailbird"));
  assert.equal(loadSettings({ MAIL_PROVIDER: "gmail", ARCHIVE: "log", BRIEF_EMAIL: "on" }).archiveLive, false);
  assert.throws(() => loadSettings({ MAIL_SELF_ADDRESS: "Owner <o@example.com>" }), /MAIL_SELF_ADDRESS must be a plain email address/);
  // Mailbird is untouched
  const mb = loadSettings({});
  assert.ok(hiddenTools([], mb).includes("mcp__claude_ai_Gmail"));
  assert.ok(!hiddenTools([], mb).includes("mcp__mailbird"));
});

test("the model sees only the Gmail tools the skills need: the rest of the connector is hidden by name", () => {
  const seen = [`${GM}search_threads`, `${GM}trash_thread`, `${GM}delete_label`, `${GM}reply`, `${GM}get_attachment`];
  const hidden = hiddenTools(seen, settings);
  assert.ok(hidden.includes(`${GM}trash_thread`) && hidden.includes(`${GM}delete_label`) && hidden.includes(`${GM}get_attachment`));
  assert.ok(!hidden.includes(`${GM}search_threads`) && !hidden.includes(`${GM}reply`));
});

// ---- the rules code adds to the manifest ----

test("policy: trash, spam, deletion and attachment content are denied however they are asked; label values TRASH and SPAM too", async () => {
  await withGmail({ archiveLive: true }, () => {
    for (const t of ["trash_thread", "trash_message", "untrash_thread", "mark_thread_spam", "mark_message_spam", "unmark_message_spam", "delete_label", "update_label", "apply_sensitive_message_label", "apply_sensitive_thread_label", "get_attachment", "download_attachment"]) {
      assert.equal(classify(GM + t, { threadId: "t1", messageId: "m1" }, "chat"), "deny", t);
    }
    // the label-value rule, on every label tool and field
    assert.equal(classify(`${GM}label_thread`, { threadId: "t", labelIds: ["TRASH"] }, "chat"), "deny");
    assert.equal(classify(`${GM}label_thread`, { threadId: "t", labelIds: ["INBOX", "spam"] }, "chat"), "deny");
    assert.equal(classify(`${GM}label_message`, { messageId: "m", labelIds: [" Trash "] }, "chat"), "deny");
    assert.equal(classify(`${GM}update_message_labels`, { messageId: "m", addLabelIds: ["SPAM"] }, "chat"), "deny");
    assert.equal(classify(`${GM}update_message_labels`, { messageId: "m", removeLabelIds: ["TRASH"] }, "chat"), "deny");
    assert.equal(classify(`${GM}unlabel_thread`, { threadId: "t", labelIds: ["TRASH"] }, "brief"), "deny");
    assert.equal(classify(`${GM}unlabel_thread`, { threadId: "t", labelIds: ["INBOX", "SPAM"] }, "brief"), "deny");
    // raw MIME carries attachment content
    assert.equal(classify(`${GM}get_thread`, { threadId: "t", messageFormat: "RAW" }, "chat"), "deny");
    assert.equal(classify(`${GM}get_message`, { messageId: "m", messageFormat: "PLAIN_TEXT" }, "chat"), "allow");
    // other label changes ask; an unknown connector tool asks
    assert.equal(classify(`${GM}label_thread`, { threadId: "t", labelIds: ["INBOX"] }, "chat"), "ask");
    assert.equal(classify(`${GM}create_label`, { name: "x" }, "chat"), "ask");
    assert.equal(classify(`${GM}some_new_tool`, {}, "chat"), "ask");
    // groups never reach it
    assert.equal(classify(`${GM}search_threads`, {}, "group"), "deny");
  });
});

test("policy: archiving is exactly 'remove INBOX from a thread'; log-only denies it, live sends it to the judge in every place", async () => {
  const call = { threadId: "t1", labelIds: ["INBOX"] };
  assert.ok(isInboxArchive(`${GM}unlabel_thread`, call));
  assert.ok(!isInboxArchive(`${GM}unlabel_thread`, { threadId: "t1", labelIds: ["INBOX", "UNREAD"] }));
  assert.ok(!isInboxArchive(`${GM}unlabel_thread`, { labelIds: ["INBOX"] }));
  await withGmail({ archiveLive: false }, () => assert.equal(classify(`${GM}unlabel_thread`, call, "chat"), "deny"));
  await withGmail({ archiveLive: true }, () => {
    for (const source of ["chat", "brief", "handler"] as const) assert.equal(classify(`${GM}unlabel_thread`, call, source), "ask", source); // judged, the same everywhere
    assert.equal(classify(`${GM}unlabel_thread`, { threadId: "t1", labelIds: ["UNREAD"] }, "chat"), "ask");
  });
});

test("log-only archive: a model's archive call is refused politely and recorded as would-archive", async () => {
  await withGmail({ archiveLive: false }, async () => {
    const canUse = makeCanUseTool(async () => assert.fail("never asks"), "chat", undefined, noJudge);
    const r = await canUse(`${GM}unlabel_thread`, { threadId: "thread-log-only", labelIds: ["INBOX"] }, opts);
    assert.equal(r!.behavior, "deny");
    assert.match((r as { message: string }).message, /log-only/);
    assert.ok(readAudit((e) => e.tool === "gmail_archive" && e.decision === "would-archive" && e.meta?.id === "thread-log-only").length >= 1);
  });
});

test("the brief may email only the owner's own address; anything else about that send asks", async () => {
  const send = (extra: Record<string, unknown>) => ({ to: [SELF], subject: "☀️ Brief", body: "hello", ...extra });
  assert.ok(isSelfSend(`${GM}send_message`, send({}), SELF));
  assert.ok(isSelfSend(`${GM}send_message`, send({ to: [" OWNER@example.com "] }), SELF));
  for (const bad of [{ to: ["other@example.com"] }, { to: [SELF, "other@example.com"] }, { to: [`Owner <${SELF}>`] }, { to: [`${SELF},other@example.com`] }, { cc: ["x@example.com"] }, { bcc: ["x@example.com"] }, { attachments: [{ content: "AA==" }] }, { draftId: "d1" }, { replyThreadId: "t" }, { replyToMessageId: "m" }, { to: [] }, { to: undefined }]) {
    assert.ok(!isSelfSend(`${GM}send_message`, send(bad), SELF), JSON.stringify(bad));
  }
  assert.ok(!isSelfSend(`${GM}send_message`, send({}), undefined), "no configured address: never");
  assert.ok(!isSelfSend(`${GM}reply`, send({}), SELF));
  await withGmail({ briefEmail: true }, () => {
    assert.equal(classify(`${GM}send_message`, send({}), "brief"), "allow");
    assert.equal(classify(`${GM}send_message`, send({ to: ["other@example.com"] }), "brief"), "ask");
    assert.equal(classify(`${GM}send_message`, send({ bcc: ["other@example.com"] }), "brief"), "ask");
    assert.equal(classify(`${GM}send_message`, send({}), "radar"), "ask", "only the brief run");
    assert.equal(classify(`${GM}send_message`, send({}), "chat"), "ask", "chat still goes through approval");
    assert.equal(classify(`${GM}reply`, { messageId: "m", body: "x" }, "brief"), "ask");
  });
  await withGmail({ briefEmail: false }, () => assert.equal(classify(`${GM}send_message`, send({}), "brief"), "ask", "BRIEF_EMAIL=off: no free send at all"));
});

// ---- approvals: the real recipients ----

test("a Gmail send of a draft is approved against the draft as read back; unreadable means no send", async () => {
  await withGmail({}, async () => {
    setGmailReaders({ draft: async () => ({ to: ["real@example.com"], cc: ["cc@example.com"], bcc: ["hidden@example.com"], subject: "Terms", body: "see attached", hasAttachments: true }), original: async () => undefined });
    const shown: string[] = [];
    const canUse = makeCanUseTool(async (d) => (shown.push(d), { approved: true }), "chat", undefined, noJudge);
    const r = await canUse(`${GM}send_message`, { draftId: "draft-1" }, opts);
    assert.equal(r!.behavior, "allow");
    assert.match(shown[0]!, /real@example\.com/);
    assert.match(shown[0]!, /hidden@example\.com/, "bcc is shown");
    // a draft that cannot be read back is not sent
    setGmailReaders({ draft: async () => { throw new Error("connector down"); }, original: async () => undefined });
    const again = await makeCanUseTool(async () => assert.fail("not asked"), "chat", undefined, noJudge)(`${GM}send_message`, { draftId: "draft-2" }, opts);
    assert.equal(again!.behavior, "deny");
    assert.match((again as { message: string }).message, /could not be read back/);
    setGmailReaders(undefined);
  });
});

test("a Gmail reply that names no recipients is shown with the people of the original; reply-all adds the others; no original, no reply", async () => {
  await withGmail({}, async () => {
    setGmailReaders({
      draft: async () => undefined,
      original: async () => ({ to: ["dana@example.com", "third@example.com"], cc: ["boss@example.com"], bcc: [], subject: "Contract", body: "", hasAttachments: false }),
    });
    const shown: string[] = [];
    const canUse = makeCanUseTool(async (d) => (shown.push(d), { approved: true }), "chat", undefined, noJudge);
    await canUse(`${GM}reply`, { messageId: "m1", body: "Thanks" }, opts);
    assert.match(shown[0]!, /dana@example\.com/);
    assert.doesNotMatch(shown[0]!, /third@example\.com|boss@example\.com/, "a plain reply goes to the sender only");
    await canUse(`${GM}reply`, { messageId: "m2", body: "Thanks", replyAll: true }, opts);
    assert.match(shown[1]!, /third@example\.com/);
    assert.match(shown[1]!, /boss@example\.com/);
    // an explicit recipient is what is shown
    await canUse(`${GM}reply`, { messageId: "m3", body: "Hi", to: ["elsewhere@example.com"] }, opts);
    assert.match(shown[2]!, /elsewhere@example\.com/);
    assert.doesNotMatch(shown[2]!, /dana@example\.com/);
    // the original cannot be read: a reply with no recipients and a reply-all are not sent
    setGmailReaders({ draft: async () => undefined, original: async () => undefined });
    const blind = makeCanUseTool(async () => assert.fail("not asked"), "chat", undefined, noJudge);
    assert.equal((await blind(`${GM}reply`, { messageId: "m4", body: "x" }, opts))!.behavior, "deny");
    assert.equal((await blind(`${GM}reply`, { messageId: "m5", body: "x", replyAll: true, to: ["a@example.com"] }, opts))!.behavior, "deny");
    setGmailReaders(undefined);
  });
});

test("an unattended Gmail send always asks; chat sends are judged; forward and new sends are normalised (to, cc, bcc as strings, attachments)", async () => {
  await withGmail({}, async () => {
    const view = (tool: string, i: Record<string, unknown>) => mailView(`${GM}${tool}`, i, undefined, "gmail");
    const v = view("send_message", { to: "A@Example.com", cc: ["b@example.com"], bcc: "c@example.com", subject: "s", body: "b", attachments: [{ content: "AA==" }] });
    assert.deepEqual([v?.action, v?.to, v?.cc, v?.bcc, v?.hasAttachments], ["send", ["a@example.com"], ["b@example.com"], ["c@example.com"], true]);
    assert.equal(view("forward", { messageId: "m", to: ["x@example.com"], forwardText: "fyi" })?.body, "fyi");
    assert.equal(view("send_message", { draftId: "d" }), undefined, "a draft id alone has no content to show");
    let asked = 0;
    const canUse = makeCanUseTool(async () => (asked++, { approved: true }), "handler", undefined, noJudge);
    await canUse(`${GM}send_message`, { to: ["x@example.com"], subject: "s", body: "b" }, opts);
    await canUse(`${GM}forward`, { messageId: "m", to: ["y@example.com"] }, opts);
    assert.equal(asked, 2);
  });
});

test("drafts go to the judge in every place (the draft step), reads are free, nothing is sent by it", async () => {
  await withGmail({}, () => {
    for (const source of ["chat", "brief", "handler"] as const) {
      assert.equal(classify(`${GM}create_draft`, { to: ["a@example.com"], body: "x" }, source), "ask");
      assert.equal(classify(`${GM}update_draft`, { draftId: "d", body: "x" }, source), "ask");
    }
    for (const t of ["search_threads", "get_thread", "get_message", "get_draft", "list_drafts", "list_labels"]) assert.equal(classify(GM + t, {}, "radar"), "allow", t);
  });
});

// ---- parsing the connector's output (fake MCP results) ----

const mcp = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const THREADS = mcp({
  threads: [
    { id: "t-new", messages: [{ id: "m-a", subject: "Hello", sender: "Dana <dana@example.com>", date: "2026-10-14T08:00:00Z", snippet: "hi", label_ids: ["INBOX"] }, { id: "m-b", subject: "Re: Hello", sender: "Dana <dana@example.com>", date: "2026-10-14T09:30:00Z", snippet: "ping", label_ids: ["INBOX", "UNREAD"] }] },
    { id: "t-brief", messages: [{ id: "m-c", subject: "☀️ Daily brief", sender: SELF, date: "2026-10-14T05:00:00Z" }] },
    { messages: [{ id: "no-thread-id" }] },
  ],
});

test("parsing: search_threads becomes rows (latest message of each thread; the owner's own mail is shown as the owner)", () => {
  const rows = parseThreads(THREADS, SELF, "me");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { conversationId: "t-new", subject: "Re: Hello", lastSender: "Dana", receivedAtUtc: "2026-10-14T09:30:00.000Z", lastMessageId: "m-b" });
  assert.equal(rows[1]!.lastSender, "me");
  assert.deepEqual(parseThreads({}, SELF, "me"), []);
  assert.deepEqual(parseThreads("not json", SELF, "me"), []);
  // camelCase and a bare JSON string work too
  assert.equal(parseThreads(JSON.stringify({ threads: [{ id: "x", relatedMessages: [{ id: "y", sender: { name: "N", email: "n@example.com" }, subject: "S", date: "1760000000000" }] }] }), SELF, "me")[0]!.lastSender, "N");
});

test("parsing: a message, a draft and the original of a reply", () => {
  const msg = mcp({ id: "m1", subject: "S", sender: "Dana <dana@example.com>", to_recipients: [SELF, "x@example.com"], cc_recipients: ["boss@example.com"], plaintext_body: "Hello there" });
  assert.deepEqual(parseMessage(msg), { body: "Hello there", from: { displayName: "Dana", email: "dana@example.com" } });
  assert.deepEqual(parseOriginal(msg, SELF), { to: ["dana@example.com", "x@example.com"], cc: ["boss@example.com"], bcc: [], subject: "S", body: "", hasAttachments: false });
  assert.equal(parseOriginal(mcp({ subject: "no sender" }), SELF), undefined);
  const draft = parseDraft(mcp({ id: "d1", message: { subject: "Re", to_recipients: ["A@Example.com"], bcc_recipients: ["b@example.com"], plaintext_body: "text", attachments: [{ filename: "f.pdf" }] } }));
  assert.deepEqual(draft, { to: ["a@example.com"], cc: [], bcc: ["b@example.com"], subject: "Re", body: "text", hasAttachments: true, attachments: ["f.pdf"] });
  assert.equal(parseDraft(mcp({ id: "d" })), undefined);
  assert.deepEqual(payload([{ type: "text", text: "{\"a\":1}" }]), { a: 1 });
});

test("sanitiser: Gmail output is cleaned like Mailbird's, and attachment content never reaches the model", () => {
  const out = cleanToolOutput(`${GM}get_thread`, mcp({ messages: [{ plaintext_body: "Hi​ there", attachments: [{ filename: "a.pdf", mimeType: "application/pdf", content: "JVBERi0xLjQ=" }] }] }));
  assert.ok(out, "something was cleaned");
  const text = JSON.stringify(out!.output);
  assert.doesNotMatch(text, /JVBERi0/);
  assert.match(text, /a\.pdf/);
  assert.match(text, /attachment content withheld/);
  assert.doesNotMatch(text, /\\u200b/);
});

// ---- the relay and the mail source ----

test("relay: only the planned, allowed Gmail calls run", () => {
  const ok = (tool: string, input: Record<string, unknown>) => relayAllowed({ tool: GM + tool, input });
  assert.ok(ok("search_threads", { query: "in:inbox" }));
  assert.ok(ok("get_message", { messageId: "m", messageFormat: "PLAIN_TEXT" }));
  assert.ok(ok("unlabel_thread", { threadId: "t", labelIds: ["INBOX"] }));
  assert.ok(ok("label_thread", { threadId: "t", labelIds: ["INBOX"] }));
  assert.ok(!ok("label_thread", { threadId: "t", labelIds: ["TRASH"] }));
  assert.ok(!ok("label_thread", { threadId: "t", labelIds: ["STARRED"] }));
  assert.ok(!ok("unlabel_thread", { threadId: "t", labelIds: ["UNREAD"] }));
  assert.ok(!ok("get_thread", { threadId: "t", messageFormat: "RAW" }));
  for (const t of ["send_message", "reply", "forward", "trash_thread", "create_draft", "delete_draft", "mark_thread_spam"]) assert.ok(!ok(t, { to: ["a@example.com"], threadId: "t" }), t);
});

function fakeRelay(responses: Record<string, unknown>): { relay: Relay; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, relay: async (cs) => cs.map((c) => (calls.push(c), responses[c.tool.slice(GM.length)])) };
}

test("GmailMail: Mailbird-shaped calls over the connector; archive follows ARCHIVE; restore adds INBOX back", async () => {
  await withGmail({}, async () => {
    const { relay, calls } = fakeRelay({ search_threads: THREADS, get_message: mcp({ sender: "Dana <dana@example.com>", plaintext_body: "body text" }), unlabel_thread: mcp({}), label_thread: mcp({}) });
    let live = false;
    const mail = new GmailMail(relay, () => live);
    assert.deepEqual(await mail.inboxes(), [{ accountId: 0, email: SELF, senderName: "me", folderId: 0 }]);
    const rows = await mail.call<{ conversationId: string }[]>("list_conversations", { folderId: 0, limit: 100 });
    assert.equal(rows[0]!.conversationId, "t-new");
    assert.deepEqual(calls[0], { tool: `${GM}search_threads`, input: { query: "in:inbox newer_than:7d", pageSize: 50, view: "THREAD_VIEW_MINIMAL" } });
    assert.equal((await mail.call<{ body: string }>("get_message", { messageId: "m-b" })).body, "body text");
    assert.equal(calls[1]!.input.messageFormat, "PLAIN_TEXT");
    // log-only: no connector call at all
    const before = calls.length;
    assert.match(String(await mail.call("archive_conversation", { conversationId: "t-new" })), /log-only/);
    assert.equal(calls.length, before);
    live = true;
    await mail.call("archive_conversation", { conversationId: "t-new" });
    assert.deepEqual(calls.at(-1), { tool: `${GM}unlabel_thread`, input: { threadId: "t-new", labelIds: ["INBOX"] } });
    await mail.call("move_conversation_to_inbox", { conversationId: "t-new" });
    assert.deepEqual(calls.at(-1), { tool: `${GM}label_thread`, input: { threadId: "t-new", labelIds: ["INBOX"] } });
    await assert.rejects(() => mail.call("trash_conversation", { conversationId: "t" }), /not supported/);
  });
});

test("approval read-backs go through the relay with read-only calls", async () => {
  await withGmail({}, async () => {
    const { relay, calls } = fakeRelay({ get_draft: mcp({ message: { to_recipients: ["a@example.com"], plaintext_body: "x" } }), get_message: mcp({ sender: "d@example.com", to_recipients: [SELF] }) });
    const r = gmailReaders(relay);
    assert.deepEqual((await r.draft("d1"))?.to, ["a@example.com"]);
    assert.deepEqual((await r.original("m1"))?.to, ["d@example.com"], "the owner is left out");
    assert.deepEqual(calls.map((c) => c.tool.slice(GM.length)), ["get_draft", "get_message"]);
  });
});

// ---- the heartbeat on Gmail ----

async function heartbeatOnce(live: boolean, relayCalls: Call[]) {
  return withGmail({ archiveLive: live }, async () => {
    const was = readJson("state/seen.json", undefined);
    writeJson("state/seen.json", { seededAt: "2026-01-01T00:00:00.000Z", keys: {} });
    const { relay } = fakeRelay({ search_threads: THREADS, get_message: mcp({ sender: "Newsletter <news@example.com>", plaintext_body: "weekly digest" }), unlabel_thread: mcp({}) });
    const mail: MailSource = new GmailMail(async (cs) => (relayCalls.push(...cs), relay(cs)), () => settings.archiveLive);
    const log = console.log;
    console.log = () => {};
    try {
      const hb = startHeartbeat(
        { alert: async () => {}, handle: () => assert.fail("no Mailbird handler for Gmail"), briefDue: () => false, onTick: () => {} },
        { mail, triage: async (m) => m.map(() => ({ label: "archive" as const, kind: "newsletter" as const, reason: "weekly newsletter", protected: false })), setTimeout: () => 0, setInterval: () => 0 },
      );
      await hb.mailCheck();
    } finally {
      console.log = log;
      writeJson("state/seen.json", was ?? { keys: {} });
    }
  });
}

test("heartbeat on Gmail, log-only week: threads are triaged and recorded as would-archive, nothing is archived", async () => {
  const calls: Call[] = [];
  await heartbeatOnce(false, calls);
  assert.ok(!calls.some((c) => c.tool.endsWith("unlabel_thread")), "no archive call");
  const rows = readAudit((e) => e.tool === "heartbeat_triage" && e.decision === "would-archive" && e.meta?.id === "t-new");
  assert.ok(rows.length >= 1);
  assert.equal(rows.at(-1)!.meta?.messageId, "m-b");
  const digest = buildDigest(rows.map((e) => ({ ts: e.ts, decision: e.decision, meta: e.meta as never })).concat([{ ts: "x", decision: "kept", meta: { label: "act_now", from: "Dana", subject: "Q" } } as never]), undefined);
  assert.match(digest, /LOG-ONLY mode \(ARCHIVE=log\)/);
  assert.match(digest, /STILL IN THE INBOX/);
});

test("heartbeat on Gmail, archiving live: the thread loses INBOX (the audit id is the thread id, for restore)", async () => {
  const calls: Call[] = [];
  await heartbeatOnce(true, calls);
  const archive = calls.filter((c) => c.tool.endsWith("unlabel_thread"));
  assert.ok(archive.length >= 1);
  assert.deepEqual(archive[0]!.input, { threadId: "t-new", labelIds: ["INBOX"] });
  assert.ok(readAudit((e) => e.tool === "heartbeat_triage" && e.decision === "archived" && e.meta?.id === "t-new").length >= 1);
});

// ---- the brief ----

test("brief: Gmail's instructions use the gmail skill; email only with BRIEF_EMAIL=on and an address; the Signal brief stays the default", async () => {
  await withGmail({ briefEmail: false }, () => {
    assert.equal(briefDelivery(), "signal");
    const i = briefInstructions();
    assert.match(i, /ted-personal-assistant:gmail/);
    assert.match(i, /Do not deliver by email/);
    assert.doesNotMatch(i, /send_message/);
  });
  await withGmail({ briefEmail: true }, () => {
    assert.equal(briefDelivery(), "email");
    assert.match(briefInstructions(), new RegExp(`send_message[\\s\\S]*\\["${SELF.replace(".", "\\.")}"\\]`));
  });
  await withGmail({ briefEmail: true, mailSelfAddress: undefined }, () => assert.equal(briefDelivery(), "signal", "no address: no email"));
});

test("brief: the sent body is captured only from a send to the owner's own address", async () => {
  await withGmail({ briefEmail: true }, async () => {
    const deps = (send: Record<string, unknown>) => ({
      run: async (_p: string, onTool: (t: string, i: unknown) => void) => (onTool(`${GM}send_message`, send), { text: "ROUTINE_COMPLETE", costUsd: 0 }),
      sendBrief: async () => {},
      notify: async () => {},
      delivery: "email" as const,
    });
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(await runBriefAttempt(deps({ to: [SELF], subject: "☀️", body: "the brief" }), "p", 1, () => {}), "delivered");
      assert.equal(await runBriefAttempt(deps({ to: ["other@example.com"], subject: "☀️", body: "the brief" }), "p", 1, () => {}), "incomplete");
    } finally {
      console.log = log;
    }
  });
});

// ---- skills, doctor ----

test("skills and doctor: the gmail skill is offered instead of the Mailbird ones; doctor checks the address and the connector", () => {
  assert.ok(ownerSkills(true, "gmail").includes("ted-personal-assistant:gmail"));
  assert.ok(!ownerSkills(true, "gmail").some((s) => /mailbird/.test(s)));
  assert.ok(!ownerSkills(true, "mailbird").some((s) => /gmail/.test(s)));
  assert.ok(!ownerSkills(false, "gmail").some((s) => /gmail|mailbird/.test(s)));
  assert.ok(requiredSkills(true, "gmail").includes("gmail") && !requiredSkills(true, "gmail").includes("mailbird"));
  const out: [boolean | "warn", string][] = [];
  const line = (ok: boolean | "warn", what: string) => void out.push([ok, what]);
  gmailChecks(line, { self: undefined, connector: false, archiveLive: false, briefEmail: false });
  assert.deepEqual(out.slice(0, 2), [[false, "MAIL_SELF_ADDRESS set"], [false, "Gmail connector available"]]);
  out.length = 0;
  gmailChecks(line, { self: SELF, connector: undefined, archiveLive: true, briefEmail: true });
  assert.deepEqual(out.slice(0, 2), [[true, "MAIL_SELF_ADDRESS set"], ["warn", "Gmail connector available"]]);
  assert.deepEqual(addrs(SELF), [SELF]);
});

// ---- batching: one relay run per tick ----

test("getMessages: the messages of a tick go through ONE relay run, in order, duplicates once", async () => {
  await withGmail({}, async () => {
    const runs: Call[][] = [];
    const relay: Relay = async (cs) => (runs.push(cs), cs.map((c) => mcp({ sender: `Person ${c.input.messageId} <${c.input.messageId}@example.com>`, plaintext_body: `body ${c.input.messageId}` })));
    const got = await new GmailMail(relay).getMessages(["a", "b", "a", "c"]);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]!.map((c) => c.input), [{ messageId: "a", messageFormat: "PLAIN_TEXT" }, { messageId: "b", messageFormat: "PLAIN_TEXT" }, { messageId: "c", messageFormat: "PLAIN_TEXT" }]);
    assert.deepEqual(got.map((m) => (m as { body: string }).body), ["body a", "body b", "body a", "body c"]);
    assert.deepEqual(await new GmailMail(relay).getMessages([]), []);
    assert.equal(runs.length, 1); // nothing to fetch, no run
  });
});

test("getMessages: a big tick is split into runs of ten; a failed run fails only its own messages; a short result is an error for the missing one", async () => {
  await withGmail({}, async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `m${i}`);
    const sizes: number[] = [];
    const relay: Relay = async (cs) => {
      sizes.push(cs.length);
      if (sizes.length === 2) throw new Error("relay down");
      return cs.slice(0, sizes.length === 3 ? 2 : cs.length).map((c) => mcp({ sender: "d@example.com", plaintext_body: String(c.input.messageId) }));
    };
    const got = await new GmailMail(relay).getMessages(ids);
    assert.deepEqual(sizes, [10, 10, 3]);
    assert.equal((got[0] as { body: string }).body, "m0");
    assert.match((got[10] as Error).message, /relay down/);
    assert.equal((got[20] as { body: string }).body, "m20");
    assert.match((got[22] as Error).message, /no result/);
  });
});

test("getMessages: only calls the relay allows are sent (get_message, never raw), whatever the ids look like", async () => {
  await withGmail({}, async () => {
    assert.equal(relayAllowed({ tool: GM + "get_message", input: { messageId: "a", messageFormat: "RAW" } }), false);
    const seen: Call[][] = [];
    const relay: Relay = async (cs) => (seen.push(cs), cs.map(() => mcp({ sender: "d@example.com", plaintext_body: "x" })));
    const got = await new GmailMail(relay).getMessages(["a", 7 as unknown as string]);
    assert.equal(got.length, 2);
    assert.ok(seen[0]!.every((c) => relayAllowed(c) && c.tool === GM + "get_message"));
  });
});
