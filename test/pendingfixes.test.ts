import { test } from "node:test";
import assert from "node:assert/strict";
import * as approvals from "../src/approvals/approvals.ts";
import { openItems } from "../src/approvals/pending.ts";
import { exactGuard, pendingPrompt, pendingSystem } from "../src/approvals/pendingexec.ts";
import { clearText, flushPending, idle, queueCall, setPendingRuntime, type PendingRuntime } from "../src/approvals/pendingflow.ts";
import { declinedAgo, resetDeclined } from "../src/approvals/declined.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { readAudit, wordless } from "../src/core/audit.ts";
import { emitRecord } from "../src/core/events.ts";
import { settings } from "../src/core/settings.ts";
import { commandReply } from "../src/conversation/ownercommands.ts";
import { LIMITS } from "../src/core/sanitize.ts";
import { OWNER_CONV } from "../src/core/convpaths.ts";

// The approval inbox, second pass: only what was shown can be answered in bulk, an approved item the run gate refused is not lost, a friend's words stay out of the admin's audit log, a call that
// was done is not parked again, and an expiry does not re-ask on every look. Fake values only.

const SEND = "mcp__gmail__reply";
const NOW = new Date(2026, 9, 14, 14, 0, 0);
let seq = 0;

function rig(over: Partial<PendingRuntime> = {}, scope = `tenant:fix${++seq}`) {
  const r = { scope, sent: [] as { text: string; ts: number }[], ran: [] as number[], now: NOW };
  let ts = 4000;
  setPendingRuntime({ send: async (_s, text) => (r.sent.push({ text, ts: ++ts }), ts), holding: () => false, execute: async (_s, i) => (r.ran.push(i.n), { ran: true, line: "replied to Rebecca" }), now: () => r.now, ...over });
  return r;
}
const park = (scope: string, to: string, now = NOW) => queueCall(scope, { tool: SEND, input: { to }, label: `Reply to ${to}`, question: "Send?", footer: "", source: "background" }, now)!;
const say = (scope: string, text: string, quote?: { timestamp: number }) => approvals.answer(text, () => {}, quote, { judge: async () => undefined, recent: () => [] }, { scope });

// ---- 1. only what was shown ----

test("'all yes' and ranges never reach an item that was not shown; a quoted batch limits 'all' to that batch", async () => {
  const r = rig();
  park(r.scope, "a@example.com");
  park(r.scope, "b@example.com");
  await flushPending(r.scope, { ended: true });
  const first = r.sent[0]!.ts;
  park(r.scope, "c@example.com"); // #3: waiting for its batch
  assert.equal((await say(r.scope, "all yes")).outcome, "approved");
  await idle();
  assert.deepEqual(r.ran, [1, 2], "#3 was not approved by 'all'");
  assert.deepEqual(openItems(r.scope).map((p) => p.n), [3]);
  // a range over it, or naming it, is refused with the reason and nothing is done
  park(r.scope, "d@example.com"); // #4
  const range = await say(r.scope, "3-4 yes");
  assert.deepEqual([range.outcome, range.reply], ["clarify", "#3, #4 haven't been shown to you yet. Nothing was done."]);
  const named = await say(r.scope, "3 yes");
  assert.deepEqual([named.outcome, named.reply], ["clarify", "#3 hasn't been shown to you yet. Nothing was done."]);
  assert.equal(r.ran.length, 2);
  // a second batch; 'all yes' quoting the FIRST batch touches only the first batch's open items
  await flushPending(r.scope, { ended: true });
  const second = r.sent.at(-1)!.ts;
  assert.notEqual(first, second);
  park(r.scope, "e@example.com"); // unsent, #5
  const quoted = await say(r.scope, "all yes", { timestamp: second });
  assert.equal(quoted.outcome, "approved");
  await idle();
  assert.deepEqual(r.ran, [1, 2, 3, 4], "the second batch only; #5 was never shown");
  assert.deepEqual(openItems(r.scope).map((p) => p.n), [5]);
});

test("'all yes' with nothing shown resolves nothing", async () => {
  const r = rig();
  park(r.scope, "a@example.com");
  const res = await say(r.scope, "all yes");
  assert.equal(res.outcome, "clarify");
  assert.deepEqual(r.ran, []);
  assert.equal(openItems(r.scope).length, 1);
});

