import { test } from "node:test";
import assert from "node:assert/strict";
import * as approvals from "../src/approvals/approvals.ts";
import { makeApprove } from "../src/approvals/approvalask.ts";
import { createApprovers } from "../src/approvals/approvers.ts";
import { addPending, openItems, splitExpired, sweepExpired, takeExpired, type Pending } from "../src/approvals/pending.ts";
import { ANSWER_HINT, compactFooter, expiryLine, renderBatch, renderList } from "../src/approvals/pendingbatch.ts";
import { exactGuard, outcomeOf, pendingPrompt } from "../src/approvals/pendingexec.ts";
import { answerPending, clearText, flushPending, idle, listText, queueCall, setPendingRuntime, type PendingRuntime } from "../src/approvals/pendingflow.ts";
import { parseNumbered } from "../src/approvals/pendingparse.ts";
import { declinedAgo, resetDeclined } from "../src/approvals/declined.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { settings } from "../src/core/settings.ts";
import { readAudit } from "../src/core/audit.ts";
import { commandReply, parseCommand } from "../src/conversation/ownercommands.ts";
import { runPending } from "../src/run/pendingrun.ts";
import { owner } from "../src/conversation/conversation.ts";
import { convIdOfKey, convPaths, groupConvId, OWNER_CONV } from "../src/core/convpaths.ts";
import { closeConvDb, convDb } from "../src/core/convdb.ts";

// The approval inbox: what an unattended run needed a yes for is parked (never waited on), asked as one numbered batch, answered by number in code, and run EXACTLY as recorded.
// Fake values only.

const SEND = "mcp__gmail__reply";
const MAIL = { to: "rebecca@example.com", body: "Thursday works" };
const NOW = new Date(2026, 9, 14, 14, 0, 0);
let seq = 0;
const scopeName = () => `tenant:inbox${++seq}`; // a conversation of its own per test: the files are per conversation

interface Rig {
  scope: string;
  sent: { text: string; ts: number }[];
  held: { text: string; urgent: boolean }[];
  ran: { n: number; tool: string; input: Record<string, unknown> }[];
  night: boolean;
  now: Date;
  result: { ran: boolean; line: string };
}
function rig(): Rig {
  const r: Rig = { scope: scopeName(), sent: [], held: [], ran: [], night: false, now: NOW, result: { ran: true, line: "replied to Rebecca" } };
  let ts = 9000;
  const rt: PendingRuntime = {
    send: async (_s, text) => (r.sent.push({ text, ts: ++ts }), ts),
    holding: () => r.night,
    execute: async (_s, item) => (r.ran.push({ n: item.n, tool: item.tool, input: item.input }), r.result),
    now: () => r.now,
  };
  setPendingRuntime(rt);
  return r;
}
const park = (r: Rig, label: string, input: Record<string, unknown> = MAIL, o: { tool?: string; urgent?: boolean } = {}) =>
  queueCall(r.scope, { tool: o.tool ?? SEND, input, label, question: `Send this to ${label}?`, footer: compactFooter(`✉️ Reply\nTo: ${label}\n\nhello`), source: "background", urgent: o.urgent }, r.now)!;
const answerIn = (r: Rig, text: string, quote?: { timestamp: number }) => approvals.answer(text, () => {}, quote, { judge: async () => undefined, recent: () => [] }, { scope: r.scope });

// ---- the parser ----

