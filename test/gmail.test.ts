import { test } from "node:test";
import assert from "node:assert/strict";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { requiredSkills } from "../src/doctor.ts";
import { gmailReaders, parseDraft, parseOriginal, payload, putBackInInbox, relayAllowed, type Call, type Relay } from "../src/modules/gmail/gmail.ts";
import { isInboxArchive, isSelfSend } from "../src/modules/gmail/gmailrules.ts";
import { setGmailReaders } from "../src/modules/gmail/module.ts";
import { mailSlot } from "../src/modules/index.ts";
import { gmailChecks } from "../src/modules/runtime.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { classify, hiddenTools } from "../src/policy/policy.ts";
import { ownerSkills } from "../src/modules/skills.ts";
import { loadSettings, settings } from "../src/core/settings.ts";
import { cleanToolOutput } from "../src/core/toolclean.ts";
import { addrs, mailView } from "../src/policy/toolmanifest.ts";

// MAIL_PROVIDER=gmail. Everything here runs on fake connector output (the shapes follow the connector's published tool descriptions);
// none of it has met the live connector.

const GM = "mcp__claude_ai_Gmail__";
const SELF = "owner@example.com";
const opts = { signal: new AbortController().signal } as never;
const noJudge = async (): Promise<Verdict> => ({ decision: "ask", reason: "test" });

async function withGmail<T>(over: Record<string, unknown>, f: () => Promise<T> | T): Promise<T> {
  const s = settings as unknown as Record<string, unknown>;
  const keys = ["mail", "mailProvider", "mailSelfAddress", "briefEmail", "quietStartHour", "quietEndHour"];
  const was = Object.fromEntries(keys.map((k) => [k, s[k]]));
  Object.assign(s, { mail: true, mailProvider: "gmail", mailSelfAddress: SELF, briefEmail: false, quietStartHour: 0, quietEndHour: 0 }, over);
  try {
    return await f();
  } finally {
    Object.assign(s, was);
  }
}

// ---- settings ----

