import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCES } from "../src/audit.ts";
import { classify } from "../src/policy/policy.ts";
import { NEVER_ACTIONS } from "../src/policy/neverallowed.ts";
import { settings } from "../src/settings.ts";
import { mailProviders, registered } from "../src/modules/index.ts";
import { actionOf, allRows, availableFor, entryFor, isFree, mailView, readsUntrusted } from "../src/policy/toolmanifest.ts";
import { isJudgeable } from "../src/approvals/autojudge.ts";
import { access } from "./util.ts";

const MANIFEST = allRows();
const MAIL_PROVIDERS = mailProviders();
const MB = "mcp__mailbird__";
const GM = "mcp__claude_ai_Gmail__";
const CAL = "mcp__claude_ai_Google_Calendar__";
const N = "mcp__claude_ai_Notion__";

test("manifest: a tool name appears in one entry only, and every entry names a provider and an action", () => {
  const names = MANIFEST.map((e) => e.tool);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  for (const e of MANIFEST) {
    assert.ok(e.provider && e.action && e.cap, e.tool);
    assert.ok(!("flag" in e), `${e.tool}: a row says what a tool is, not who may use it`);
    assert.ok(e.view === undefined || MAIL_PROVIDERS.includes(e.provider) || e.provider === "google", `${e.tool}: only mail tools have a mail view`);
  }
});

test("manifest: every entry classifies the same way for every source: not there (deny), free (allow) or judged (ask); the active mail provider only", () => {
  for (const e of MANIFEST) {
    if (MAIL_PROVIDERS.includes(e.provider) && e.provider !== settings.mailProvider) continue;
    for (const source of SOURCES) {
      if (source === "group") continue; // a group has its own rules (below)
      const there = !e.only || e.only.includes(source);
      assert.equal(availableFor(e.tool, source), there, `${e.tool} (${source})`);
      assert.equal(actionOf(e.tool), e.action, e.tool);
      // Read/Write/Edit also need a path inside the notes: with none the file rule denies first
      if (e.provider === "builtin" && e.action === "note-file") continue;
      assert.equal(classify(e.tool, {}, source), !there || NEVER_ACTIONS.has(e.action) ? "deny" : isFree(e.tool) ? "allow" : "ask", `${e.tool} (${source})`); // (a never-allowed action is denied wherever the tool exists)
    }
  }
});

test("manifest: which tools run free and which are judged, tool by tool; the same in every place they exist", () => {
  const table: Record<string, "free" | "judged"> = {
    [`${MB}get_message`]: "free",
    [`${MB}create_draft`]: "judged",
    [`${MB}update_draft`]: "judged",
    [`${MB}reply_to_conversation`]: "judged", // an in-thread reply is a DRAFT in Mailbird
    [`${MB}archive_conversation`]: "judged",
    [`${MB}select_conversation`]: "judged",
    [`${MB}send_self_briefing`]: "judged",
    [`${MB}send_message_now`]: "judged",
    [`${MB}forward_conversation`]: "judged",
    [`${CAL}list_events`]: "free",
    [`${CAL}create_event`]: "judged",
    [`${CAL}update_event`]: "judged",
    [`${CAL}respond_to_event`]: "judged",
    "mcp__claude_ai_Google_Drive__share_file": "judged",
    [`${N}notion-fetch`]: "free",
    [`${N}notion-create-pages`]: "judged",
    [`${N}notion-update-page`]: "judged",
    [`${N}notion-create-comment`]: "judged",
    WebSearch: "free",
    WebFetch: "judged",
    Skill: "free",
    "mcp__browse__browse": "judged",
    "mcp__send__send": "free",
    "mcp__memory__forget_note": "free",
  };
  for (const [tool, kind] of Object.entries(table)) {
    for (const source of SOURCES) if (availableFor(tool, source)) assert.equal(access(tool, source), kind, `${tool} (${source})`);
    assert.ok(SOURCES.some((s) => availableFor(tool, s)), tool);
  }
  // no per-source table: the web tools and the browse entry exist in every run, the ones that need a conversation or a notes folder only there
  for (const source of SOURCES) for (const t of ["WebSearch", "WebFetch", "mcp__browse__browse", `${MB}archive_conversation`, `${CAL}update_event`]) assert.ok(availableFor(t, source), `${t} (${source})`);
  assert.deepEqual(SOURCES.filter((s) => availableFor("mcp__send__send", s)), ["chat", "group"]);
  assert.deepEqual(SOURCES.filter((s) => availableFor("mcp__draw__draw", s)), ["chat", "group"]);
});