// ---- 2. an approved item the run gate refused ----

test("an approved item the run gate refuses stays approved, is told once, and is run by the tick when the gate allows", async () => {
  let gate: string | undefined = "paused";
  const r = rig({
    canRun: () => gate,
    execute: async (_s, i) => (gate ? { ran: false, line: "not run now", refused: gate } : (r.ran.push(i.n), { ran: true, line: "replied to Rebecca" })),
  });
  park(r.scope, "a@example.com");
  await flushPending(r.scope, { ended: true });
  assert.equal((await say(r.scope, "1 yes")).outcome, "approved");
  await idle();
  assert.deepEqual(r.ran, []);
  assert.equal(r.sent.at(-1)!.text, "#1 is approved but can't run right now (paused); I'll do it when it can.");
  const [p] = openItems(r.scope);
  assert.ok(p && p.retry && !p.executing, "kept, approved, waiting");
  const again = await say(r.scope, "1 yes");
  assert.equal(again.reply, "#1 is approved and waiting to run; I'll do it when it can.");
  const before = r.sent.length;
  await flushPending(r.scope, { ended: false }); // the tick: still refused
  await idle();
  assert.equal(r.sent.length, before, "not told again, not run");
  r.now = new Date(NOW.getTime() + 5 * 86_400_000); // (an approved item does not expire while it waits)
  gate = undefined;
  await flushPending(r.scope, { ended: false });
  await idle();
  assert.deepEqual(r.ran, [1], "run once the gate allows, without asking again");
  assert.equal(r.sent.at(-1)!.text, "✅ #1 done: replied to Rebecca");
  assert.deepEqual(openItems(r.scope), []);
});

// ---- 3. a friend's words stay out of the admin's audit log ----

test("a friend's follow-up run leaves no words in the audit log; the owner's keeps them; result and by are words", async () => {
  assert.deepEqual(wordless({ result: "she wrote this", by: "+4912345", n: 2 }), { resultChars: 14, byChars: 8, n: 2 });
  const friend = rig();
  park(friend.scope, "a@example.com");
  await flushPending(friend.scope, { ended: true });
  setPendingRuntime({ send: async () => 1, holding: () => false, execute: async () => ({ ran: true, line: "Anna's secret reply text" }), now: () => NOW });
  await say(friend.scope, "1 yes");
  await idle();
  const rowsOf = (scope: string) => readAudit((e) => e.meta?.scope === scope && /^approval-queue-/.test(e.decision));
  const row = rowsOf(friend.scope).find((e) => e.decision === "approval-queue-executed")!;
  assert.deepEqual([row.meta!.ok, "result" in row.meta!, "resultChars" in row.meta!], [true, false, false]);
  assert.doesNotMatch(JSON.stringify(rowsOf(friend.scope)), /secret reply|a@example/);
  const owner = rig({}, "owner");
  park("owner", "o@example.com");
  await flushPending("owner", { ended: true });
  await say("owner", "all yes");
  await idle();
  void owner;
  assert.equal(rowsOf("owner").find((e) => e.decision === "approval-queue-executed")!.meta!.result, "replied to Rebecca");
});

// ---- 4. a call that was done is not parked again ----