test("parseNumbered: numbered answers are read in code", () => {
  const open = [1, 2, 3];
  const ans = (t: string) => parseNumbered(t, open);
  assert.deepEqual(ans("1,3 yes"), { kind: "answer", yes: [1, 3], no: [] });
  assert.deepEqual(ans("all yes"), { kind: "answer", yes: [1, 2, 3], no: [] });
  assert.deepEqual(ans("yes all"), { kind: "answer", yes: [1, 2, 3], no: [] });
  assert.deepEqual(ans("2 no"), { kind: "answer", yes: [], no: [2] });
  assert.deepEqual(ans("No to 2."), { kind: "answer", yes: [], no: [2] });
  assert.deepEqual(ans("yes to 1 and 3"), { kind: "answer", yes: [1, 3], no: [] });
  assert.deepEqual(ans("1 yes 2 no"), { kind: "answer", yes: [1], no: [2] });
  assert.deepEqual(ans("yes 1, 3 no 2"), { kind: "answer", yes: [1, 3], no: [2] });
  assert.deepEqual(ans("#1 & #2 ok"), { kind: "answer", yes: [1, 2], no: [] });
  assert.deepEqual(ans("1-3 no"), { kind: "answer", yes: [], no: [1, 2, 3] });
  assert.deepEqual(ans("Approve 2!"), { kind: "answer", yes: [2], no: [] });
  assert.deepEqual(ans("all no"), { kind: "answer", yes: [], no: [1, 2, 3] });
});

test("parseNumbered: a message with other words, or with no verb, is just a message", () => {
  for (const t of ["2 no wait, what about Thursday", "I have 3 meetings", "3", "1,2,3", "call me at 5", "yes but not Bob", "hello", "", "  "]) assert.equal(parseNumbered(t, [1, 2, 3]).kind, "none", t);
});

test("parseNumbered: a lone yes / no is bare (the caller decides: only a quote of the batch gives it meaning)", () => {
  assert.deepEqual(parseNumbered("yes", [1]), { kind: "bare", yes: true });
  assert.deepEqual(parseNumbered("ok", [1, 2]), { kind: "bare", yes: true });
  assert.deepEqual(parseNumbered("No.", [1]), { kind: "bare", yes: false });
});

