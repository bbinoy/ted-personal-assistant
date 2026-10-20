import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJudgeable, mayFix, notifyNote } from "../src/autojudge.ts";
import { namesNoGuests, namesPeople } from "../src/guests.ts";
import { destinationIsTrashOrSpam, NEVER_ACTIONS, nameIsNever, namesLocalFile } from "../src/neverallowed.ts";
import { sweepStaleRuns } from "../src/browse.ts";
import { registered } from "../src/modules/index.ts";
import { applyChanges, classify, hiddenTools, isNeverAllowed } from "../src/policy.ts";
import { SOURCES } from "../src/audit.ts";
import { allRows, isFree, neverAllowedTool } from "../src/toolmanifest.ts";
import { groupTools } from "../src/capabilities.ts";
import { SYSTEM } from "../src/approvaljudge.ts";

// ONE never-allowed mechanism (neverallowed.ts, toolmanifest.ts neverAllowedTool, policy.ts classify) and the one fold of classify: tested over the rows, over
// every tool name each connector is known to have, by name, by arguments, and for every source.

const MB = "mcp__mailbird__";
const GM = "mcp__claude_ai_Gmail__";
const CAL = "mcp__claude_ai_Google_Calendar__";
const DRIVE = "mcp__claude_ai_Google_Drive__";
const N = "mcp__claude_ai_Notion__";

// The tool names of the connectors as they are live (read from the connectors' schemas), for the ones the modules do not seed with `known`.
const LIVE: Record<string, string> = {
  calendar: "create_event delete_event get_event list_calendars list_events respond_to_event search_events suggest_time update_event",
  drive: "copy_file create_file download_file_content get_file_metadata get_file_permissions list_recent_files read_file_content search_files share_file trash_file update_file",
  docs: "read_doc update_doc",
  claudedocs: "batch create delete export guide query read update",
  ibkr: "create_alert create_order_instruction create_watchlist delete_alert delete_order_instruction delete_watchlist edit_watchlist get_account_balances get_account_orders get_account_positions get_account_summary get_account_trades get_alert get_alerts get_combo_identifier get_company_connections get_company_themes get_option_data get_option_parameters get_order_instructions get_pa_allocation get_pa_performance_all_periods get_price_history get_price_snapshot get_theme_details get_watchlist get_watchlists provide_customer_feedback search_contracts search_futures search_investment_topics set_alert_status update_alert whats_new",
};
const PREFIX: Record<string, string> = { calendar: CAL, drive: DRIVE, docs: "mcp__claude_ai_Google_Docs__", claudedocs: "mcp__claude_ai_Claude_Docs__", ibkr: "mcp__claude_ai_Interactive_Brokers_IBKR__" };
const liveNames = Object.entries(LIVE).flatMap(([k, v]) => v.split(" ").map((n) => PREFIX[k] + n));
const known = registered().flatMap((m) => m.known ?? []);
const everyName = [...new Set([...allRows().map((e) => e.tool), ...known, ...liveNames])];

test("never allowed: a row's action in NEVER_ACTIONS decides, for every source and every provider (loaded or not)", () => {
  assert.deepEqual([...NEVER_ACTIONS].sort(), ["block", "delete", "spam", "trade", "trash"]);
  const expected = [
    `${MB}trash_conversation`, `${MB}delete_conversation_permanently`, `${MB}discard_draft`, `${MB}set_conversation_spam`, `${MB}set_sender_blocked`,
    `${GM}trash_message`, `${GM}trash_thread`, `${GM}untrash_message`, `${GM}untrash_thread`, `${GM}mark_message_spam`, `${GM}mark_thread_spam`, `${GM}unmark_message_spam`, `${GM}unmark_thread_spam`, `${GM}delete_draft`, `${GM}delete_label`,
    `${CAL}delete_event`, `${DRIVE}trash_file`, "mcp__claude_ai_Claude_Docs__delete",
  ];
  const byRow = allRows().filter((e) => NEVER_ACTIONS.has(e.action)).map((e) => e.tool);
  assert.deepEqual([...byRow].sort(), [...expected].sort());
  for (const t of expected) {
    assert.ok(neverAllowedTool(t), t);
    for (const source of SOURCES) assert.equal(classify(t, {}, source), "deny", `${t} (${source})`);
    assert.equal(isJudgeable(t, {}), false, t);
    assert.equal(mayFix(t), false, t);
  }
  // trading: the whole connector, listed or not, whichever name it goes by
  for (const t of liveNames.filter((n) => n.includes("Interactive_Brokers")).concat(["mcp__claude_ai_Interactive_Brokers__brand_new_tool", "mcp__claude_ai_Interactive_Brokers_IBKR__get_something_new"])) {
    for (const source of SOURCES) assert.equal(classify(t, {}, source), "deny", `${t} (${source})`);
  }
});