test("a call executed from the inbox is not parked again, and the permission layer refuses it as already done", async () => {
  const r = rig();
  const q = park(r.scope, "a@example.com");
  await flushPending(r.scope, { ended: true });
  await say(r.scope, `${q.n} yes`);
  await idle();
  const again = park(r.scope, "a@example.com");
  assert.equal(again.n, q.n);
  assert.match(again.message, /^That exact call was already done on 2026-10-14 \(as #1\)\. Do not repeat it\./);
  assert.deepEqual(openItems(r.scope), [], "not parked");
  assert.equal(park(r.scope, "other@example.com").n, 2, "another call is parked as usual");
  // the follow-up run's guard remembers it for the ask path of the next look (30 minutes, as for any approved call)
  const input = { to: "x@example.com", body: "hi" };
  const tool = "mcp__claude_ai_Google_Calendar__create_event";
  const opts = { signal: new AbortController().signal } as never;
  const run = makeCanUseTool((async () => assert.fail("nobody is asked")) as never, "background", undefined, undefined, exactGuard({ tool, input: { summary: "Dentist", startTime: "2026-10-16T10:00:00" } }, "background"));
  assert.equal(((await run(tool, { summary: "Dentist", startTime: "2026-10-16T10:00:00" }, opts)) as { behavior: string }).behavior, "allow");
  const next = makeCanUseTool((async () => ({ approved: false })) as never, "background", undefined, (async () => ({ decision: "ask", reason: "t" })) as never, undefined, undefined, false, {});
  const second = (await next(tool, { summary: "Dentist", startTime: "2026-10-16T10:00:00" }, opts)) as { behavior: string; message?: string };
  assert.equal(second.behavior, "deny");
  assert.match(second.message ?? "", /already approved and done/);
  void input;
});

// ---- 5. /status ----

test("/status counts the calls parked in the inbox as open approvals", () => {
  const scope = "owner";
  rig({}, scope);
  const before = /Open approvals: (\d+)/.exec(commandReply({ kind: "owner", key: scope, convId: OWNER_CONV }, "/status")!)![1]!;
  park(scope, `status${seq}@example.com`);
  const after = /Open approvals: (\d+)/.exec(commandReply({ kind: "owner", key: scope, convId: OWNER_CONV }, "/status")!)![1]!;
  assert.equal(Number(after), Number(before) + 1);
});

// ---- 6. a friend's run names her approver ----

test("a friend's queued text and follow-up prompts do not name the owner", () => {
  const r = rig();
  const q = park(r.scope, "a@example.com");
  assert.doesNotMatch(q.message, new RegExp(settings.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(q.message, /^Queued for .+'s approval as #1/);
  assert.match(pendingPrompt({ tool: SEND, input: {} }, "Anna"), /^Anna approved this one action/);
  assert.match(pendingSystem("Anna"), /^You carry out ONE action that Anna has already approved/);
  assert.match(pendingPrompt({ tool: SEND, input: {} }), new RegExp(`^${settings.owner}`));
});

// ---- 7. dismissal and expiry ----

test("'/approvals clear' is a no; an expiry is not, but the same call is not parked again for 24 hours", async () => {
  resetDeclined();
  const r = rig();
  park(r.scope, "a@example.com");
  assert.match(clearText(r.scope), /Counted as a no/);
  assert.notEqual(declinedAgo(r.scope, SEND, { to: "a@example.com" }, NOW.getTime()), undefined, "final like any decline");

  const e = rig();
  const day = 86_400_000;
  park(e.scope, "old@example.com");
  e.now = new Date(NOW.getTime() + 3 * day + 1000);
  await flushPending(e.scope, { ended: true }); // expires it and says so
  assert.match(e.sent.at(-1)!.text, /Dropped, not answered in 3 days/);
  const soon = queueCall(e.scope, { tool: SEND, input: { to: "old@example.com" }, label: "x", question: "q", footer: "", source: "background" }, e.now)!;
  assert.match(soon.message, /not queued again for 24 hours/);
  assert.deepEqual(openItems(e.scope), []);
  e.now = new Date(e.now.getTime() + day + 1000);
  const later = queueCall(e.scope, { tool: SEND, input: { to: "old@example.com" }, label: "x", question: "q", footer: "", source: "background" }, e.now)!;
  assert.match(later.message, /^Queued for/);
  assert.equal(openItems(e.scope).length, 1);
});

// ---- 8. the queued row clips the arguments ----

test("the approval-queued audit row clips huge arguments", () => {
  const r = rig();
  queueCall(r.scope, { tool: SEND, input: { body: "x".repeat(LIMITS.args * 2) }, label: "big", question: "q", footer: "", source: "background" }, NOW);
  const row = readAudit((e) => e.decision === "approval-queued" && e.tool === SEND && typeof e.meta?.argsChars === "number" && e.meta.argsChars < LIMITS.args * 2 + 200);
  assert.ok(row.length > 0, "the friend's row carries a length only, and a clipped one");
  emitRecord("x", "noop", "background");
  const ownerRig = rig({}, "owner");
  void ownerRig;
  queueCall("owner", { tool: SEND, input: { body: "y".repeat(LIMITS.args * 2) }, label: "big", question: "q", footer: "", source: "background" }, NOW);
  const own = readAudit((e) => e.decision === "approval-queued" && e.meta?.scope === undefined && typeof e.meta?.args === "string" && e.meta.args.includes("more characters"));
  assert.ok(own.length > 0);
});
