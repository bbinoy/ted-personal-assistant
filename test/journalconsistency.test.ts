import { test } from "node:test";
import assert from "node:assert/strict";
import * as approvals from "../src/approvals/approvals.ts";
import { forgetArmed } from "../src/core/sinks/journalsink.ts";
import { forgetSeenMail, noteDone, rememberMail } from "../src/approvals/journalrender.ts";
import { exactGuard } from "../src/approvals/pendingexec.ts";
import { flushPending, idle, queueCall, setPendingRuntime } from "../src/approvals/pendingflow.ts";
import { compactFooter } from "../src/approvals/pendingbatch.ts";
import { resetDeclined } from "../src/approvals/declined.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { scopeOf } from "../src/approvals/turnscope.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { readAudit, type AuditEntry } from "../src/core/audit.ts";
import { convIdOfKey, convPaths } from "../src/core/convpaths.ts";
import { ledgerEntries } from "../src/core/messages.ts";
import { settings } from "../src/core/settings.ts";

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
const sourceOf = (key: string) => (key === "owner" ? "chat" : "group");
const judge = (verdict: Verdict) => async () => verdict;
const calendarCall = (title: string) => ({ summary: title, startTime: "2026-10-31T17:10:00", endTime: "2026-10-31T20:00:00", timeZone: "Europe/Zurich" });
let t0 = new Date().toISOString();
const audit = (tool: string, pred: (e: AuditEntry) => boolean = () => true) => readAudit((e) => e.ts >= t0 && e.tool === tool && pred(e));
const reset = () => (forgetArmed(), forgetSeenMail(), resetDeclined(), (t0 = new Date(Date.now() - 1).toISOString()));

function canUse(key: string, o: { approve?: Parameters<typeof makeCanUseTool>[0]; judge?: Parameters<typeof makeCanUseTool>[3]; source?: "chat" | "group" | "background"; friend?: boolean; say?: string; tools?: ReadonlySet<string> } = {}) {
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

test("background: queued, answered 'yes' by number, executed from the inbox: one journal line in the right conversation, 'approval #N, you answered yes'", async () => {
  reset();
  const key = fresh("owner");
  const before = journal(key).length;
  const input = calendarCall("Team lunch");
  const tool = `${CAL}create_event`;
  const executed: string[] = [];
  setPendingRuntime({
    send: async () => 5001,
    holding: () => false,
    now: () => new Date(),
    // the follow-up run (run/pendingrun.ts): the real permission layer with the exact guard, then the tool "succeeds"
    execute: async (scope, item) => {
      const can = makeCanUseTool(async () => ({ approved: false }), "background", undefined, undefined, exactGuard(item, "background"), undefined, false, { provenance: () => ({ kind: "standing", task: "approved action" }), conversation: scope });
      const r = (await can(item.tool, item.input, opts)) as Out;
      if (r.behavior === "allow") {
        executed.push(item.tool);
        await noteDone({ conv: scope, source: "background", tool: item.tool, input: r.updatedInput ?? item.input, response: "{}" });
      }
      return { ran: r.behavior === "allow", line: "created" };
    },
  });
  const q = queueCall(key, { tool, input, label: "📅 Create Team lunch", question: "Add the team lunch?", footer: compactFooter("📅 Create event"), source: "background" }, new Date());
  assert.ok(q);
  await flushPending(key, { ended: true });
  assert.equal(journal(key).length, before, "queued is not done");
  assert.equal((await approvals.answer("all yes", () => {}, undefined, { judge: async () => undefined, recent: () => [] }, { scope: key })).outcome, "approved");
  await idle();
  setPendingRuntime(undefined);
  assert.deepEqual(executed, [tool]);
  for (const d of ["approval-queued", "approval-queue-approved", "approval-queue-executed"]) assert.equal(audit(tool, (e) => e.decision === d).length, 1, d);
  assert.equal(audit(tool, (e) => e.decision === "allow").length, 1, "the follow-up run's permission layer");
  const lines = journal(key).slice(before);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text, /Why: approval #1, you answered yes\./);
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
