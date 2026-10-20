import { mkdirSync, writeFileSync } from "node:fs";
import { settings } from "../src/settings.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { idsOf } from "../src/permissions.ts";
import { NOTES_DIR } from "../src/notes.ts";
import { applyChanges, classify, hiddenTools, isReadTool } from "../src/policy.ts";
import { SOURCES } from "../src/audit.ts";

test("policy: every source audit.ts names is classified", () => { // (the per-source rights table is gone: flags in the manifest say who may do what)
  assert.equal(new Set(SOURCES).size, SOURCES.length);
  for (const source of SOURCES) assert.ok(["allow", "ask", "deny"].includes(classify("mcp__unknown__tool", {}, source)), source); // every source is classified, none throws
});

const N = "mcp__claude_ai_Notion__";
const M = "mcp__mailbird__";
const C = "mcp__claude_ai_Google_Calendar__";
const chat = (tool: string, input: Record<string, unknown> = {}) => classify(tool, input, "chat");

test("reads are allowed, including Notion's prefixed names (regression: brief hung on approval)", () => {
  for (const t of [
    `${N}notion-fetch`, `${N}notion-search`, `${N}notion-ai-search`, `${N}notion-query-meeting-notes`,
    `${N}notion-get-comments`, `${N}notion-list-recent-pages`,
    `${M}get_message`, `${M}list_conversations`, `${M}summarize_all_inboxes`, `${M}search_conversations`,
    `${C}list_events`, `${C}get_event`, `${C}suggest_time`,
    "mcp__claude_ai_Google_Drive__read_file_content", "mcp__claude_ai_Google_Docs__read_doc",
  ]) assert.equal(chat(t), "allow", t);
});

test("routine writes are not free: in every place they go to the judge (classify says ask), reads are free", () => {
  for (const t of [`${M}archive_conversation`, `${M}create_draft`, `${M}reply_to_conversation`, `${M}send_self_briefing`, `${N}notion-create-pages`, `${N}notion-update-page`]) {
    for (const source of ["chat", "brief", "radar", "handler", "background"] as const) assert.equal(classify(t, {}, source), "ask", `${t} (${source})`);
  }
  for (const source of ["chat", "brief", "radar", "handler", "background"] as const) assert.equal(classify(`${M}get_message`, {}, source), "allow", source);
});

test("the mail handler is on the same path as everyone: reads free, every write judged, nothing waved through by who it is", () => {
  assert.equal(classify(`${M}get_message`, {}, "handler"), "allow");
  for (const t of [`${M}reply_to_conversation`, `${M}create_draft`, `${M}update_draft`, `${M}archive_conversation`, `${N}notion-update-page`, `${M}send_self_briefing`, `${M}send_message_now`])
    assert.equal(classify(t, {}, "handler"), classify(t, {}, "chat"), t);
});

test("nothing may reference local files (create_draft takes file:// attachments)", () => {
  assert.equal(chat(`${M}create_draft`, { to: "x@example.com", attachments: ["file:///home/someone/.ssh/id_ed25519"] }), "deny");
  assert.equal(chat(`${M}create_draft`, { to: "x@example.com", attachments: ["FILE://~/.env"] }), "deny");
  assert.equal(chat(`${M}create_draft`, { to: "x@example.com", attachments: ["mailbird://mcp/messages/1/attachments/2"] }), "ask"); // judged like any draft
});

test("outward-facing actions are not free: classify asks (the judge may skip the question where the floor allows it)", () => {
  for (const t of [`${M}send_message_now`, `${C}create_event`, `${C}update_event`, `${C}respond_to_event`, "mcp__claude_ai_Google_Drive__share_file", "mcp__claude_ai_Gmail__send_message", `${N}notion-create-comment`])
    assert.equal(chat(t), "ask", t);
  assert.equal(chat(`${M}forward_conversation`), "ask"); // it only saves a draft (the judge passes it); the send is send_message_now
});

