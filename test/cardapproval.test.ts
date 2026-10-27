import { test } from "node:test";
import assert from "node:assert/strict";
import { standing } from "./util.ts";
import { tick as settle } from "./util.ts";
import { answer, answerReaction, request } from "./approvalrig.ts";
import { makeApprove } from "../src/approvals/approvalask.ts";
import { NEVER_ASKS } from "../src/approvals/approvers.ts";
import type { AnswerJudgement } from "../src/approvals/approvalprompt.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { makeCanUseTool, type CallGuard, type GuardDecision } from "../src/approvals/permissions.ts";
import { TYPED_YES_NEEDED } from "../src/modules/browse/paymentrules.ts";
import { factsOf, validateQuestion } from "../src/approvals/questionfacts.ts";
import { BROWSE_RUN } from "./runkinds.ts";

// The payment approval: the owner's typed yes, and nothing else, approves a card payment. Fake values only.
const call = { tool: "mcp__browser__browser_type", input: { target: "e8", text: "{{card:number}}" } };
const jOf = (outcome: AnswerJudgement["outcome"], target = "A1"): typeof import("../src/approvals/approvalmodel.ts").judgeAnswer => async () => ({ target, outcome }) as AnswerJudgement;
const ask = (ts: number, typedYes: boolean) => request(async () => ts, "💳 Card payment approval", call, undefined, { typedYes });
const never = { judge: async () => assert.fail("the judge must not be called"), recent: () => [] };

test("typed yes: a typed yes approves a payment on the fast path, in any case and with one plain word", async () => {
  for (const [i, reply] of ["yes", "YES", "Yes, pay", "yes please", "ja"].entries()) {
    const d = ask(100 + i, true);
    await settle();
    assert.deepEqual(await answer(reply, () => {}, undefined, never), { outcome: "approved" }, reply);
    assert.deepEqual(await d, { approved: true });
  }
});

test("typed yes: a thumbs-up reaction does NOT approve a payment (the question stays open); a thumbs-down declines it", async () => {
  const d = ask(200, true);
  let settled = false;
  void d.then(() => (settled = true));
  await settle();
  assert.equal(answerReaction("👍", 200), "needs_text");
  assert.equal(answerReaction("✅", 200), "needs_text");
  await settle();
  assert.equal(settled, false, "still open");
  assert.equal(answerReaction("👎", 200), "declined");
  assert.deepEqual(await d, { approved: false });
  // the same reaction approves an ordinary question
  const plain = ask(201, false);
  await settle();
  assert.equal(answerReaction("👍", 201), "approved");
  assert.deepEqual(await plain, { approved: true });
});

test("typed yes: 👍 as text, ok, sure, go ahead and a voice message do not approve a payment; the owner is told to type yes; no judge is needed", async () => {
  const d = ask(300, true);
  let settled = false;
  void d.then(() => (settled = true));
  await settle();
  for (const reply of ["👍", "ok", "sure", "go ahead", "y", "approve"]) {
    const a = await answer(reply, () => {}, undefined, never);
    assert.equal(a.outcome, "clarify", reply);
    assert.equal(a.reply, TYPED_YES_NEEDED);
  }
  const voice = await answer("yes", () => {}, undefined, never, { voice: true });
  assert.equal(voice.outcome, "clarify", "a transcript of a voice message is not a typed yes");
  await settle();
  assert.equal(settled, false);
  assert.deepEqual(await answer("no", () => {}, undefined, never), { outcome: "declined" });
  assert.deepEqual(await d, { approved: false });
});

