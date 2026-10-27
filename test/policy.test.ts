import { mkdirSync, writeFileSync } from "node:fs";
import { settings } from "../src/core/settings.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { idsOf } from "../src/approvals/permissions.ts";
import { MAX_NOTE_CHARS, NOTES_DIR } from "../src/memory/notes.ts";
import { applyChanges, classify, hiddenTools, isReadTool } from "../src/policy/policy.ts";
import { loadSettings } from "../src/core/settings.ts";
import { neverAllowedTool } from "../src/policy/toolmanifest.ts";
import { SOURCES } from "../src/core/audit.ts";
import { kindOf, GROUP_CHAT, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

test("policy: every source audit.ts names is classified", () => { // (the per-source rights table is gone: flags in the manifest say who may do what)
  assert.equal(new Set(SOURCES).size, SOURCES.length);
  for (const source of SOURCES) assert.ok(["allow", "ask", "deny"].includes(classify("mcp__unknown__tool", {}, kindOf(source))), source); // every source is classified, none throws
});

const N = "mcp__claude_ai_Notion__";
const M = "mcp__mailbird__";
const C = "mcp__claude_ai_Google_Calendar__";
const chat = (tool: string, input: Record<string, unknown> = {}) => classify(tool, input, OWNER_CHAT);

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
    for (const source of ["chat", "radar", "handler", "background"] as const) assert.equal(classify(t, {}, kindOf(source)), "ask", `${t} (${source})`);
  }
  for (const source of ["chat", "radar", "handler", "background"] as const) assert.equal(classify(`${M}get_message`, {}, kindOf(source)), "allow", source);
});

test("the mail handler is on the same path as everyone: reads free, every write judged, nothing waved through by who it is", () => {
  assert.equal(classify(`${M}get_message`, {}, OWNER_LOOK), "allow");
  for (const t of [`${M}reply_to_conversation`, `${M}create_draft`, `${M}update_draft`, `${M}archive_conversation`, `${N}notion-update-page`, `${M}send_self_briefing`, `${M}send_message_now`])
    assert.equal(classify(t, {}, OWNER_LOOK), classify(t, {}, OWNER_CHAT), t);
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
  for (const t of [`${M}trash_conversation`, `${M}delete_conversation_permanently`, "mcp__claude_ai_Gmail__trash_thread", `${M}set_sender_blocked`, "mcp__claude_ai_Interactive_Brokers_IBKR__create_order_instruction", "mcp__claude_ai_Interactive_Brokers_IBKR__get_account_balances"])
    for (const source of ["chat", "handler"] as const) assert.equal(classify(t, {}, kindOf(source)), "deny", `${t} (${source})`);
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
    assert.equal(classify(t, { file_path: inside }, OWNER_CHAT), "allow", t);
    assert.equal(classify(t, { file_path: `${NOTES_DIR}/../state/seen.json` }, OWNER_CHAT), "deny", `${t} ..`);
    assert.equal(classify(t, { file_path: "/etc/passwd" }, OWNER_CHAT), "deny", `${t} outside`);
    assert.equal(classify(t, {}, OWNER_CHAT), "deny", `${t} no path`);
    for (const source of ["handler", "heartbeat"] as const) assert.equal(classify(t, { file_path: inside }, kindOf(source)), "allow", `${t} (${source}): a look keeps its notes as a chat does`);
    assert.equal(classify(t, { file_path: "/etc/passwd" }, OWNER_LOOK), "deny", `${t} outside (look)`);
  }
  assert.equal(classify("Write", { file_path: inside, content: "x".repeat(MAX_NOTE_CHARS + 1) }, OWNER_CHAT), "deny", "a note over the size cap");
  assert.equal(classify("Write", { file_path: inside, content: "x" }, OWNER_CHAT), "allow");
  assert.equal(classify("mcp__memory__forget_note", { file: "x.md" }, OWNER_CHAT), "allow");
  for (const source of ["handler", "heartbeat"] as const) assert.equal(classify("mcp__memory__forget_note", { file: "x.md" }, kindOf(source)), "allow", source);
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
  const cfg = { hiddenConnectors: ["mcp__claude_ai_Gmail"], visibleTools: { notion: ["notion-fetch", "notion-query-data-sources"], mailbird: ["get_message"] } };
  const hidden = hiddenTools([`${N}fetch`, `${N}query-data-sources`, `${N}search`], cfg);
  assert.deepEqual(hidden, ["mcp__claude_ai_Gmail", `${N}search`]);
});