test("settings: gmail is accepted; the email brief is off by default; the Gmail connector stays visible, Mailbird hidden", () => {
  const g = loadSettings({ MAIL_PROVIDER: "gmail", MAIL_SELF_ADDRESS: " Owner@Example.com " });
  assert.equal(g.mailProvider, "gmail");
  assert.equal(g.mail, true);
  assert.equal(g.mailSelfAddress, SELF);
  assert.equal(g.briefEmail, false);
  assert.ok(!hiddenTools([], g).includes("mcp__claude_ai_Gmail"));
  assert.ok(hiddenTools([], g).includes("mcp__mailbird"));
  assert.equal(loadSettings({ MAIL_PROVIDER: "gmail", BRIEF_EMAIL: "on" }).briefEmail, true);
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
  await withGmail({}, () => {
    for (const t of ["trash_thread", "trash_message", "untrash_thread", "mark_thread_spam", "mark_message_spam", "unmark_message_spam", "delete_label", "update_label", "apply_sensitive_message_label", "apply_sensitive_thread_label", "get_attachment", "download_attachment"]) {
      assert.equal(classify(GM + t, { threadId: "t1", messageId: "m1" }, "chat"), "deny", t);
    }
    // the label-value rule, on every label tool and field
    assert.equal(classify(`${GM}label_thread`, { threadId: "t", labelIds: ["TRASH"] }, "chat"), "deny");
    assert.equal(classify(`${GM}label_thread`, { threadId: "t", labelIds: ["INBOX", "spam"] }, "chat"), "deny");
    assert.equal(classify(`${GM}label_message`, { messageId: "m", labelIds: [" Trash "] }, "chat"), "deny");
    assert.equal(classify(`${GM}update_message_labels`, { messageId: "m", addLabelIds: ["SPAM"] }, "chat"), "deny");
    assert.equal(classify(`${GM}update_message_labels`, { messageId: "m", removeLabelIds: ["TRASH"] }, "chat"), "deny");
    assert.equal(classify(`${GM}unlabel_thread`, { threadId: "t", labelIds: ["TRASH"] }, "background"), "deny");
    assert.equal(classify(`${GM}unlabel_thread`, { threadId: "t", labelIds: ["INBOX", "SPAM"] }, "background"), "deny");
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

test("policy: archiving is exactly 'remove INBOX from a thread', and it is sent to the judge in every place", async () => {
  const call = { threadId: "t1", labelIds: ["INBOX"] };
  assert.ok(isInboxArchive(`${GM}unlabel_thread`, call));
  assert.ok(!isInboxArchive(`${GM}unlabel_thread`, { threadId: "t1", labelIds: ["INBOX", "UNREAD"] }));
  assert.ok(!isInboxArchive(`${GM}unlabel_thread`, { labelIds: ["INBOX"] }));
  await withGmail({}, () => {
    for (const source of ["chat", "handler"] as const) assert.equal(classify(`${GM}unlabel_thread`, call, source), "ask", source); // judged, the same everywhere
    assert.equal(classify(`${GM}unlabel_thread`, { threadId: "t1", labelIds: ["UNREAD"] }, "chat"), "ask");
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
    assert.equal(classify(`${GM}send_message`, send({}), "background"), "allow");
    assert.equal(classify(`${GM}send_message`, send({ to: ["other@example.com"] }), "background"), "ask");
    assert.equal(classify(`${GM}send_message`, send({ bcc: ["other@example.com"] }), "background"), "ask");
    assert.equal(classify(`${GM}send_message`, send({}), "radar"), "ask", "only the brief run");
    assert.equal(classify(`${GM}send_message`, send({}), "chat"), "ask", "chat still goes through approval");
    assert.equal(classify(`${GM}reply`, { messageId: "m", body: "x" }, "background"), "ask");
  });
  await withGmail({ briefEmail: false }, () => assert.equal(classify(`${GM}send_message`, send({}), "background"), "ask", "BRIEF_EMAIL=off: no free send at all"));
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

test("an unattended Gmail send never acts on its own and asks nobody; chat sends are judged; forward and new sends are normalised (to, cc, bcc as strings, attachments)", async () => {
  await withGmail({}, async () => {
    const view = (tool: string, i: Record<string, unknown>) => mailView(`${GM}${tool}`, i, undefined, "gmail");
    const v = view("send_message", { to: "A@Example.com", cc: ["b@example.com"], bcc: "c@example.com", subject: "s", body: "b", attachments: [{ content: "AA==" }] });
    assert.deepEqual([v?.action, v?.to, v?.cc, v?.bcc, v?.hasAttachments], ["send", ["a@example.com"], ["b@example.com"], ["c@example.com"], true]);
    assert.equal(view("forward", { messageId: "m", to: ["x@example.com"], forwardText: "fyi" })?.body, "fyi");
    assert.equal(view("send_message", { draftId: "d" }), undefined, "a draft id alone has no content to show");
    let asked = 0;
    const canUse = makeCanUseTool(async () => (asked++, { approved: true }), "handler", undefined, noJudge);
    assert.equal((await canUse(`${GM}send_message`, { to: ["x@example.com"], subject: "s", body: "b" }, opts))!.behavior, "deny");
    assert.equal((await canUse(`${GM}forward`, { messageId: "m", to: ["y@example.com"] }, opts))!.behavior, "deny");
    assert.equal(asked, 0);
  });
});

test("drafts go to the judge in every place (the draft step), reads are free, nothing is sent by it", async () => {
  await withGmail({}, () => {
    for (const source of ["chat", "handler"] as const) {
      assert.equal(classify(`${GM}create_draft`, { to: ["a@example.com"], body: "x" }, source), "ask");
      assert.equal(classify(`${GM}update_draft`, { draftId: "d", body: "x" }, source), "ask");
    }
    for (const t of ["search_threads", "get_thread", "get_message", "get_draft", "list_drafts", "list_labels"]) assert.equal(classify(GM + t, {}, "radar"), "allow", t);
  });
});

// ---- parsing the connector's output (fake MCP results) ----

const mcp = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

test("parsing: a message, a draft and the original of a reply", () => {
  const msg = mcp({ id: "m1", subject: "S", sender: "Dana <dana@example.com>", to_recipients: [SELF, "x@example.com"], cc_recipients: ["boss@example.com"], plaintext_body: "Hello there" });
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
  assert.ok(ok("get_message", { messageId: "m", messageFormat: "MINIMAL" }));
  assert.ok(ok("get_draft", { draftId: "d" }));
  assert.ok(!ok("search_threads", { query: "in:inbox" }), "there is no mail check any more: the relay only reads back what an approval needs");
  assert.ok(!ok("unlabel_thread", { threadId: "t", labelIds: ["INBOX"] }), "an archive is the run's own call, never the relay's");
  assert.ok(ok("label_thread", { threadId: "t", labelIds: ["INBOX"] }));
  assert.ok(!ok("label_thread", { threadId: "t", labelIds: ["TRASH"] }));
  assert.ok(!ok("label_thread", { threadId: "t", labelIds: ["STARRED"] }));
  assert.ok(!ok("get_thread", { threadId: "t", messageFormat: "RAW" }));
  for (const t of ["send_message", "reply", "forward", "trash_thread", "create_draft", "delete_draft", "mark_thread_spam"]) assert.ok(!ok(t, { to: ["a@example.com"], threadId: "t" }), t);
});

function fakeRelay(responses: Record<string, unknown>): { relay: Relay; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, relay: async (cs) => cs.map((c) => (calls.push(c), responses[c.tool.slice(GM.length)])) };
}

test("restore: a thread goes back to the inbox by adding INBOX to it", async () => {
  const { relay, calls } = fakeRelay({ label_thread: mcp({}) });
  await putBackInInbox("t-new", relay);
  assert.deepEqual(calls, [{ tool: `${GM}label_thread`, input: { threadId: "t-new", labelIds: ["INBOX"] } }]);
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

// ---- the brief ----

test("brief: Gmail's delivery sentence uses the gmail skill; email only with BRIEF_EMAIL=on and an address; chat alone is the default", async () => {
  const how = () => mailSlot("gmail")!.brief.how();
  await withGmail({ briefEmail: false }, () => {
    assert.match(how(), /ted-personal-assistant:gmail/);
    assert.match(how(), /Do not deliver by email/);
    assert.doesNotMatch(how(), /send_message/);
  });
  await withGmail({ briefEmail: true }, () => assert.match(how(), new RegExp(`send_message[\\s\\S]*\\["${SELF.replace(".", "\\.")}"\\]`)));
  await withGmail({ briefEmail: true, mailSelfAddress: undefined }, () => assert.match(how(), /Do not deliver by email/, "no address: no email"));
});

test("skills and doctor: the gmail skill is offered instead of the Mailbird ones; doctor checks the address and the connector", () => {
  assert.ok(ownerSkills(true, "gmail").includes("ted-personal-assistant:gmail"));
  assert.ok(!ownerSkills(true, "gmail").some((s) => /mailbird/.test(s)));
  assert.ok(!ownerSkills(true, "mailbird").some((s) => /gmail/.test(s)));
  assert.ok(!ownerSkills(false, "gmail").some((s) => /gmail|mailbird/.test(s)));
  assert.ok(requiredSkills(true, "gmail").includes("gmail") && !requiredSkills(true, "gmail").includes("mailbird"));
  const out: [boolean | "warn", string][] = [];
  const line = (ok: boolean | "warn", what: string) => void out.push([ok, what]);
  gmailChecks(line, { self: undefined, connector: false, briefEmail: false });
  assert.deepEqual(out.slice(0, 2), [[false, "MAIL_SELF_ADDRESS set"], [false, "Gmail connector available"]]);
  out.length = 0;
  gmailChecks(line, { self: SELF, connector: undefined, briefEmail: true });
  assert.deepEqual(out.slice(0, 2), [[true, "MAIL_SELF_ADDRESS set"], ["warn", "Gmail connector available"]]);
  assert.deepEqual(addrs(SELF), [SELF]);
});

test("the relay hides every other connector, derived from the module registry (none named in gmail.ts)", async () => {
  const { otherConnectors } = await import("../src/modules/gmail/gmail.ts");
  const hidden = otherConnectors();
  for (const server of ["mcp__claude_ai_Notion", "mcp__claude_ai_Google_Calendar", "mcp__claude_ai_Google_Drive", "mcp__mailbird"]) assert.ok(hidden.includes(server), server);
  assert.ok(!hidden.some((h) => h.startsWith("mcp__claude_ai_Gmail")), "never Gmail itself");
});

// ---- batching: one relay run per tick ----