test("never allowed: a tool no module lists is denied by a name that says trash, delete, purge, erase, destroy, spam, junk or block, at word boundaries", () => {
  for (const t of ["mcp__x__trash_thing", "mcp__x__delete", "mcp__x__purge-all", "mcp__x__erase_data", "mcp__x__destroy_it", "mcp__x__mark_spam", "mcp__x__junk_mail", "mcp__x__block_sender", "mcp__x__set_blocked", "mcp__x__notion-delete-page", "mcp__x__do_trash"]) {
    assert.ok(nameIsNever(t), t);
    assert.equal(classify(t, {}, "chat"), "deny", t);
    for (const source of ["brief", "handler", "background"] as const) assert.equal(classify(t, {}, source), "deny", `${t} (${source})`);
  }
  for (const t of ["mcp__x__get_thing", "mcp__x__blockquote_style", "mcp__x__undeleted_not_a_token", "mcp__x__list_blocks_free", "mcp__x__spamming", "mcp__x__search_deleted"]) assert.equal(nameIsNever(t), false, t);
  // every read name in the code and in the connectors' lists must survive the rule (a row decides for the ones it lists)
  for (const e of allRows().filter((r) => r.action === "read" || r.action.endsWith("-read"))) assert.equal(neverAllowedTool(e.tool), false, e.tool);
  // and the plain names of every known tool: only the intended ones match
  const matched = everyName.filter((t) => nameIsNever(t) && !allRows().some((r) => r.tool === t));
  assert.deepEqual(matched.filter((t) => !t.includes("Interactive_Brokers")).sort(), [], "every name the rule matches is already a row (the rule is the net for the ones nobody listed)");
});

test("never allowed: the arguments, snake_case and camelCase, for tools that only do it through a value", () => {
  for (const input of [
    { labelIds: ["TRASH"] }, { addLabelIds: ["inbox", " spam "] }, { removeLabelIds: ["TRASH"] }, { add_label_ids: ["SPAM"] }, { label_ids: ["trash"] }, { labelOption: "SPAM" },
    { message: { labelIds: ["TRASH"] } }, { spam: true }, { isSpam: "true" }, { in_trash: true }, { inTrash: true }, { archived: true }, { trashed: true },
    { properties: { in_trash: true } }, { allow_deleting_content: true }, { allowDeletingContent: true }, { action: "delete" }, { action: "Trash" },
  ]) {
    assert.ok(isNeverAllowed("mcp__x__update_thing", input), JSON.stringify(input));
    assert.equal(classify(`${N}notion-update-page`, input, "chat"), "deny", JSON.stringify(input));
  }
  for (const input of [{ labelIds: ["INBOX", "UNREAD"] }, { spam: false }, { archived: false }, { in_trash: false }, { allow_deleting_content: false }, { action: "create" }, { action: "rsvp" }, { query: "trash" }, { body: "this is spam" }]) assert.equal(destinationIsTrashOrSpam(input) || isNeverAllowed("mcp__x__update_thing", input), false, JSON.stringify(input));
  // the friend's calendar delete, like the owner's
  assert.equal(classify("mcp__google__manage_event", { action: "delete", event_id: "e" }, "chat"), "deny");
});

test("a Mailbird move is asked and never judged (the destination may be Trash or Junk); discard_draft is denied, nothing uses it", () => {
  assert.equal(classify(`${MB}move_conversation`, { conversationId: "c", destinationFolderId: "x" }, "chat"), "ask");
  assert.equal(isJudgeable(`${MB}move_conversation`, { conversationId: "c" }), false);
  assert.equal(mayFix(`${MB}move_conversation`), false);
  assert.equal(classify(`${MB}discard_draft`, {}, "chat"), "deny");
  assert.equal(classify(`${MB}show_notification`, {}, "chat"), "ask");
});