test("hidden tools: Drive and Docs show reading and finding only; DRIVE_TOOLS brings one back", () => {
  const D = "mcp__claude_ai_Google_Drive__";
  const DOC = "mcp__claude_ai_Google_Docs__";
  const hide = ["create_file", "update_file", "copy_file", "share_file", "get_file_permissions", "download_file_content"].map((t) => D + t);
  const keep = ["search_files", "read_file_content", "list_recent_files", "get_file_metadata"].map((t) => D + t);
  const hidden = hiddenTools([...hide, ...keep, DOC + "read_doc", DOC + "update_doc"], loadSettings({}));
  for (const t of [...hide, DOC + "update_doc"]) assert.ok(hidden.includes(t), t);
  for (const t of [...keep, DOC + "read_doc"]) assert.ok(!hidden.includes(t), t);
  assert.ok(!hiddenTools([D + "copy_file"], loadSettings({ DRIVE_TOOLS: "copy_file" })).includes(D + "copy_file"));
});

// The pin of the refactor that made every module declare its own visible tools: what the model is hidden is exactly what the old per-provider settings gave, for every provider.
test("hidden tools: the defaults hide exactly what the per-provider lists did, for mailbird, gmail and no mail", () => {
  const MB = "mcp__mailbird__";
  const GM = "mcp__claude_ai_Gmail__";
  const NO = "mcp__claude_ai_Notion__notion-";
  const mailbirdKeep = ["summarize_all_inboxes", "list_accounts", "list_folders", "list_conversations", "search_conversations", "get_message", "get_conversation", "list_attachments", "get_attachment_content", "archive_conversation", "select_conversation", "reply_to_conversation", "reply_all_to_conversation", "create_draft", "update_draft", "discard_draft", "forward_conversation", "send_message_now", "get_send_status", "send_self_briefing"];
  const gmailKeep = ["search_threads", "get_thread", "get_message", "get_draft", "list_drafts", "list_labels", "create_draft", "update_draft", "delete_draft", "reply", "forward", "send_message", "unlabel_thread", "label_thread"];
  const notionKeep = ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"];
  const seen = [...mailbirdKeep.map((t) => MB + t), `${MB}snooze_conversation`, `${MB}trash_conversation`, `${MB}set_sender_blocked`, ...gmailKeep.map((t) => GM + t), `${GM}trash_thread`, `${GM}delete_label`, ...notionKeep.map((t) => `mcp__claude_ai_Notion__${t}`), `${NO}query-data-sources`, `${NO}create-comment`, "mcp__claude_ai_Google_Calendar__list_events"];
  const base = ["mcp__claude_ai_Interactive_Brokers_IBKR", "mcp__claude_ai_Claude_Docs"]; // (Google Drive and Docs are visible by default since the people lookup: HIDDEN_CONNECTORS hides them again)
  const oracle = (provider: "mailbird" | "gmail" | "none") => {
    const connectors = [base[0]!, ...(provider === "gmail" ? [] : ["mcp__claude_ai_Gmail"]), ...base.slice(1), ...(provider !== "mailbird" ? ["mcp__mailbird"] : [])];
    const extra = seen.filter((t) => (t.startsWith(MB) && !mailbirdKeep.includes(t.slice(MB.length))) || (t.startsWith(GM) && !gmailKeep.includes(t.slice(GM.length))) || (t.startsWith("mcp__claude_ai_Notion__") && !notionKeep.includes(t.slice("mcp__claude_ai_Notion__".length))) || neverAllowedTool(t));
    return [...connectors, ...new Set(extra)];
  };
  for (const provider of ["mailbird", "gmail", "none"] as const) {
    const cfg = loadSettings({ MAIL_PROVIDER: provider });
    assert.deepEqual(hiddenTools(seen, cfg), oracle(provider), provider);
  }
  assert.deepEqual(loadSettings({}).hiddenConnectors, ["mcp__claude_ai_Interactive_Brokers_IBKR", "mcp__claude_ai_Gmail", "mcp__claude_ai_Claude_Docs"]);
});