test("destructive actions and trading are denied, for everyone", () => {
  for (const t of [`${M}trash_conversation`, `${M}delete_conversation_permanently`, `${C}delete_event`, "mcp__claude_ai_Gmail__trash_thread", `${M}set_sender_blocked`, "mcp__claude_ai_Interactive_Brokers_IBKR__create_order_instruction", "mcp__claude_ai_Interactive_Brokers_IBKR__get_account_balances"])
    for (const source of ["chat", "brief", "handler"] as const) assert.equal(classify(t, {}, source), "deny", `${t} (${source})`);
});

test("unknown tools default to ask, never allow", () => {
  assert.equal(chat("mcp__new_server__do_something"), "ask");
  assert.equal(chat("Bash"), "ask");
});

test("a verb in the middle of a name is not a read", () => {
  assert.equal(isReadTool("mcp__x__update_get_thing"), false);
  assert.equal(isReadTool("mcp__x__send_search"), false);
});

test("edit-and-approve: allowed fields only, calendar only", () => {
  const input = { summary: "t", startTime: "2026-10-12T15:00:00", endTime: "2026-10-12T16:00:00", attendees: ["a@example.com"] };
  const tool = `${C}create_event`;
  assert.deepEqual(applyChanges(tool, input, [{ field: "startTime", value: "2026-10-12T16:00:00" }])?.startTime, "2026-10-12T16:00:00");
  assert.equal(applyChanges(tool, input, [{ field: "attendees", value: "x" }]), undefined); // protected
  assert.equal(applyChanges(tool, input, [{ field: "newField", value: "x" }]), undefined); // no new fields
  assert.equal(applyChanges(`${M}send_message_now`, { to: "a" }, [{ field: "to", value: "b" }]), undefined); // not modifiable
  assert.equal(applyChanges(tool, input, []), undefined);
});

test("memory notes: chat may read and write inside the notes folder only; everything else is denied", () => {
  const inside = `${NOTES_DIR}/style-no-em-dashes.md`;
  for (const t of ["Read", "Write", "Edit"]) {
    assert.equal(classify(t, { file_path: inside }, "chat"), "allow", t);
    assert.equal(classify(t, { file_path: `${NOTES_DIR}/../state/seen.json` }, "chat"), "deny", `${t} ..`);
    assert.equal(classify(t, { file_path: "/etc/passwd" }, "chat"), "deny", `${t} outside`);
    assert.equal(classify(t, {}, "chat"), "deny", `${t} no path`);
    for (const source of ["brief", "handler", "heartbeat"] as const) assert.equal(classify(t, { file_path: inside }, source), "deny", `${t} (${source})`);
  }
  assert.equal(classify("mcp__memory__forget_note", { file: "x.md" }, "chat"), "allow");
  for (const source of ["brief", "handler", "heartbeat"] as const) assert.equal(classify("mcp__memory__forget_note", { file: "x.md" }, source), "deny", source);
});

test("audit ids: keeps ids, drops content", () => {
  assert.deepEqual(idsOf({ conversationId: "abc", body: "secret text", subject: "x" }), { ids: { conversationId: "abc" } });
  assert.deepEqual(idsOf({ messageId: 5, id: "x" }), { ids: { messageId: 5, id: "x" } });
  assert.equal(idsOf({ body: "only content" }), undefined);
});

test("hidden tools: unused connectors, Notion beyond the skills' four, and always-denied tools", () => {
  const N = "mcp__claude_ai_Notion__notion-";
  const hidden = hiddenTools([`${N}fetch`, `${N}search`, `${N}create-pages`, `${N}update-page`, `${N}query-data-sources`, "mcp__mailbird__trash_conversation", "mcp__mailbird__get_message", "mcp__claude_ai_Google_Calendar__list_events"]);
  assert.ok(hidden.includes("mcp__claude_ai_Gmail") && hidden.includes("mcp__claude_ai_Interactive_Brokers_IBKR"));
  assert.ok(hidden.includes(`${N}query-data-sources`) && hidden.includes("mcp__mailbird__trash_conversation"));
  for (const keep of [`${N}fetch`, `${N}search`, `${N}create-pages`, `${N}update-page`, "mcp__mailbird__get_message", "mcp__claude_ai_Google_Calendar__list_events"]) assert.ok(!hidden.includes(keep), keep);
});