test("manifest: only the browse run has the browser's tools; reading mail or a page marks a run as having read untrusted text", () => {
  for (const source of SOURCES) assert.equal(availableFor("mcp__browser__browser_navigate", source), source === "browse", source);
  assert.ok(readsUntrusted(`${MB}get_message`));
  assert.ok(readsUntrusted("WebFetch"));
  assert.ok(readsUntrusted("mcp__browser__browser_snapshot"));
  assert.ok(readsUntrusted(`${MB}get_new_thing`)); // a read verb of the mail connector counts
  assert.ok(readsUntrusted(`${CAL}list_events`), "every read is untrusted by default: an event's text is written by whoever invited the owner");
  assert.ok(readsUntrusted(`${N}notion-fetch`) && readsUntrusted("mcp__claude_ai_Google_Drive__read_file_content") && readsUntrusted("mcp__claude_ai_Google_Docs__read_doc"));
  assert.ok(!readsUntrusted("mcp__weather__get_forecast"), "a module opts out: public data");
  assert.ok(!readsUntrusted(`${MB}archive_conversation`));
  assert.ok(!readsUntrusted("mcp__send__send"));
});

test("manifest: unknown tools are never free (they ask) and are never judged, whatever their name says; the read-verb heuristic only marks untrusted text", () => {
  for (const source of SOURCES) if (source !== "group") assert.equal(access("mcp__new_server__do_something", source), "judged", source);
  assert.equal(access("Bash", "chat"), "judged");
  assert.equal(classify("mcp__new_server__do_something", {}, "chat"), "ask");
  assert.equal(access("mcp__new_server__get_thing", "chat"), "judged");
  assert.equal(classify("mcp__new_server__get_thing", {}, "chat"), "ask");
  assert.equal(actionOf("mcp__new_server__get_thing"), "read");
  assert.equal(isJudgeable("mcp__new_server__get_thing", {}), false);
  assert.equal(actionOf("mcp__x__send_search"), "unknown");
});

test("manifest: a provider's entries take effect only while it is the active mail provider", () => {
  const gmailEntries = MANIFEST.filter((e) => e.provider === "gmail");
  const mailbirdEntries = MANIFEST.filter((e) => e.provider === "mailbird");
  assert.ok(gmailEntries.length > 5 && mailbirdEntries.length > 10);
  for (const e of gmailEntries) {
    assert.equal(entryFor(e.tool, "mailbird"), undefined, `${e.tool} must not leak into mailbird mode`);
    assert.equal(entryFor(e.tool, "none"), undefined, e.tool);
    assert.equal(entryFor(e.tool, "gmail")?.provider, "gmail", e.tool);
  }
  for (const e of mailbirdEntries) {
    assert.equal(entryFor(e.tool, "gmail"), undefined, `${e.tool} must not leak into gmail mode`);
    assert.equal(entryFor(e.tool, "mailbird")?.provider, "mailbird", e.tool);
  }
  // a Gmail send in mailbird mode is just an unknown tool: asks, and no mail view
  assert.equal(entryFor(`${GM}send_message`, "mailbird"), undefined);
  assert.equal(mailView(`${GM}send_message`, { to: ["a@example.com"] }, undefined, "mailbird"), undefined);
  assert.equal(mailView(`${MB}create_draft`, { to: [{ email: "a@example.com" }] }, undefined, "gmail"), undefined);
  // ...and with gmail active the same rule holds as for Mailbird: sends are judged, drafts judged too, reads free, in every place
  for (const source of ["chat", "handler", "radar", "brief"] as const) {
    assert.equal(access(`${GM}send_message`, source, "gmail"), "judged", source);
    assert.equal(access(`${GM}reply`, source, "gmail"), "judged", source);
    assert.equal(access(`${GM}forward`, source, "gmail"), "judged", source);
    assert.equal(access(`${GM}create_draft`, source, "gmail"), "judged", source);
    assert.equal(access(`${GM}search_threads`, source, "gmail"), "free", source);
  }
});