test("parseNumbered: ambiguity resolves nothing and is clarified", () => {
  for (const t of ["1 yes 2", "1 yes no", "yes no 1", "1 yes 1 no", "5 yes", "1,5 yes", "yes 1 2 no", "all yes 2 no", "all 2 yes", "0 yes"]) {
    const p = parseNumbered(t, [1, 2, 3]);
    assert.equal(p.kind, "clarify", `${t} -> ${JSON.stringify(p)}`);
  }
  const unknown = parseNumbered("5 yes", [1, 2]);
  assert.match(unknown.kind === "clarify" ? unknown.why : "", /no #5/);
});

// ---- the texts ----

test("renderBatch: a header, a numbered entry per item with its code label and footer, then the hint", () => {
  const items = [
    { n: 1, label: "✉️ Reply to Rebecca", question: "Reply to Rebecca that Thursday works?", footer: "To: rebecca@example.com · Text: “hello”" },
    { n: 3, label: "📅 Create Dentist", question: "Add the dentist on Friday?", footer: "" },
  ] as Pending[];
  const text = renderBatch(items);
  const lines = text.split("\n");
  assert.equal(lines[0], "📬 2 things are waiting for your approval:");
  assert.equal(lines[1], "1. ✉️ Reply to Rebecca Reply to Rebecca that Thursday works?");
  assert.equal(lines[2], "   ↳ To: rebecca@example.com · Text: “hello”");
  assert.equal(lines[3], "3. 📅 Create Dentist Add the dentist on Friday?");
  assert.equal(lines.at(-1), ANSWER_HINT);
  assert.equal(ANSWER_HINT, "Reply e.g. '1,3 yes', 'all yes', '2 no', or reply to this message.");
  assert.match(renderBatch([items[0]!]), /^📬 1 thing is waiting/);
});

test("compactFooter keeps the recipients and the start of the text on one line", () => {
  const f = compactFooter("✉️ Reply to Rebecca\nTo: rebecca@example.com\nCc: bob@example.com\n\nSee you Thursday");
  assert.match(f, /^To: rebecca@example\.com · Cc: bob@example\.com · Text: “See you Thursday”$/);
  assert.equal(compactFooter("📅 Create event"), "");
});

test("expiryLine and renderList are short and use code labels only", () => {
  assert.equal(expiryLine([{ n: 2, label: "✉️ Reply to Rebecca" }], 3), "⏳ Dropped, not answered in 3 days: #2 ✉️ Reply to Rebecca.");
  assert.match(expiryLine([1, 2, 3, 4, 5, 6].map((n) => ({ n, label: "x" })), 1), /in 1 day: .*\(\+2 more\)\.$/);
  const list = renderList([{ n: 4, label: "✉️ Reply", question: "Reply?", footer: "", createdAt: NOW.getTime() - 3 * 3_600_000 }] as Pending[], NOW.getTime());
  assert.match(list, /^Waiting for your approval \(1\):\n4\. ✉️ Reply \(3 h\) Reply\?/);
  assert.match(list, /1,3 yes.*\/approvals clear/s);
  assert.equal(renderList([], NOW.getTime()), "Nothing is waiting for your approval.");
});

// ---- the state ----

test("pending actions persist in the conversation's database, keep stable numbers that are never reused, and park the same call once", () => {
  const scope = scopeName();
  const a = addPending(scope, { tool: SEND, input: { a: 1, b: 2 }, label: "one", question: "q", footer: "", source: "background" }, 1000);
  const b = addPending(scope, { tool: SEND, input: { b: 2, a: 1 }, label: "one", question: "q", footer: "", source: "background" }, 2000); // the same call, key order aside
  const c = addPending(scope, { tool: SEND, input: { a: 3 }, label: "three", question: "q", footer: "", source: "background" }, 3000);
  assert.deepEqual([a, b, c], [{ n: 1, duplicate: false }, { n: 1, duplicate: true }, { n: 2, duplicate: false }]);
  // a restart: nothing but the database is kept (the connection is closed, the file opened again)
  closeConvDb(convIdOfKey(scope));
  assert.equal(convDb(convIdOfKey(scope)).num("SELECT COUNT(*) FROM pending_items"), 2);
  assert.equal(convDb(convIdOfKey(scope)).num("SELECT next FROM pending_state"), 3);
  assert.deepEqual(openItems(scope).map((p) => [p.n, p.tool, p.input]), [[1, SEND, { a: 1, b: 2 }], [2, SEND, { a: 3 }]]);
  clearText(scope);
  const d = addPending(scope, { tool: SEND, input: { a: 1, b: 2 }, label: "again", question: "q", footer: "", source: "background" }, 4000);
  assert.deepEqual(d, { n: 3, duplicate: false }, "a number is never reused");
  assert.notEqual(convPaths(convIdOfKey("owner")).db, convPaths(convIdOfKey(scope)).db, "one database per conversation");
});

test("splitExpired is pure; an expired item is dropped and told once, never silently", async () => {
  const day = 86_400_000;
  const items = [{ n: 1, createdAt: 0 }, { n: 2, createdAt: 2 * day }] as Pending[];
  assert.deepEqual(splitExpired(items, 3 * day, 3).dropped.map((p) => p.n), [1]);
  assert.equal(settings.pendingActionDays, 3);

  const r = rig();
  park(r, "old one");
  r.now = new Date(NOW.getTime() + 3 * day + 1000);
  assert.equal(sweepExpired(r.scope, r.now.getTime()).length, 1);
  assert.deepEqual(openItems(r.scope), []);
  assert.equal(takeExpired(r.scope).length, 1);
  assert.equal(takeExpired(r.scope).length, 0, "told once");

  const r2 = rig();
  park(r2, "stale mail");
  r2.now = new Date(NOW.getTime() + 4 * day);
  assert.equal(await flushPending(r2.scope, { ended: true }), "none");
  assert.deepEqual(r2.sent.map((m) => m.text), ["⏳ Dropped, not answered in 3 days: #1 stale mail."]);
  assert.ok(readAudit((e) => e.decision === "approval-expired").length > 0);
});

// ---- parking ----

test("a background ask is parked, not waited on: the run gets 'Queued as #N', nothing is sent, and the exact call is recorded", async () => {
  const sent: string[] = [];
  const scope = scopeName();
  const approve = makeApprove(async (t) => (sent.push(t), 1), { scope, source: "background", background: true, queue: true, compose: async () => ({ text: "Reply to Rebecca that Thursday works?", ms: 0 }) });
  const call = { tool: SEND, input: MAIL };
  const d = await approve("✉️ Reply to Rebecca\nTo: rebecca@example.com\n\nThursday works", call, new AbortController().signal, { queueable: true });
  assert.equal(d.approved, false);
  assert.equal(d.queued?.n, 1);
  assert.match(d.queued!.message, /^Queued for .+'s approval as #1; carry on with the rest; do not retry it/);
  assert.deepEqual(sent, [], "no question is sent now: the batch is asked when the look ends");
  const [p] = openItems(scope);
  assert.deepEqual([p!.tool, p!.input, p!.label, p!.question, p!.source, p!.scope], [SEND, MAIL, "✉️ Reply to Rebecca", "Reply to Rebecca that Thursday works?", "background", scope]);
  assert.match(p!.footer, /^To: rebecca@example\.com/);
  const again = await approve("✉️ Reply to Rebecca\nTo: rebecca@example.com\n\nThursday works", call, new AbortController().signal, { queueable: true });
  assert.equal(again.queued?.n, 1, "the same call keeps its number");
  assert.ok(readAudit((e) => e.decision === "approval-queued" && e.tool === SEND).length > 0);
});

test("a guard step, a payment, a foreground ask and a group's background ask are not parked", async () => {
  const mk = (o: Record<string, unknown>) => makeApprove(async () => 5, { scope: scopeName(), source: "background", compose: async () => ({ text: "ok?", ms: 0 }), request: (async () => ({ approved: false })) as never, ...o } as never);
  const call = { tool: SEND, input: MAIL };
  const sig = new AbortController().signal;
  assert.equal((await mk({ background: true, queue: true })("d", call, sig, { queueable: false })).queued, undefined, "a guard step");
  assert.match((await mk({ background: true, queue: true })("d", call, sig, { queueable: true, typedYes: true })).failure ?? "", /card payment/);
  assert.equal((await mk({ background: false, queue: true })("d", call, sig, { queueable: true })).queued, undefined, "foreground");
  assert.equal((await mk({ background: true })("d", call, sig, { queueable: true })).queued, undefined, "no queue for a group");
});

test("the approvers park the owner's and a friend's background asks, and not a group's", async () => {
  const made: Record<string, unknown>[] = [];
  const out = { reply: async () => 1 };
  const approverFor = createApprovers(out, { target: () => "to:anna", make: (_send, o) => (made.push(o as never), (async () => ({ approved: false })) as never) });
  approverFor("owner", { background: true });
  approverFor("owner");
  approverFor("tenant:anna", { background: true });
  approverFor("group-1", { background: true });
  assert.deepEqual(made.map((o) => [o.scope, !!o.background, !!o.queue]), [["owner", true, true], ["owner", false, false], ["tenant:anna", true, true], ["group-1", true, false]]);
});

test("permissions: a parked call is denied back to the run with the queued text and is not remembered as done", async () => {
  const scope = scopeName();
  const approve = makeApprove(async () => 1, { scope, source: "background", background: true, queue: true, compose: async () => ({ text: "Send it?", ms: 0 }) });
  const can = makeCanUseTool(approve, "background", undefined, (async () => ({ decision: "ask", reason: "t" })) as never, undefined, undefined, false, { conversation: scope });
  const opts = { signal: new AbortController().signal } as never;
  const tool = "mcp__claude_ai_Google_Calendar__create_event";
  const r1 = (await can(tool, { summary: "Dentist", startTime: "2026-10-16T10:00:00" }, opts)) as { behavior: string; message?: string };
  assert.equal(r1.behavior, "deny");
  assert.match(r1.message ?? "", /Queued for .+ as #1; carry on/);
  const r2 = (await can(tool, { summary: "Dentist", startTime: "2026-10-16T10:00:00" }, opts)) as { message?: string };
  assert.match(r2.message ?? "", /as #1/, "asking again is the same item, not 'already approved'");
});

// ---- batching ----

test("one look's parked calls go out as ONE numbered message when the look ends; not before, unless the first is old", async () => {
  const r = rig();
  park(r, "Rebecca");
  park(r, "Bob", { to: "bob@example.com" });
  assert.equal(await flushPending(r.scope, { ended: false }), "none", "too young and the look is still running");
  assert.equal(r.sent.length, 0);
  assert.equal(await flushPending(r.scope, { ended: true }), "sent");
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!.text, /^📬 2 things are waiting for your approval:\n1\. Rebecca/);
  assert.match(r.sent[0]!.text, /\n2\. Bob /);
  assert.equal(await flushPending(r.scope, { ended: true }), "none", "asked once");
  park(r, "Carol", { to: "carol@example.com" });
  r.now = new Date(r.now.getTime() + 6 * 60_000);
  assert.equal(await flushPending(r.scope, { ended: false }), "sent", "the first one is older than a few minutes");
  assert.match(r.sent[1]!.text, /^📬 1 thing is waiting for your approval:\n3\. Carol/);
});

test("quiet hours: the batch waits in the inbox and goes out as its own message, from the current items, when quiet ends; an urgent item breaks it", async () => {
  const r = rig();
  r.night = true;
  park(r, "Rebecca");
  park(r, "Bob", { to: "bob@example.com" });
  assert.equal(await flushPending(r.scope, { ended: true }), "held");
  assert.equal(r.sent.length, 0);
  assert.equal(openItems(r.scope).every((p) => p.deferred && !p.sent), true);
  // the owner writes meanwhile and settles one: nothing is dropped as stale, and the resolved one vanishes from the batch
  const early = await answerIn(r, "2 no");
  assert.deepEqual([early.outcome, early.reply], ["clarify", "#2 hasn't been shown to you yet. Nothing was done."]);
  park(r, "Carol", { to: "carol@example.com" });
  assert.equal(await flushPending(r.scope, { ended: false }), "held", "the tick at night: still held");
  r.night = false;
  assert.equal(await flushPending(r.scope, { ended: false }), "sent", "the tick after quiet: asked at once, however young");
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!.text, /^📬 3 things are waiting for your approval:\n1\. Rebecca [^\n]*\n   ↳ [^\n]*\n2\. Bob [^\n]*\n   ↳ [^\n]*\n3\. Carol /);
  assert.deepEqual(openItems(r.scope).map((p) => p.sent?.ts), [r.sent[0]!.ts, r.sent[0]!.ts, r.sent[0]!.ts], "its timestamp is kept: a quote of it answers");
  assert.equal((await answerIn(r, "yes", { timestamp: r.sent[0]!.ts })).outcome, "clarify", "two open items of that batch: which one?");
  r.night = true;
  park(r, "Urgent one", { to: "x@example.com" }, { urgent: true });
  assert.equal(await flushPending(r.scope, { ended: true }), "sent", "urgent breaks the quiet");
  assert.match(r.sent[1]!.text, /4\. Urgent one/);
});

// ---- answering ----

test("'1,3 yes' runs exactly items 1 and 3 as recorded, '2 no' drops 2 for good, and the results are reported", async () => {
  resetDeclined();
  const r = rig();
  const one = { to: "a@example.com", body: "one" };
  const two = { to: "b@example.com", body: "two" };
  const three = { to: "c@example.com", body: "three" };
  park(r, "A", one);
  park(r, "B", two);
  park(r, "C", three);
  await flushPending(r.scope, { ended: true });
  const a = await answerIn(r, "1,3 yes");
  assert.equal(a.outcome, "approved");
  assert.match(a.reply ?? "", /On it: #1, #3/);
  await idle();
  assert.deepEqual(r.ran.map((x) => [x.n, x.tool, x.input]), [[1, SEND, one], [3, SEND, three]], "exactly the recorded calls");
  assert.deepEqual(r.sent.slice(1).map((m) => m.text), ["✅ #1 done: replied to Rebecca", "✅ #3 done: replied to Rebecca"]);
  assert.deepEqual(openItems(r.scope).map((p) => p.n), [2]);
  const no = await answerIn(r, "2 no");
  assert.equal(no.outcome, "declined");
  assert.deepEqual(openItems(r.scope), []);
  assert.notEqual(declinedAgo(r.scope, SEND, two, r.now.getTime()), undefined, "a decline is final (declined.ts)");
  assert.equal(r.ran.length, 2, "nothing was run for the no");
  assert.ok(readAudit((e) => e.decision === "approval-queue-approved").length >= 2);
  assert.ok(readAudit((e) => e.decision === "approval-queue-declined").length >= 1);
  assert.ok(readAudit((e) => e.decision === "approval-queue-executed").length >= 2);
});

test("a failed follow-up is reported as failed, with its reason", async () => {
  const r = rig();
  r.result = { ran: false, line: "the draft no longer exists" };
  park(r, "A");
  await flushPending(r.scope, { ended: true });
  assert.equal((await answerIn(r, "all yes")).outcome, "approved");
  await idle();
  assert.equal(r.sent.at(-1)!.text, "⚠️ #1 failed: the draft no longer exists");
  assert.ok(readAudit((e) => e.decision === "approval-queue-failed").length > 0);
});

test("a bare unquoted yes / ok never resolves an item; ambiguity clarifies and resolves nothing", async () => {
  const r = rig();
  park(r, "A");
  park(r, "B", { to: "b@example.com" });
  await flushPending(r.scope, { ended: true });
  for (const t of ["yes", "ok", "sure", "👍"]) assert.equal((await answerIn(r, t)).outcome, "none", t);
  const bad = await answerIn(r, "1 yes 2");
  assert.equal(bad.outcome, "clarify");
  assert.match(bad.reply ?? "", /nothing was done/);
  assert.equal((await answerIn(r, "7 yes")).outcome, "clarify");
  assert.equal((await answerIn(r, "what is on my calendar?")).outcome, "none");
  await idle();
  assert.deepEqual(r.ran, []);
  assert.equal(openItems(r.scope).length, 2);
});

test("a bare yes that quotes the batch resolves the one open item of it, and asks which when there are several", async () => {
  const r = rig();
  park(r, "A");
  await flushPending(r.scope, { ended: true });
  const ts = r.sent[0]!.ts;
  assert.equal((await answerIn(r, "yes", { timestamp: ts })).outcome, "approved");
  await idle();
  assert.equal(r.ran.length, 1);
  park(r, "B", { to: "b@example.com" });
  park(r, "C", { to: "c@example.com" });
  await flushPending(r.scope, { ended: true });
  const ts2 = r.sent.at(-1)!.ts;
  const which = await answerIn(r, "yes", { timestamp: ts2 });
  assert.equal(which.outcome, "clarify");
  assert.equal(r.ran.length, 1);
  assert.equal(openItems(r.scope).length, 2);
});

test("a numbered answer that quotes some other message is about that message", async () => {
  const r = rig();
  park(r, "A");
  await flushPending(r.scope, { ended: true });
  assert.equal(await answerPending("1 yes", { timestamp: 1234 }, { scope: r.scope }), undefined);
  assert.equal(openItems(r.scope).length, 1);
});

test("free words that quote the batch go to the answer model; only a plain yes / no per item counts, and a failing model resolves nothing", async () => {
  const r = rig();
  park(r, "A");
  park(r, "B", { to: "b@example.com" });
  await flushPending(r.scope, { ended: true });
  const ts = r.sent[0]!.ts;
  const seen: unknown[] = [];
  const judge = (async (_t: string, views: unknown[]) => (seen.push(views), { target: "multi", outcome: "multi", answers: [{ target: "A1", outcome: "approve" }, { target: "A2", outcome: "decline" }] })) as never;
  const res = await answerPending("the first one is fine, skip the second", { timestamp: ts }, { scope: r.scope }, { judge, recent: () => [] });
  assert.equal(res?.outcome, "approved");
  await idle();
  assert.deepEqual(r.ran.map((x) => x.n), [1]);
  assert.deepEqual(openItems(r.scope), []);
  assert.equal(seen.length, 1);

  const r2 = rig();
  park(r2, "A");
  await flushPending(r2.scope, { ended: true });
  const unusable = await answerPending("hmm maybe, let me think", { timestamp: r2.sent[0]!.ts }, { scope: r2.scope }, { judge: (async () => undefined) as never, recent: () => [] });
  assert.equal(unusable, undefined, "no usable reading: an ordinary message");
  const other = await answerPending("yes if it is before five", { timestamp: r2.sent[0]!.ts }, { scope: r2.scope }, { judge: (async () => ({ target: "A1", outcome: "other" })) as never, recent: () => [] });
  assert.equal(other?.outcome, "clarify");
  assert.equal(openItems(r2.scope).length, 1);
});

test("another conversation's numbers answer nothing here", async () => {
  const r = rig();
  park(r, "A");
  const other = await approvals.answer("1 yes", () => {}, undefined, { judge: async () => undefined, recent: () => [] }, { scope: "tenant:someone-else" });
  assert.equal(other.outcome, "none");
  assert.equal(openItems(r.scope).length, 1);
});

// ---- exact execution ----

test("the follow-up run's guard allows exactly the recorded call; a different argument, another tool, or any other write is denied", async () => {
  const input = { to: "rebecca@example.com", body: "Thursday works", draftId: "d1" };
  const g = exactGuard({ tool: SEND, input }, "background");
  assert.equal((await g.decide(SEND, { draftId: "d1", body: "Thursday works", to: "rebecca@example.com" })).kind, "allow", "key order aside");
  assert.deepEqual((await g.decide(SEND, input)).input, input);
  const other = await g.decide(SEND, { ...input, to: "mallory@example.com" });
  assert.equal(other.kind, "deny");
  assert.match(other.reason ?? "", /not the approved arguments/);
  assert.equal((await g.decide(SEND, { ...input, body: "Thursday works!" })).kind, "deny");
  assert.equal((await g.decide("mcp__gmail__forward", input)).kind, "deny");
  assert.equal((await g.decide("mcp__claude_ai_Google_Calendar__delete_event", { eventId: "e" })).kind, "deny");
  assert.equal((await g.decide("mcp__claude_ai_Google_Calendar__list_events", {})).kind, "defer", "a read is as always");
  assert.equal(g.matches(SEND, input), true);
  assert.equal(g.matches(SEND, { ...input, to: "x" }), false);
});

test("through the real permission layer: the recorded call runs without a question, a different argument is refused", async () => {
  const tool = "mcp__claude_ai_Google_Calendar__create_event";
  const input = { summary: "Dentist", startTime: "2026-10-16T10:00:00", endTime: "2026-10-16T11:00:00" };
  const asked: unknown[] = [];
  const can = makeCanUseTool((async (...a: unknown[]) => (asked.push(a), { approved: false })) as never, "background", undefined, undefined, exactGuard({ tool, input }, "background"));
  const opts = { signal: new AbortController().signal } as never;
  const ok = (await can(tool, input, opts)) as { behavior: string; updatedInput?: unknown };
  assert.equal(ok.behavior, "allow");
  assert.deepEqual(ok.updatedInput, input);
  const bad = (await can(tool, { ...input, startTime: "2026-10-17T10:00:00" }, opts)) as { behavior: string };
  assert.equal(bad.behavior, "deny");
  const worse = (await can("mcp__claude_ai_Google_Calendar__delete_event", { eventId: "e1" }, opts)) as { behavior: string };
  assert.equal(worse.behavior, "deny");
  assert.deepEqual(asked, [], "nobody is asked: the owner already said yes to exactly this");
});

test("runPending: code decides it ran; the model's line only words it; a refusal to run is reported without a run", async () => {
  const item = { n: 4, tool: SEND, input: MAIL, scope: "owner", source: "background", label: "x", question: "q", footer: "", createdAt: 0 } as Pending;
  const conv = owner();
  const payer = { kind: "login" } as never;
  let opts: any;
  const ranIt = await runPending(conv, item, () => payer, { run: async (_prompt, o) => ((opts = o), o.onToolSuccess!(SEND, MAIL), { text: "DONE: replied to Rebecca", costUsd: 0 }) });
  assert.deepEqual(ranIt, { ran: true, line: "replied to Rebecca" });
  assert.equal(opts.experts, undefined);
  assert.equal(opts.notesRead, undefined);
  assert.ok(opts.callGuard, "the exact guard is installed");
  assert.equal((await opts.callGuard.decide(SEND, { ...MAIL, to: "evil@example.com" })).kind, "deny");
  const notRun = await runPending(conv, item, () => payer, { run: async () => ({ text: "FAILED: the draft no longer exists", costUsd: 0 }) });
  assert.deepEqual(notRun, { ran: false, line: "the draft no longer exists" });
  const lying = await runPending(conv, item, () => payer, { run: async () => ({ text: "DONE: sent it", costUsd: 0 }) });
  assert.deepEqual(lying, { ran: false, line: "the call was not made" }, "a claim of success without the call is not a success");
  const threw = await runPending(conv, item, () => payer, { run: async () => Promise.reject(new Error("boom")) });
  assert.equal(threw.ran, false);
  const refused = await runPending(conv, item, () => ({ refused: "paused" }), { run: async () => assert.fail("must not run") });
  assert.equal(refused.ran, false);
  assert.match(refused.line, /paused/);
});

test("the fixed prompt carries the exact call as fenced data and asks for one line; outcomeOf reads the line", () => {
  const p = pendingPrompt({ tool: SEND, input: MAIL });
  assert.match(p, /tool: mcp__gmail__reply/);
  assert.match(p, /<approved_arguments>\n\{"to":"rebecca@example\.com","body":"Thursday works"\}\n<\/approved_arguments>/);
  assert.match(p, /ONE line/);
  assert.deepEqual(outcomeOf(true, "DONE: ok"), { ok: true, line: "ok" });
  assert.deepEqual(outcomeOf(true, ""), { ok: true, line: "done" });
  assert.deepEqual(outcomeOf(false, "something else"), { ok: false, line: "something else" });
  assert.deepEqual(outcomeOf(false, undefined), { ok: false, line: "the call was not made" });
});

// ---- /approvals ----

test("/approvals lists the open items with numbers, ages and the hint; '/approvals clear' drops them all; groups have none", () => {
  const r = rig();
  park(r, "Rebecca");
  park(r, "Bob", { to: "b@example.com" });
  assert.deepEqual(parseCommand("/approvals"), { kind: "approvals", clear: false });
  assert.deepEqual(parseCommand("  /Approvals   CLEAR "), { kind: "approvals", clear: true });
  assert.equal(parseCommand("/approvals now"), undefined);
  assert.equal(parseCommand("show /approvals"), undefined);
  const conv = { kind: "tenant", key: r.scope, convId: "friend-x" } as const;
  const listed = commandReply(conv, "/approvals")!;
  assert.match(listed, /^Waiting for your approval \(2\):\n1\. Rebecca \(1 min\)/);
  assert.match(listed, /\n2\. Bob /);
  assert.ok(listed.includes(ANSWER_HINT));
  assert.deepEqual(openItems(r.scope).every((p) => p.sent), true, "listed items are not asked again in a batch");
  assert.equal(commandReply({ kind: "group", key: "g1", convId: groupConvId("g1") }, "/approvals"), undefined);
  assert.equal(commandReply(conv, "/approvals clear"), "Dropped 2 waiting actions (#1, #2). Nothing was run. Counted as a no, so they are not proposed again for now.");
  assert.deepEqual(openItems(r.scope), []);
  assert.equal(commandReply(conv, "/approvals clear"), "Nothing was waiting.");
  assert.equal(commandReply(conv, "/approvals"), "Nothing is waiting for your approval.");
  assert.equal(listText(r.scope), "Nothing is waiting for your approval.");
});

test("/approvals is the owner's own in her chat (owner key) and works through the injected dependency", () => {
  const seen: [string, boolean][] = [];
  const conv = { kind: "owner", key: "owner", convId: OWNER_CONV } as const;
  assert.equal(commandReply(conv, "/approvals", { approvals: (s, c) => (seen.push([s, c]), "listed") }), "listed");
  assert.equal(commandReply(conv, "/approvals clear", { approvals: (s, c) => (seen.push([s, c]), "cleared") }), "cleared");
  assert.deepEqual(seen, [["owner", false], ["owner", true]]);
});
