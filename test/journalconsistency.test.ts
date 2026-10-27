import { test } from "node:test";
import assert from "node:assert/strict";
import * as approvals from "../src/approvals/approvals.ts";
import { armedCount, forgetArmed } from "../src/core/sinks/journalsink.ts";
import { endRun } from "../src/core/events.ts";
import { forgetSeenMail, journalable, noteDone, rememberMail } from "../src/approvals/journalrender.ts";
import { resetDeclined } from "../src/approvals/declined.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { scopeOf } from "../src/approvals/turnscope.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { readAudit, type AuditEntry } from "../src/core/audit.ts";
import { convIdOfKey, convPaths } from "../src/core/convpaths.ts";
import { ledgerEntries } from "../src/core/messages.ts";
import { settings } from "../src/core/settings.ts";
import { FRIEND_CHAT, GROUP_CHAT, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

// The consistency guarantee of the event stream (core/events.ts): every decision path of the real permission layer ends in exactly one journal line in the right conversation for a call that
// SUCCEEDED and is not a read, with the audit rows of its decision beside it; a read is audit only; a refusal or a decline leaves no journal line; a friend's audit rows carry no words while
// her journal has them. Fakes stand in for the judge, the approver and the tool itself (the SDK's PostToolUse is `noteDone`, which agentrun.ts calls).

const CAL = "mcp__claude_ai_Google_Calendar__";
const MB = "mcp__mailbird__";
const FORGET = "mcp__memory__forget_note";
const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; updatedInput?: Record<string, unknown> };
(settings as unknown as { autoApprove: string }).autoApprove = "auto";
let seq = 0;
const fresh = (kind: "owner" | "friend" | "group"): string => (kind === "owner" ? "owner" : kind === "friend" ? `tenant:jc${++seq}` : `jc-group-${++seq}`);

const journal = (key: string) => ledgerEntries(convPaths(convIdOfKey(key)).messages).filter((m) => m.kind === "journal");
const sourceOf = (key: string) => (key === "owner" ? OWNER_CHAT : key.startsWith("tenant:") ? FRIEND_CHAT : GROUP_CHAT);
const judge = (verdict: Verdict) => async () => verdict;
const calendarCall = (title: string) => ({ summary: title, startTime: "2026-10-31T17:10:00", endTime: "2026-10-31T20:00:00", timeZone: "Europe/Zurich" });
let t0 = new Date().toISOString();
const audit = (tool: string, pred: (e: AuditEntry) => boolean = () => true) => readAudit((e) => e.ts >= t0 && e.tool === tool && pred(e));
const reset = () => (forgetArmed(), forgetSeenMail(), resetDeclined(), (t0 = new Date(Date.now() - 1).toISOString()));

function canUse(key: string, o: { approve?: Parameters<typeof makeCanUseTool>[0]; judge?: Parameters<typeof makeCanUseTool>[3]; source?: typeof OWNER_CHAT; friend?: boolean; say?: string; tools?: ReadonlySet<string> } = {}) {
  if (o.say) scopeOf(key).say(o.say);
  return makeCanUseTool(o.approve ?? (async () => ({ approved: false })), o.source ?? sourceOf(key), undefined, o.judge, undefined, o.tools, !!o.friend, { provenance: scopeOf(key).read, conversation: key });
}

test("chat allow: a free action that succeeded has one audit row (allow) and one journal line with its why; a read has the audit row only", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  const can = canUse(key, { say: "forget the note about the old gym" });
  const input = { file: "context-old-gym.md" };
  assert.equal(((await can(FORGET, input, opts)) as Out).behavior, "allow");
  await noteDone({ conv: key, source: "chat", tool: FORGET, input, response: "ok" });
  assert.equal(audit(FORGET, (e) => e.decision === "allow").length, 1);
  const lines = journal(key).slice(before);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.cat, "memory");
  assert.match(lines[0]!.text, /^Forgot the note context-old-gym\.md\. Why: your message at \d\d:\d\d\.$/);

  const list = `${MB}list_conversations`;
  assert.equal(((await can(list, { folder: "inbox" }, opts)) as Out).behavior, "allow");
  await noteDone({ conv: key, source: "chat", tool: list, input: { folder: "inbox" }, response: "[]" });
  assert.equal(audit(list, (e) => e.decision === "allow").length, 1, "a read is in the audit log");
  assert.equal(journal(key).length - before, 1, "and not in the journal");
});