test("classify is one fold: a floor can only lower, a call a module declares free is the only grant, and nothing unknown is free", () => {
  assert.equal(isFree("mcp__x__get_thing"), false);
  assert.equal(classify("mcp__x__get_thing", {}, "chat"), "ask");
  for (const source of SOURCES) assert.notEqual(classify("mcp__x__get_thing", {}, source), "allow", source);
  // local files: any string starting with file:, anywhere, for every source
  assert.equal(classify(`${MB}create_draft`, { attachments: ["FILE:///etc/passwd"] }, "chat"), "deny");
  assert.equal(classify(`${MB}create_draft`, { note: "file:/x" }, "handler"), "deny");
  assert.equal(classify("mcp__send__send", { text: "x", path: "file:///x" }, "group", "/n", new Set(["mcp__send__send"])), "deny");
  assert.equal(classify("WebSearch", { query: "x", file: "file:///x" }, "group", "/n", new Set(["WebSearch"])), "deny");
  // an absolute or ~ path in an attachments-like field
  for (const attachments of [["/home/someone/.ssh/id_ed25519"], ["~/.env"], [{ path: "/etc/hosts" }], { files: ["C:\\data\\a.txt"] }]) assert.ok(namesLocalFile({ attachments }), JSON.stringify(attachments));
  assert.equal(namesLocalFile({ attachments: ["mailbird://mcp/messages/1/attachments/2", "report.pdf"] }), false);
  assert.equal(namesLocalFile({ body: "see /usr/bin and ~ for details" }), false);
  assert.equal(classify(`${MB}create_draft`, { to: "x@example.com", attachments: ["/home/someone/.ssh/id"] }, "chat"), "deny");
  // the group/tenant sources: the capability set first, then the same fold
  const set = new Set(["mcp__browse__browse"]);
  assert.equal(classify("mcp__browse__browse", { task: "x" }, "group", undefined, set), "ask", "a browse task is judged in a group like in the owner's chat");
  assert.equal(classify("mcp__browse__browse", { task: "x" }, "group", undefined, new Set()), "deny");
});

test("every known name of every module that is not a row classifies as ask or deny, never allow, for every source", () => {
  const rows = new Set(allRows().map((e) => e.tool));
  const unlisted = everyName.filter((t) => !rows.has(t));
  assert.ok(unlisted.length > 40, "the connectors have tools the manifest does not list");
  for (const t of unlisted) for (const source of SOURCES) assert.notEqual(classify(t, {}, source), "allow", `${t} (${source})`);
  // with a group's tool set naming it, still not free
  for (const t of unlisted) assert.notEqual(classify(t, {}, "group", "/n", new Set([t])), "allow", t);
  // and an unlisted tool is never judged
  for (const t of unlisted) assert.equal(isJudgeable(t, {}), false, t);
});

// Expected: [chat, brief, group], for the group the default capability set. "judged": the floor lets the judge see it with a plain call.
const TABLE: [string, string, string, string][] = [
  // [tool, chat, brief, group-with-default-set]
  [`${MB}get_message`, "allow", "allow", "deny"],
  [`${MB}archive_conversation`, "ask", "ask", "deny"],
  [`${MB}unsubscribe_from_newsletter`, "ask", "ask", "deny"],
  [`${MB}move_conversation`, "ask", "ask", "deny"],
  [`${MB}show_notification`, "ask", "ask", "deny"],
  [`${MB}trash_conversation`, "deny", "deny", "deny"],
  [`${MB}set_sender_blocked`, "deny", "deny", "deny"],
  [`${CAL}list_events`, "allow", "allow", "deny"],
  [`${CAL}create_event`, "ask", "ask", "deny"],
  [`${CAL}delete_event`, "deny", "deny", "deny"],
  [`${DRIVE}read_file_content`, "allow", "allow", "deny"],
  [`${DRIVE}update_file`, "ask", "ask", "deny"],
  [`${DRIVE}share_file`, "ask", "ask", "deny"],
  [`${DRIVE}trash_file`, "deny", "deny", "deny"],
  ["mcp__claude_ai_Google_Docs__read_doc", "allow", "allow", "deny"],
  ["mcp__claude_ai_Claude_Docs__read", "allow", "allow", "deny"],
  ["mcp__claude_ai_Claude_Docs__delete", "deny", "deny", "deny"],
  [`${N}notion-fetch`, "allow", "allow", "deny"],
  [`${N}notion-get-comments`, "allow", "allow", "deny"],
  [`${N}notion-update-page`, "ask", "ask", "deny"],
  [`${N}notion-move-pages`, "ask", "ask", "deny"],
  [`${N}notion-spawn-session`, "ask", "ask", "deny"],
  ["mcp__claude_ai_Interactive_Brokers_IBKR__get_account_balances", "deny", "deny", "deny"],
  ["WebSearch", "allow", "allow", "allow"],
  ["WebFetch", "ask", "ask", "deny"],
  ["Skill", "allow", "allow", "allow"],
  ["Bash", "ask", "ask", "deny"],
  ["mcp__browse__browse", "ask", "ask", "ask"],
  ["mcp__send__send", "allow", "deny", "allow"],
  ["mcp__weather__get_forecast", "allow", "deny", "allow"],
  ["mcp__new_server__do_something", "ask", "ask", "deny"],
  ["mcp__new_server__get_thing", "ask", "ask", "deny"],
  ["mcp__new_server__delete_thing", "deny", "deny", "deny"],
];