test("manifest: same action, same behaviour across mail providers", () => {
  const by = (provider: string, action: string) => MANIFEST.filter((e) => e.provider === provider && e.action === action).map((e) => isFree(e.tool, provider as "mailbird" | "gmail"));
  for (const action of ["send", "forward", "draft", "read", "archive"]) {
    const a = new Set([...by("mailbird", action), ...by("gmail", action)]);
    assert.equal(a.size, 1, action);
  }
});

test("manifest: every connector tool the model is given by default (a module's `hide.visible`) has an entry", () => {
  const hiding = registered().filter((m) => m.hide);
  assert.deepEqual(hiding.map((m) => m.name).sort(), ["gmail", "mailbird", "notion"]);
  for (const m of hiding) for (const t of m.hide!.visible) assert.ok(allRows().some((r) => r.tool === m.hide!.prefix + t), `${m.name}: ${t}`);
});

test("manifest: the group's rules are not flags and stay as they were", () => {
  const dir = "/nonexistent-group-dir";
  assert.equal(classify("WebSearch", { query: "x" }, "group"), "allow");
  assert.equal(classify("WebFetch", { url: "https://example.com" }, "group"), "deny");
  assert.equal(classify(`${MB}send_message_now`, {}, "group"), "deny");
  assert.equal(classify(`${CAL}create_event`, {}, "group"), "deny");
  assert.equal(classify("Read", { file_path: `${dir}/x.md` }, "group"), "deny");
});

test("mailView: Mailbird send reads its draft back; bcc and attachments are always in the view", () => {
  const draft = { to: ["a@example.com"], cc: [], bcc: ["spy@example.com"], subject: "Hi", body: "text", hasAttachments: true };
  assert.deepEqual(mailView(`${MB}send_message_now`, { messageId: 5, confirm: true }, draft), { action: "send", ...draft });
  assert.equal(mailView(`${MB}send_message_now`, { messageId: 5, confirm: true }), undefined); // no draft read back: no view
});

test("mailView: Mailbird forward and reply tools, and create/update draft", () => {
  assert.deepEqual(mailView(`${MB}forward_conversation`, { conversationId: "g", body: "FYI" }), { action: "forward", to: [], cc: [], bcc: [], subject: "", body: "FYI", hasAttachments: false });
  assert.equal(mailView(`${MB}reply_to_conversation`, { conversationId: "g", body: "ok" })?.action, "draft");
  const d = mailView(`${MB}create_draft`, { accountId: 1, to: [{ email: "A@Example.com", name: "A" }], bcc: [{ email: "b@example.com" }], subject: "S", body: "B", attachments: ["mailbird://x"] });
  assert.deepEqual(d, { action: "draft", to: ["a@example.com"], cc: [], bcc: ["b@example.com"], subject: "S", body: "B", hasAttachments: true, attachments: ["mailbird://x"] });
});

test("mailView: the Gmail connector's send, reply, forward and drafts normalise to the same view", () => {
  const v = (tool: string, input: Record<string, unknown>) => mailView(`${GM}${tool}`, input, undefined, "gmail");
  assert.deepEqual(v("send_message", { to: ["A@example.com"], cc: ["c@example.com"], bcc: ["b@example.com"], subject: "S", body: "B", attachments: [{ content: "eA==", filename: "f.txt" }] }), {
    action: "send", to: ["a@example.com"], cc: ["c@example.com"], bcc: ["b@example.com"], subject: "S", body: "B", hasAttachments: true, attachments: ["f.txt"],
  });
  assert.equal(v("send_message", { draftId: "r1" }), undefined); // a draft nobody read back cannot be shown
  assert.deepEqual(v("reply", { messageId: "m", to: ["a@example.com"], bcc: ["b@example.com"], htmlBody: "<p>hi</p>" }), {
    action: "reply", to: ["a@example.com"], cc: [], bcc: ["b@example.com"], subject: "", body: "<p>hi</p>", hasAttachments: false,
  });
  assert.deepEqual(v("forward", { messageId: "m", to: ["x@example.com"], forwardText: "FYI", bcc: ["b@example.com"] }), {
    action: "forward", to: ["x@example.com"], cc: [], bcc: ["b@example.com"], subject: "", body: "FYI", hasAttachments: false,
  });
  assert.equal(v("create_draft", { to: ["a@example.com"], subject: "S", body: "B" })?.action, "draft");
  assert.equal(v("update_draft", { draftId: "d", bcc: ["b@example.com"] })?.bcc[0], "b@example.com");
  assert.equal(v("search_threads", { query: "x" }), undefined); // not an outgoing mail
});