test("judge auto-approve: one 'auto-approved' audit row, one journal line that says so and carries the judge's reason", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  const can = canUse(key, { say: "add my flight to the calendar", judge: judge({ decision: "auto", reason: "matches the request" }) });
  const input = calendarCall("Flight LHR-ZRH");
  assert.equal(((await can(`${CAL}create_event`, input, opts)) as Out).behavior, "allow");
  await noteDone({ conv: key, source: "chat", tool: `${CAL}create_event`, input, response: JSON.stringify({ id: "ev-77", summary: "Flight LHR-ZRH" }) });
  assert.equal(audit(`${CAL}create_event`, (e) => e.decision === "auto-approved").length, 1);
  const lines = journal(key).slice(before);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.cat, "calendar");
  assert.match(lines[0]!.text, /^Created calendar event: “Flight LHR-ZRH”, Sat 31 Oct, 17:10–20:00 \(Europe\/Zurich\)\. Why: /);
  assert.match(lines[0]!.text, /Why: your message at \d\d:\d\d; auto-approved by the safety check \(matches the request\)\./);
  assert.match(lines[0]!.text, /Undo: delete that event \(event id ev-77\)\.$/);
});

test("ask approved: one 'ask-approved' row and one journal line that says the person approved it; ask declined: audit rows only, no line", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  const yes = canUse(key, { say: "put the dentist in", judge: judge({ decision: "ask", reason: "unsure" }), approve: async () => ({ approved: true }) });
  const input = calendarCall("Dentist");
  assert.equal(((await yes(`${CAL}create_event`, input, opts)) as Out).behavior, "allow");
  await noteDone({ conv: key, source: "chat", tool: `${CAL}create_event`, input, response: "{}" });
  assert.equal(audit(`${CAL}create_event`, (e) => e.decision === "ask-approved").length, 1);
  const lines = journal(key).slice(before);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text, /Why: your message at \d\d:\d\d; you approved it when asked\./);

  const no = canUse(key, { say: "and the haircut", judge: judge({ decision: "ask", reason: "unsure" }), approve: async () => ({ approved: false }) });
  const other = calendarCall("Haircut");
  assert.equal(((await no(`${CAL}create_event`, other, opts)) as Out).behavior, "deny");
  assert.equal(audit(`${CAL}create_event`, (e) => e.decision === "ask-declined").length, 1);
  assert.equal(journal(key).length - before, 1, "a declined call did not happen: no line");
});

test("deny: the policy refuses it, the audit row says so, the journal has nothing", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  const can = canUse(key, { say: "empty the trash" });
  assert.equal(((await can(`${MB}trash_conversation`, { conversationId: "c-1" }, opts)) as Out).behavior, "deny");
  assert.equal(audit(`${MB}trash_conversation`, (e) => e.decision.startsWith("deny-")).length, 1);
  assert.equal(journal(key).length, before);
});

test("an allowed call that never succeeds leaves the audit row and no journal line; a success reported twice is still told once per allowed call", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  const can = canUse(key, { say: "forget old things" });
  await can(FORGET, { file: "a.md" }, opts);
  assert.equal(journal(key).length, before, "allowed is not done");
  await noteDone({ conv: key, source: "chat", tool: FORGET, input: { file: "a.md" } });
  assert.equal(journal(key).length - before, 1);
});

test("a question nobody answers lapses SILENTLY: nothing more is said in the chat, one journal line in that conversation and an approval-expired audit row", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  const tool = `${CAL}create_event`;
  const said: string[] = [];
  const d = await approvals.request(async (t) => (said.push(t), 6001), "📅 Create Team lunch\nWhen: Fri", { tool, input: calendarCall("Team lunch") }, undefined, { scope: key, source: "chat", question: "Add the team lunch?", minutes: 0.001 });
  assert.equal(d.approved, false);
  assert.equal(d.expired, true);
  assert.deepEqual(said, ["Add the team lunch?"], "only the question itself: no expiry line in the chat");
  const lines = journal(key).slice(before);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text, /^Asked about 📅 Create Team lunch; no answer within 0 min, so nothing was done\./);
  assert.equal(audit(tool, (e) => e.decision === "approval-expired").length, 1);
});