test("hidden tools: Mailbird tools the skills never use are hidden, the ones they use stay", () => {
  const M = "mcp__mailbird__";
  const hidden = hiddenTools([`${M}get_message`, `${M}archive_conversation`, `${M}snooze_conversation`, `${M}mark_all_as_read`, `${M}get_help`]);
  assert.ok(["snooze_conversation", "mark_all_as_read", "get_help"].every((t) => hidden.includes(`${M}${t}`)));
  assert.ok(!hidden.includes(`${M}get_message`) && !hidden.includes(`${M}archive_conversation`));
});

test("web: search is free and opening a page is judged in every place (which runs are offered the tools is agentrun.ts)", () => {
  assert.equal(classify("WebSearch", { query: "zurich opening hours" }, OWNER_CHAT), "allow");
  assert.equal(classify("WebFetch", { url: "https://example.com/x", prompt: "hours" }, OWNER_CHAT), "ask");
  assert.equal(classify("WebFetch", { url: "file:///etc/passwd", prompt: "x" }, OWNER_CHAT), "deny"); // the file:// rule still wins
  assert.equal(classify("WebSearch", { query: "weather in zurich" }, OWNER_LOOK), "allow");
  assert.equal(classify("WebFetch", { url: "https://example.com/x", prompt: "hours" }, OWNER_LOOK), "ask");
  assert.equal(classify("WebFetch", { url: "file:///etc/passwd", prompt: "x" }, OWNER_LOOK), "deny");
  for (const source of ["radar", "handler", "heartbeat"] as const) {
    assert.equal(classify("WebSearch", { query: "x" }, kindOf(source)), "allow", `WebSearch (${source})`);
    assert.equal(classify("WebFetch", { url: "https://example.com" }, kindOf(source)), "ask", `WebFetch (${source})`);
    assert.equal(classify("WebFetch", { url: "file:///etc/passwd" }, kindOf(source)), "deny", `WebFetch file:// (${source})`);
  }
  // a group never opens a page: its tool set does not hold the tool
  assert.equal(classify("WebFetch", { url: "https://example.com" }, GROUP_CHAT), "deny");
});

test("data folders: chat may read them (never write), and links cannot lead out", async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { isReadableData } = await import("../src/policy/policy.ts");
  const root = mkdtempSync(join(tmpdir(), "logs-"));
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(join(logs, "voice.jsonl"), "{}\n");
  writeFileSync(join(root, "secret.txt"), "x");
  symlinkSync(join(root, "secret.txt"), join(logs, "link.txt"));
  assert.equal(isReadableData(join(logs, "voice.jsonl"), [logs]), true);
  assert.equal(isReadableData(join(logs, "voice.jsonl"), [join(logs, "other.log")]), false, "an allow-list entry names exactly what it allows");
  assert.equal(isReadableData(join(logs, "..", "secret.txt"), [logs]), false);
  assert.equal(isReadableData(join(logs, "link.txt"), [logs]), false);
  assert.equal(isReadableData(join(logs, "missing.log"), [logs]), false);
  assert.equal(isReadableData(undefined, [logs]), false);
});