test("typed yes: the judge's own 'approve' is not enough, a doubtful reply stays open, an edit is refused, 'yes to both' never approves a payment", async () => {
  const d = ask(400, true);
  let settled = false;
  void d.then(() => (settled = true));
  await settle();
  const via = (judge: ReturnType<typeof jOf>) => ({ judge, recent: () => [] });
  // the judge says approve for a sentence that is not a typed yes: refused in code
  const a = await answer("yes, go ahead and pay it please", () => {}, undefined, via(jOf("approve")));
  assert.equal(a.outcome, "clarify");
  assert.equal(a.reply, TYPED_YES_NEEDED);
  const m = await answer("yes but only up to 20", () => {}, undefined, via(jOf("approve_modified")));
  assert.equal(m.outcome, "clarify");
  const multi = await answer("yes to both", () => {}, undefined, via((async () => ({ target: "multi", outcome: "multi", answers: [{ target: "A1", outcome: "approve" }, { target: "A2", outcome: "approve" }] })) as never));
  assert.notEqual(multi.outcome, "approved");
  await settle();
  assert.equal(settled, false, "none of these approved it");
  // the judge can still decline
  assert.equal((await answer("nah, forget it", () => {}, undefined, via(jOf("decline")))).outcome, "declined");
  assert.deepEqual(await d, { approved: false });
});

test("typed yes: an ordinary approval is unchanged (👍 text, ok and the judge still work)", async () => {
  const d = request(async () => 500, "Create event", { tool: "mcp__claude_ai_Google_Calendar__create_event", input: { summary: "x" } }, undefined, {});
  await settle();
  assert.deepEqual(await answer("ok", () => {}, undefined, never), { outcome: "approved" });
  assert.deepEqual(await d, { approved: true });
});

// ---- who may be asked ----

test("a payment is asked only in the owner's chat: a group's and a background run's approver refuse it without sending anything", async () => {
  let sent = 0;
  const send = async () => (sent++, 1);
  const never2 = (async () => assert.fail("no question must be written")) as never;
  for (const approve of [makeApprove(send, { scope: "group-1", source: "group", compose: never2, request: never2 }), NEVER_ASKS]) {
    const d = await approve("💳 Card payment approval", call, new AbortController().signal, { typedYes: true });
    assert.equal(d.approved, false);
    assert.match(d.failure!, /owner's own chat|background work never asks/);
  }
  assert.equal(sent, 0);
});

test("the permission layer: a payment ask skips the judge even in broad mode, passes typedYes to the approver, and runs the call built by resolve only after the yes", async () => {
  const order: string[] = [];
  let judged = 0;
  const judge = async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "test" });
  const g: GuardDecision = { kind: "ask", judge: false, payment: true, once: true, description: "💳 Card payment approval", resolve: async () => (order.push("resolved"), { ...call.input, text: "RESOLVED" }) };
  const guard: CallGuard = { decide: async () => g };
  const seen: unknown[] = [];
  const canUse = makeCanUseTool(async (_d, c, _s, o) => (order.push("asked"), seen.push([c.input, o]), { approved: true }), BROWSE_RUN, undefined, judge, guard, undefined, false, { provenance: standing("buy") });
  const r = (await canUse(call.tool, call.input, { signal: new AbortController().signal } as never)) as { behavior: string; updatedInput?: Record<string, unknown> };
  assert.equal(r.behavior, "allow");
  assert.equal(r.updatedInput?.text, "RESOLVED");
  assert.deepEqual(order, ["asked", "resolved"], "the call is built after the yes, not before");
  assert.equal(judged, 0, "the judge is never asked about a payment");
  assert.deepEqual(seen, [[call.input, { typedYes: true }]], "the approver sees the placeholder call and the typed-yes flag");
  // not approved: nothing is resolved
  order.length = 0;
  const no = makeCanUseTool(async () => (order.push("asked"), { approved: false }), BROWSE_RUN, undefined, judge, guard, undefined, false, { provenance: standing("buy") });
  assert.equal((await no(call.tool, call.input, { signal: new AbortController().signal } as never))!.behavior, "deny");
  assert.deepEqual(order, ["asked"]);
  // a resolve that refuses (kill switch, page changed) denies even after a yes
  const refusing: CallGuard = { decide: async () => ({ ...g, resolve: async () => "Card payments are switched off." }) };
  const late = makeCanUseTool(async () => ({ approved: true }), BROWSE_RUN, undefined, judge, refusing, undefined, false, { provenance: standing("buy") });
  const l = (await late(call.tool, call.input, { signal: new AbortController().signal } as never)) as { behavior: string; message?: string };
  assert.equal(l.behavior, "deny");
  assert.match(l.message!, /switched off/);
});

// ---- the question ----