test("a friend: her audit rows carry no words, her journal line (in HER log, not the owner's) has them", async () => {
  reset();
  const key = fresh("friend");
  const owner = journal("owner").length;
  const can = canUse(key, { friend: true, tools: new Set(["mcp__google__manage_event"]), say: "add my flight to my calendar", judge: judge({ decision: "auto", reason: "matches her request for the flight" }) });
  const tool = "mcp__google__manage_event"; // her own Google Calendar
  const input = { action: "create", summary: "Flight to Lisbon", start_time: "2026-10-31T17:10:00", end_time: "2026-10-31T20:00:00" };
  assert.equal(((await can(tool, input, opts)) as Out).behavior, "allow");
  await noteDone({ conv: key, source: "group", tool, input, response: "{}" });
  const row = audit(tool, (e) => e.decision === "auto-approved")[0]!;
  assert.equal(row.meta?.reason, undefined, "no words in the admin's log");
  assert.equal(typeof row.meta?.reasonChars, "number");
  assert.doesNotMatch(JSON.stringify(readAudit((e) => e.ts >= t0)), /Lisbon|her request/);
  const lines = journal(key);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text, /Flight to Lisbon/);
  assert.match(lines[0]!.text, /matches her request for the flight/);
  assert.match(lines[0]!.text, /Why: your message at \d\d:\d\d; auto-approved/);
  assert.equal(journal("owner").length, owner, "nothing of hers in the owner's log");
});

test("a group: its action goes in the group's own log", async () => {
  reset();
  const key = fresh("group");
  const can = canUse(key, { say: "forget the old booking" });
  assert.equal(((await can(FORGET, { file: "context-booking.md" }, opts)) as Out).behavior, "allow");
  await noteDone({ conv: key, source: "group", tool: FORGET, input: { file: "context-booking.md" } });
  const lines = journal(key);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text, /Why: a message in this group at \d\d:\d\d\./);
  assert.ok(convPaths(convIdOfKey(key)).messages.includes("group-"), "the group's folder");
});

test("an archive names the mail the run had seen and says how to undo it", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  rememberMail(key, JSON.stringify({ conversations: [{ conversationId: "c-9001", subject: "LinkedIn digest: 5 jobs", from: { name: "LinkedIn" } }, { conversationId: "c-9002", subject: "Invoice 4411", sender: "Digitec" }] }));
  const tool = `${MB}archive_conversation`;
  const can = canUse(key, { say: "archive the newsletters", judge: judge({ decision: "auto", reason: "a newsletter, archived on request" }) });
  assert.equal(((await can(tool, { conversationId: "c-9001" }, opts)) as Out).behavior, "allow");
  await noteDone({ conv: key, source: "chat", tool, input: { conversationId: "c-9001" } });
  const lines = journal(key).slice(before);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.cat, "archive");
  assert.match(lines[0]!.text, /^Archived “LinkedIn digest: 5 jobs” from LinkedIn\. Why: /);
  assert.match(lines[0]!.text, /Undo: npm run restore c-9001, or say 'restore that'\.$/);
});

test("an archive names the sender of a Mailbird list row (`lastSender`), so the brief's list is not 'unknown sender'", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  rememberMail(key, JSON.stringify({ conversations: [{ conversationId: "c-7001", subject: "Your order shipped", lastSender: "Shop Example", lastMessageId: "m-1" }] }));
  const tool = `${MB}archive_conversation`;
  await noteDone({ conv: key, source: "background", tool, input: { conversationId: "c-7001" } });
  assert.match(journal(key).slice(before)[0]!.text, /^Archived “Your order shipped” from Shop Example\. /);
});