test("data folders: Read is allowed in chat only, Write and Edit never", () => {
  const log = `${settings.logsDir}/audit.jsonl`;
  mkdirSync(settings.logsDir, { recursive: true });
  writeFileSync(log, "");
  assert.equal(classify("Read", { file_path: log }, OWNER_CHAT), "allow");
  assert.equal(classify("Write", { file_path: log }, OWNER_CHAT), "deny");
  assert.equal(classify("Edit", { file_path: log }, OWNER_CHAT), "deny");
  for (const source of ["handler", "radar"] as const) assert.equal(classify("Read", { file_path: log }, kindOf(source)), classify("Read", { file_path: log }, OWNER_CHAT), `${source}: the same as a chat`);
});

test("search_logs: a read, so a look has it as a chat does", () => {
  assert.equal(classify("mcp__memory__search_logs", { query: "x" }, OWNER_CHAT), "allow");
  assert.equal(classify("mcp__memory__search_logs", { query: "x" }, OWNER_LOOK), "allow");
  assert.equal(classify("mcp__memory__forget_note", { file: "x.md" }, OWNER_LOOK), "allow", "the memory tools are every run's");
});

test("layout 2: the owner's chat reads only conversations/owner/{notes,messages.jsonl} and the three background logs; a group's or friend's file tools reach only their own notes folder", async () => {
  const { convPaths, conversationsDir, friendConvId, groupConvId, instancePaths, logPaths, OWNER_CONV } = await import("../src/core/convpaths.ts");
  const { isReadableData, readableData } = await import("../src/policy/policy.ts");
  const { join } = await import("node:path");
  const O = convPaths(OWNER_CONV);
  assert.deepEqual(readableData(), [O.notes, O.messages, logPaths().audit, logPaths().agent, logPaths().signalDaemon], "the allow-list, exactly");
  const group = convPaths(groupConvId("policy-group"));
  const friend = convPaths(friendConvId("zed-1"));
  const other = convPaths(groupConvId("another-group"));
  const touch = (p: string) => (mkdirSync(join(p, ".."), { recursive: true }), writeFileSync(p, "x"));
  const everything = [O.notes + "/MEMORY.md", O.messages, logPaths().audit, logPaths().agent, logPaths().signalDaemon, O.db, `${O.db}-wal`, O.dbDamaged, O.search, O.notesBackup + "/s/n.md",
    group.messages, group.notes + "/a.md", group.db, friend.messages, friend.notes + "/a.md", friend.tenantJson, other.notes + "/a.md",
    instancePaths().tenants, instancePaths().db, `${instancePaths().db}-wal`, `${instancePaths().db}-shm`, instancePaths().openbao + "/config.hcl", logPaths().launchdStderr, join(conversationsDir(), "stray.txt")];
  for (const p of everything) touch(p);
  const readable = new Set([O.notes + "/MEMORY.md", O.messages, logPaths().audit, logPaths().agent, logPaths().signalDaemon]);
  for (const p of everything) {
    assert.equal(isReadableData(p), readable.has(p), p);
    assert.equal(classify("Read", { file_path: p }, OWNER_CHAT) === "allow", readable.has(p), `Read ${p}`);
    assert.equal(classify("Write", { file_path: p }, OWNER_CHAT) === "allow", p.startsWith(O.notes + "/"), `Write ${p}`); // the owner may write only her own notes
  }
  // a group and a friend: their own notes folder and nothing else, not their own session either, not the owner's, not each other's, not a way out with ..
  for (const [src, mine, tools] of [["group", group, undefined], ["group", friend, new Set(["Read", "Write", "Edit"])]] as const) {
    for (const tool of ["Read", "Write", "Edit"]) {
      assert.equal(classify(tool, { file_path: `${mine.notes}/new.md` }, kindOf(src), mine.notes, tools), "allow", `${tool} own note`);
      for (const p of [mine.db, mine.messages, O.notes + "/MEMORY.md", O.messages, other.notes + "/a.md", instancePaths().tenants, `${mine.notes}/../assistant.db`, `${mine.notes}/../../owner/notes/MEMORY.md`, `${mine.dir}/notes-backup/x.md`]) {
        assert.equal(classify(tool, { file_path: p }, kindOf(src), mine.notes, tools), "deny", `${tool} ${p}`);
      }
    }
  }
});