test("hidden tools: both lists come from settings, so a skill that needs another Notion tool can have it", () => {
  const N = "mcp__claude_ai_Notion__notion-";
  const cfg = { hiddenConnectors: ["mcp__claude_ai_Gmail"], notionTools: ["notion-fetch", "notion-query-data-sources"], mailbirdTools: ["get_message"] };
  const hidden = hiddenTools([`${N}fetch`, `${N}query-data-sources`, `${N}search`], cfg);
  assert.deepEqual(hidden, ["mcp__claude_ai_Gmail", `${N}search`]);
});

test("hidden tools: Mailbird tools the skills never use are hidden, the ones they use stay", () => {
  const M = "mcp__mailbird__";
  const hidden = hiddenTools([`${M}get_message`, `${M}archive_conversation`, `${M}snooze_conversation`, `${M}mark_all_as_read`, `${M}get_help`]);
  assert.ok(["snooze_conversation", "mark_all_as_read", "get_help"].every((t) => hidden.includes(`${M}${t}`)));
  assert.ok(!hidden.includes(`${M}get_message`) && !hidden.includes(`${M}archive_conversation`));
});

test("web: search is free and opening a page is judged in every place (which runs are offered the tools is agentrun.ts)", () => {
  assert.equal(classify("WebSearch", { query: "zurich opening hours" }, "chat"), "allow");
  assert.equal(classify("WebFetch", { url: "https://example.com/x", prompt: "hours" }, "chat"), "ask");
  assert.equal(classify("WebFetch", { url: "file:///etc/passwd", prompt: "x" }, "chat"), "deny"); // the file:// rule still wins
  assert.equal(classify("WebSearch", { query: "weather in zurich" }, "background"), "allow");
  assert.equal(classify("WebFetch", { url: "https://example.com/x", prompt: "hours" }, "background"), "ask");
  assert.equal(classify("WebFetch", { url: "file:///etc/passwd", prompt: "x" }, "background"), "deny");
  for (const source of ["brief", "radar", "handler", "heartbeat"] as const) {
    assert.equal(classify("WebSearch", { query: "x" }, source), "allow", `WebSearch (${source})`);
    assert.equal(classify("WebFetch", { url: "https://example.com" }, source), "ask", `WebFetch (${source})`);
    assert.equal(classify("WebFetch", { url: "file:///etc/passwd" }, source), "deny", `WebFetch file:// (${source})`);
  }
  // a group never opens a page: its tool set does not hold the tool
  assert.equal(classify("WebFetch", { url: "https://example.com" }, "group"), "deny");
});

test("data folders: chat may read them (never write), and links cannot lead out", async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { isReadableData } = await import("../src/policy.ts");
  const root = mkdtempSync(join(tmpdir(), "logs-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "voice.jsonl"), "{}\n");
  writeFileSync(join(root, "secret.txt"), "x");
  symlinkSync(join(root, "secret.txt"), join(logs, "link.txt"));
  assert.equal(isReadableData(join(logs, "voice.jsonl"), [logs]), true);
  assert.equal(isReadableData(join(logs, "..", "secret.txt"), [logs]), false);
  assert.equal(isReadableData(join(logs, "link.txt"), [logs]), false);
  assert.equal(isReadableData(join(logs, "missing.log"), [logs]), false);
  assert.equal(isReadableData(undefined, [logs]), false);
});

test("data folders: Read is allowed in chat only, Write and Edit never", () => {
  const log = `${settings.logsDir}/voice.jsonl`;
  mkdirSync(settings.logsDir, { recursive: true });
  writeFileSync(log, "");
  assert.equal(classify("Read", { file_path: log }, "chat"), "allow");
  assert.equal(classify("Write", { file_path: log }, "chat"), "deny");
  assert.equal(classify("Edit", { file_path: log }, "chat"), "deny");
  for (const source of ["brief", "handler", "radar"] as const) assert.equal(classify("Read", { file_path: log }, source), "deny", source);
});

test("search_logs: chat only", () => {
  assert.equal(classify("mcp__memory__search_logs", { query: "x" }, "chat"), "allow");
  for (const source of ["brief", "handler", "radar", "heartbeat"] as const) assert.equal(classify("mcp__memory__search_logs", { query: "x" }, source), "deny", source);
});