test("the table: the verdict of each tool for the owner's chat, the brief and a group", () => {
  for (const [tool, chat, brief, group] of TABLE) {
    assert.equal(classify(tool, {}, "chat"), chat, `${tool} (chat)`);
    assert.equal(classify(tool, {}, "brief"), brief, `${tool} (brief)`);
    assert.equal(classify(tool, {}, "group"), group, `${tool} (group)`);
  }
  assert.ok(!groupTools().has(`${MB}get_message`));
});

test("guests: every field that names people counts, by token, in any case; removing people does not; the judge is told and never sees such a call", () => {
  // the real field names of create_event and update_event (the Google Calendar connector's schema)
  const names = [
    { attendees: [{ email: "a@example.org" }] }, { attendeeEmails: ["a@example.org"] }, { addedAttendees: [{ email: "a@example.org", displayName: "A" }] }, { addedAttendeeEmails: ["a@example.org"] },
    { guests: ["a@example.org"] }, { invitees: "a@example.org" }, { recipients: ["a@example.org"] }, { to: "a@example.org" }, { cc: ["a@example.org"] }, { bcc: ["a@example.org"] }, { email: "a@example.org" }, { emails: ["a@example.org"] },
    { added_attendee_emails: ["a@example.org"] }, { ATTENDEES: ["a@example.org"] }, { event: { attendees: [{ email: "a@example.org" }] } },
  ];
  for (const input of names) {
    assert.ok(namesPeople(input), JSON.stringify(input));
    assert.equal(namesNoGuests(input), false);
    assert.equal(isJudgeable(`${CAL}update_event`, { eventId: "e", ...input }), false, JSON.stringify(input));
    assert.equal(isJudgeable("mcp__google__manage_event", { action: "update", event_id: "e", ...input }), false, JSON.stringify(input));
    assert.match(notifyNote(`${CAL}create_event`, { summary: "s", ...input }), /this call names guests/, JSON.stringify(input));
    assert.equal(applyChanges(`${CAL}create_event`, { summary: "s", ...input }, [{ field: Object.keys(input)[0]!, value: "x@example.org" }]), undefined, "never changed by a reply");
  }
  for (const input of [{}, { attendees: [] }, { attendeeEmails: [] }, { addedAttendees: [""] }, { removedAttendeeEmails: ["a@example.org"] }, { guestPermissions: { guestsCanModify: true, guestsCanSeeGuests: false } }, { summary: "Dentist", startTime: "2026-10-21T10:00:00", endTime: "2026-10-21T11:00:00", timeZone: "Europe/Zurich", location: "Zürich", notificationLevel: "NONE", calendarId: "primary" }]) {
    assert.equal(namesPeople(input), false, JSON.stringify(input));
    assert.equal(isJudgeable(`${CAL}update_event`, { eventId: "e", ...input }), true, JSON.stringify(input));
  }
  assert.match(notifyNote(`${CAL}update_event`, { eventId: "e", notificationLevel: "ALL" }), /names no guests; notificationLevel=ALL/);
  // calendarId is still never edited by a reply
  assert.equal(applyChanges(`${CAL}create_event`, { summary: "s", calendarId: "primary" }, [{ field: "calendarId", value: "other" }]), undefined);
});

