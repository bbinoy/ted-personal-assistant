import { test } from "node:test";
import assert from "node:assert/strict";
import * as approvals from "../src/approvals/approvals.ts";
import { openItems } from "../src/approvals/pending.ts";
import { compactFooter, detailsHash } from "../src/approvals/pendingbatch.ts";
import { flushPending, forgetRuns, idle, listText, queueCall, recoverStuck, setPendingRuntime, type PendingRuntime } from "../src/approvals/pendingflow.ts";
import { audit } from "../src/core/audit.ts";

// The approval inbox after the yes: a target that changed since it was asked is not run, and a run cut short by a stop is noticed (never retried by itself). Fake values only.

const SEND = "mcp__gmail__reply";
const MAIL = { to: "rebecca@example.com", body: "Thursday works" };
const NOW = new Date(2026, 9, 14, 14, 0, 0);
let seq = 0;

function rig(over: Partial<PendingRuntime> = {}) {
  const r = { scope: `tenant:drift${++seq}`, sent: [] as string[], ran: [] as number[] };
  const rt: PendingRuntime = { send: async (_s, t) => (r.sent.push(t), 1), holding: () => false, execute: async (_s, i) => (r.ran.push(i.n), { ran: true, line: "replied to Rebecca" }), now: () => NOW, ...over };
  setPendingRuntime(rt);
  return r;
}
const park = (scope: string, details: string, input: Record<string, unknown> = MAIL) =>
  queueCall(scope, { tool: SEND, input, label: details.split("\n")[0]!, question: "Send?", footer: compactFooter(details), detailsHash: detailsHash(details), source: "background" }, NOW)!;
const say = (scope: string, text: string) => approvals.answer(text, () => {}, undefined, { judge: async () => undefined, recent: () => [] }, { scope });

test("a draft edited between asking and running: nothing runs, the current version is parked as a new item and said so", async () => {
  let draft = "✉️ Reply to Rebecca\nTo: rebecca@example.com\n\nThursday works";
  const r = rig({ details: async () => draft });
  park(r.scope, draft);
  await flushPending(r.scope, { ended: true });
  draft = "✉️ Reply to Rebecca\nTo: rebecca@example.com, mallory@example.com\n\nThursday works"; // edited meanwhile
  assert.equal((await say(r.scope, "1 yes")).outcome, "approved");
  await idle();
  assert.deepEqual(r.ran, [], "not executed");
  const said = r.sent.at(-1)!;
  assert.match(said, /^⚠️ #1 changed since you approved it, so nothing was run\. Here is the current version as #2:\n2\. ✉️ Reply to Rebecca #1 changed since you approved it/);
  assert.match(said, /mallory@example\.com/);
  assert.deepEqual(openItems(r.scope).map((p) => p.n), [2]);
  assert.equal((await say(r.scope, "2 yes")).outcome, "approved"); // the details are unchanged now: it runs
  await idle();
  assert.deepEqual(r.ran, [2]);
});

test("a draft that is gone is not run either", async () => {
  const r = rig({ details: async () => undefined });
  const q = park(r.scope, "✉️ Reply\nTo: a@example.com\n\nhi");
  await say(r.scope, `${q.n} yes`);
  await idle();
  assert.deepEqual(r.ran, []);
  assert.match(r.sent.at(-1)!, /^⚠️ #1 was not run: what it refers to can no longer be read/);
  assert.deepEqual(openItems(r.scope), []);
});

test("detailsHash ignores the lines that legitimately change (a declined note, a looked-up name)", () => {
  const a = "✉️ Send\nTo: a@example.com\n\nhi";
  assert.equal(detailsHash(a), detailsHash(`${a}\nNamed: Dentist\nThe owner declined this action 5 minutes ago.`));
  assert.notEqual(detailsHash(a), detailsHash(a.replace("a@", "b@")));
});

test("an approved item stays marked as running until its run ends; a stop in between is noticed once and never retried by itself", async () => {
  const r = rig({ execute: () => new Promise(() => {}) }); // the process stops during the run
  const q = park(r.scope, "✉️ Reply to Rebecca\nTo: rebecca@example.com\n\nhi");
  await flushPending(r.scope, { ended: true });
  await say(r.scope, `${q.n} yes`);
  const [p] = openItems(r.scope);
  assert.ok(p!.executing, "still in the file, marked as running");
  assert.match(listText(r.scope), /1\. ✉️ Reply to Rebecca .*running now/);
  assert.equal((await say(r.scope, "1 yes")).outcome, "clarify", "a running item cannot be approved twice");
  assert.deepEqual(recoverStuck(r.scope), [], "this process is still running it");
  // the restart: nothing runs here, and the audit log has no finished row
  const lost = recoverStuck(r.scope, new Set());
  assert.deepEqual(lost, ["#1 may not have run (I restarted while doing it). Reply '#1 yes' to try again."]);
  assert.equal(openItems(r.scope)[0]!.executing, undefined);
  assert.equal(openItems(r.scope)[0]!.interrupted, true);
  assert.deepEqual(recoverStuck(r.scope, new Set()), [], "told once");
  assert.match(listText(r.scope), /may not have run, reply to try again/);
  forgetRuns();
  // "#1 yes" tries again, exactly as recorded
  rig({ execute: async (_s, i) => (r.ran.push(i.n), { ran: true, line: "ok" }) });
  assert.equal((await say(r.scope, "#1 yes")).outcome, "approved");
  await idle();
  assert.deepEqual(r.ran, [1]);
  assert.deepEqual(openItems(r.scope), []);
});

test("a stuck item whose run did finish (the audit log says so) is simply done; flushPending says what was lost", async () => {
  const r = rig({ execute: () => new Promise(() => {}) });
  park(r.scope, "✉️ A\nTo: a@example.com\n\nhi", { to: "a@example.com" });
  park(r.scope, "✉️ B\nTo: b@example.com\n\nhi", { to: "b@example.com" });
  await say(r.scope, "all yes");
  audit(SEND, "approval-queue-executed", "background", { n: 1, scope: r.scope, result: "ok" });
  assert.deepEqual(recoverStuck(r.scope, new Set()), ["#2 may not have run (I restarted while doing it). Reply '#2 yes' to try again."]);
  assert.deepEqual(openItems(r.scope).map((p) => p.n), [2], "#1 finished");
  // the start of the next process tells it through the chat
  const r2 = rig({ execute: () => new Promise(() => {}) });
  const q = park(r2.scope, "✉️ C\nTo: c@example.com\n\nhi", { to: "c@example.com" });
  await say(r2.scope, `${q.n} yes`);
  const before = r2.sent.length;
  assert.equal(recoverStuck(r2.scope).length, 0);
  assert.equal(r2.sent.length, before);
});