test("a look that read notes before acting says so: 'per your notes' in reading order, at most three names, inferred ones marked; one that read none keeps the generic line", async () => {
  reset();
  const key = fresh("owner");
  const tool = `${MB}archive_conversation`;
  const seen: { file: string; inferred: boolean }[] = [];
  const generic = makeCanUseTool(async () => ({ approved: false }), OWNER_LOOK, undefined, judge({ decision: "auto", reason: "routine" }), undefined, undefined, false, { provenance: () => ({ kind: "standing", task: "look" }), conversation: key, notesSeen: () => seen });
  const before = journal(key).length;
  await generic(tool, { conversationId: "n-1" }, opts);
  await noteDone({ conv: key, source: "background", tool, input: { conversationId: "n-1" } });
  seen.push({ file: "triage-linkedin", inferred: false }, { file: "people-eve", inferred: true }, { file: "triage-newsletters", inferred: false }, { file: "context-trip", inferred: false });
  await generic(tool, { conversationId: "n-2" }, opts);
  await noteDone({ conv: key, source: "background", tool, input: { conversationId: "n-2" } });
  const lines = journal(key).slice(before);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!.text, /Why: a periodic look at your accounts, on its standing instructions; auto-approved/);
  assert.doesNotMatch(lines[0]!.text, /per your notes/);
  assert.match(lines[1]!.text, /; per your notes: triage-linkedin, people-eve \(inferred\), triage-newsletters and 1 more\./);
});

test("delegations and the SDK's own tools are no actions; plumbing is never armed; a run's why is not used by another run and is dropped when the run ends", async () => {
  reset();
  for (const t of ["Agent", "Task", "TodoWrite", "ToolSearch", "StructuredOutput", "Skill", "mcp__send__send", "mcp__memory__journal", "mcp__memory__search_logs"]) assert.equal(journalable(t), false, t);
  assert.equal(journalable(FORGET), true);
  const key = fresh("owner");
  const before = journal(key).length;
  await noteDone({ conv: key, source: "background", tool: "StructuredOutput", input: { message: "[[silent]]", nextCheckMinutes: 30 } });
  assert.equal(journal(key).length, before, "the run handing in its answer is no 'Ran StructuredOutput' line");
  const mk = (run: string) => makeCanUseTool(async () => ({ approved: false }), OWNER_CHAT, undefined, undefined, undefined, undefined, false, { provenance: () => ({ kind: "owner", message: "forget it" }), conversation: key, run });
  await mk("run-a")("mcp__send__send", { text: "hello" }, opts);
  await mk("run-a")("mcp__memory__journal", {}, opts);
  assert.equal(armedCount(), 0, "plumbing leaves nothing in memory");
  await mk("run-a")(FORGET, { file: "a.md" }, opts);
  assert.equal(armedCount(), 1);
  await noteDone({ conv: key, run: "run-b", source: "chat", tool: FORGET, input: { file: "a.md" } });
  assert.match(journal(key).at(-1)!.text, /Why: no reason was recorded/, "another run's why is not attached");
  endRun("run-a");
  assert.equal(armedCount(), 0, "dropped when its run ends");
  await noteDone({ conv: key, run: "run-a", source: "chat", tool: FORGET, input: { file: "a.md" } });
  assert.match(journal(key).at(-1)!.text, /Why: no reason was recorded/);
  assert.equal(journal(key).length - before, 2);
});

test("a why that cannot be worked out (a bad time) never fails the permission decision: the call is allowed, audited, and journalled with no reason", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  scopeOf(key).say("forget the old gym");
  (scopeOf(key) as unknown as { lastSaidAt: () => number }).lastSaidAt = () => Number.POSITIVE_INFINITY; // an invalid instant: the clock formatting throws RangeError
  const can = canUse(key);
  assert.equal(((await can(FORGET, { file: "gym.md" }, opts)) as Out).behavior, "allow");
  assert.ok(audit(FORGET, (e) => e.decision === "allow").length >= 1, "the allow row was written");
  await noteDone({ conv: key, source: "chat", tool: FORGET, input: { file: "gym.md" } });
  assert.match(journal(key).slice(before)[0]!.text, /Why: no reason was recorded for this call\.$/);
});