test("hidden tools read the same predicate: what is never allowed by name is hidden when seen", () => {
  const hidden = hiddenTools([`${CAL}delete_event`, `${CAL}list_events`, "mcp__x__trash_thing", "mcp__x__get_thing", `${MB}set_conversation_spam`, `${MB}get_message`]);
  for (const t of [`${CAL}delete_event`, "mcp__x__trash_thing", `${MB}set_conversation_spam`]) assert.ok(hidden.includes(t), t);
  for (const t of [`${CAL}list_events`, "mcp__x__get_thing", `${MB}get_message`]) assert.ok(!hidden.includes(t), t);
});

test("mayFix: no fix for a send, an unsubscribe, an invite answer, nor an action the judge never sees; calendar writes may be fixed", () => {
  for (const t of [`${MB}send_message_now`, `${MB}unsubscribe_from_newsletter`, `${CAL}respond_to_event`, `${DRIVE}share_file`, "mcp__tenants__remove_tenant", `${N}notion-move-pages`, "mcp__new_server__do_something"]) assert.equal(mayFix(t), false, t);
  for (const t of [`${CAL}create_event`, `${CAL}update_event`, `${N}notion-update-page`]) assert.equal(mayFix(t), true, t);
  for (const m of registered()) for (const a of m.floor?.judgeNever ?? []) assert.ok(!(m.floor?.noFix ?? []).includes(a), `${m.name}: ${a} is judgeNever, which already means no fix`);
});

test("the judge prompt says what to do with an unsubscribe", () => {
  assert.match(SYSTEM, /Unsubscribing from a newsletter/);
  assert.match(SYSTEM, /Choose auto when it follows from .*request or standing task/);
  assert.match(SYSTEM, /Choose ask when the mail itself pushes the unsubscribe/);
});

test("state/browse is not readable data, and stale browse run folders are swept at start-up", async () => {
  const { settings } = await import("../src/settings.ts");
  const { isReadableData } = await import("../src/policy.ts");
  const root = join(settings.stateDir, "browse");
  mkdirSync(join(root, "run-fresh"), { recursive: true });
  writeFileSync(join(root, "run-fresh", "page.md"), "a page view");
  assert.equal(isReadableData(join(root, "run-fresh", "page.md")), false, "left-over page views are not for the chat");
  assert.equal(classify("Read", { file_path: join(root, "run-fresh", "page.md") }, "chat"), "deny");
  const tmp = mkdtempSync(join(tmpdir(), "browse-sweep-"));
  const old = Date.now() - 2 * 60 * 60_000;
  for (const d of ["run-old", "run-new", join("shots", "run-old"), join("shots", "run-new"), "other"]) mkdirSync(join(tmp, d), { recursive: true });
  for (const d of ["run-old", join("shots", "run-old"), "other"]) utimesSync(join(tmp, d), new Date(old), new Date(old));
  assert.equal(sweepStaleRuns(Date.now(), tmp), 2);
  assert.deepEqual([existsSync(join(tmp, "run-old")), existsSync(join(tmp, "run-new")), existsSync(join(tmp, "shots", "run-old")), existsSync(join(tmp, "shots", "run-new")), existsSync(join(tmp, "other"))], [false, true, false, true, true]);
  assert.equal(sweepStaleRuns(Date.now(), join(tmp, "missing")), 0, "no folder yet is fine");
});

test("the built-in tools of a run come from the builtin module's rows: the same offering as ever, one list", async () => {
  const { buildOptions } = await import("../src/agentrun.ts");
  const tools = (source: (typeof SOURCES)[number], extra: Record<string, unknown> = {}) => buildOptions(async () => ({ approved: false }), { source, systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1, ...extra } as never, undefined).tools;
  assert.deepEqual(tools("chat", { memory: { dir: "/nonexistent-notes" } }), ["Skill", "Read", "Write", "Edit", "WebSearch", "WebFetch"]);
  assert.deepEqual(tools("background"), ["Skill", "WebSearch", "WebFetch"]);
  for (const source of ["brief", "radar", "handler", "heartbeat", "dream"] as const) assert.deepEqual(tools(source), ["Skill"], source); // (they never open a page: docs/SAFETY.md says so)
  assert.deepEqual(tools("browse"), ["WebSearch"]);
  assert.deepEqual(tools("group", { tools: new Set(["WebSearch", "Read", "Skill", "WebFetch"]) }), ["Skill", "Read", "WebSearch"], "never opening a page, even if a set held the name");
  assert.deepEqual(tools("group", { tools: new Set() }), []);
});