const DETAILS = ["💳 Card payment approval: typed YES needed", "Merchant: shop.test", "Card typed on: stripe.com, shop.test", "Total (read from the page by code, not checked by the shop): CHF 45.00", "Card: Wise ••••4242 (CHF)", "Approval id: 1a2b3c4d", "Cart:", "• Ticket Zurich to Bern CHF 40.00"].join("\n");

test("the question must carry the merchant, the card host, the total with currency, the last 4, the id and the word YES", () => {
  const facts = factsOf(call.input, DETAILS);
  for (const m of ["shop.test", "stripe.com", "CHF 45.00", "4242", "1a2b3c4d", "YES"]) assert.ok(facts.must.includes(m), m);
  const good = "Pay shop.test CHF 45.00 with the card ending 4242? I'd type it on stripe.com (approval 1a2b3c4d). The payment is then confirmed in your card app: check the amount there. Reply YES to pay or NO.";
  assert.equal(validateQuestion(good, facts), undefined);
  for (const [cut, re] of [["shop.test", /missing "shop\.test"/], ["CHF 45.00", /missing "CHF 45\.00"/], ["4242", /missing "4242"/], ["1a2b3c4d", /missing "1a2b3c4d"/], ["stripe.com", /missing "stripe\.com"/]] as const) {
    assert.match(validateQuestion(good.replaceAll(cut, "…"), facts)!, re);
  }
  assert.match(validateQuestion(good.replace("Reply YES to pay or NO.", "Go ahead?"), facts)!, /missing "YES"/);
});

// ---- a payment resolves only through a direct path ----

test("typed yes: with a payment and a calendar question open, a bare YES that the answer model aims at the payment pays nothing; the owner is asked which one", async () => {
  const pay = ask(600, true);
  const cal = request(async () => 601, "Move the dentist", { tool: "mcp__claude_ai_Google_Calendar__update_event", input: { eventId: "e1" } }, undefined, {});
  let paid = false;
  let moved = false;
  void pay.then((d) => (paid = d.approved));
  void cal.then((d) => (moved = d.approved));
  await settle();
  const aimed = { judge: jOf("approve", "A1"), recent: () => [] }; // A1: the payment (asked first)
  const a = await answer("YES", () => {}, undefined, aimed);
  assert.equal(a.outcome, "clarify");
  assert.match(a.reply ?? "", /Which one/);
  await settle();
  assert.equal(paid, false);
  assert.equal(moved, false, "nothing else was approved either");
  // every outcome the model could choose for the payment is refused the same way, a decline included (the owner meant the other question)
  for (const outcome of ["approve", "approve_modified", "decline"] as const) assert.equal((await answer("YES", () => {}, undefined, { judge: jOf(outcome, "A1"), recent: () => [] })).outcome, "clarify", outcome);
  // a reply that quotes the payment is direct: a typed YES approves it
  assert.deepEqual(await answer("YES", () => {}, { timestamp: 600 }, never), { outcome: "approved" });
  assert.deepEqual(await pay, { approved: true });
  // the calendar question still goes through the model's target
  assert.equal((await answer("yes move it", () => {}, undefined, { judge: jOf("approve", "A1"), recent: () => [] })).outcome, "approved");
  assert.deepEqual(await cal, { approved: true });
});

test("approvals are keyed by conversation: the same timestamp in another conversation is another question", async () => {
  const a = request(async () => 700, "Create event A", { tool: "mcp__claude_ai_Google_Calendar__create_event", input: { summary: "a" } }, undefined, { scope: "owner" });
  const b = request(async () => 700, "Create event B", { tool: "mcp__claude_ai_Google_Calendar__create_event", input: { summary: "b" } }, undefined, { scope: "group-9" });
  await settle();
  assert.equal(answerReaction("👍", 700, "group-9"), "approved");
  assert.deepEqual(await b, { approved: true });
  let settled = false;
  void a.then(() => (settled = true));
  await settle();
  assert.equal(settled, false, "the owner's question with the same timestamp is still open");
  assert.equal(answerReaction("👎", 700, "owner"), "declined");
  assert.deepEqual(await a, { approved: false });
});
