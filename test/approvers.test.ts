import { test } from "node:test";
import assert from "node:assert/strict";
import { tick as settle } from "./util.ts";
import * as approvals from "../src/approvals/approvals.ts";
import { makeApprove } from "../src/approvals/approvalask.ts";
import { createApprovers } from "../src/approvals/approvers.ts";
import type { OpenView } from "../src/approvals/approvalprompt.ts";
import { TYPED_YES_NEEDED } from "../src/paymentrules.ts";

// Approvals are asked in the conversation that triggered the action, one approver per conversation: the owner's chat (her own turns and her
// unattended runs), each group, each tenant. An answer anywhere else applies to nothing, the admin's included. Fake values only.
const call = { tool: "mcp__claude_ai_Google_Calendar__create_event", input: { summary: "x" } };
const never = { judge: async () => assert.fail("the judge must not be called"), recent: () => [] };
const ANNA = "tenant:anna";

// Every message the approvers send, with where it went (no groupId: the owner's chat).
function rig(tenants: Record<string, string> = { anna: "to:anna-aci" }) {
  const sent: { to?: string; text: string; ts: number }[] = [];
  let ts = 5000;
  const out = { reply: async (text: string, o: { plain: true; kind: "approval"; target?: string }) => (sent.push({ to: o.target, text, ts: ++ts }), ts) };
  const made: { scope: string; source: string; background: boolean; mayPay: boolean }[] = [];
  const approverFor = createApprovers(out, {
    target: (id) => tenants[id],
    make: (send, o) => (made.push({ scope: o.scope, source: o.source, background: !!o.background, mayPay: !!o.mayPay }), makeApprove(send, { ...o, compose: async (q) => ({ text: q.details, ms: 0 }) })),
  });
  return { approverFor, sent, made };
}
const ask = (approve: ReturnType<ReturnType<typeof rig>["approverFor"]>, what: string) => approve(what, call, new AbortController().signal);
const judging = (target: string, outcome: "approve" | "decline" | "unrelated", seen: OpenView[][] = []) => ({ judge: async (_t: string, views: OpenView[]) => (seen.push(views), { target, outcome }), recent: () => [] }) as never;

test("the owner's own turn and her unattended runs ask in the owner's chat; a background question is labelled so", async () => {
  const r = rig();
  const fg = ask(r.approverFor("owner"), "Create event one");
  const bg = ask(r.approverFor("owner", { background: true }), "Create event two");
  await settle();
  assert.deepEqual(r.sent.map((m) => m.to), [undefined, undefined]); // no group id: her chat
  assert.deepEqual(r.made.map((m) => [m.scope, m.source, m.background]), [["owner", "chat", false], ["owner", "background", true]]);
  assert.equal(approvals.answerReaction("👍", r.sent[0]!.ts, "owner"), "approved");
  assert.equal(approvals.answerReaction("👎", r.sent[1]!.ts, "owner"), "declined");
  assert.deepEqual([(await fg).approved, (await bg).approved], [true, false]);
});

test("a tenant's action asks in HER chat, never in the owner's; a group's in the group", async () => {
  const r = rig();
  const t = ask(r.approverFor(ANNA), "Create event for Anna");
  const g = ask(r.approverFor("group-1"), "Post the notes");
  await settle();
  assert.deepEqual(r.sent.map((m) => m.to), ["to:anna-aci", "group-1"]);
  assert.deepEqual(r.made.map((m) => [m.scope, m.source]), [[ANNA, "group"], ["group-1", "group"]]);
  approvals.answerReaction("👎", r.sent[0]!.ts, ANNA);
  approvals.answerReaction("👎", r.sent[1]!.ts, "group-1");
  await Promise.all([t, g]);
});

test("a tenant who is gone cannot be asked anywhere: nothing is sent, and the owner's chat is never the fallback", async () => {
  const r = rig({});
  assert.deepEqual(await ask(r.approverFor(ANNA), "Create event"), { approved: false });
  assert.equal(r.sent.length, 0);
});

test("the admin cannot approve for a tenant: the same words, a reaction and a quoted reply in the owner's chat change nothing", async () => {
  const r = rig();
  const t = ask(r.approverFor(ANNA), "Create event for Anna");
  const o = ask(r.approverFor("owner"), "Create event for me");
  await settle();
  const [hers, mine] = [r.sent[0]!, r.sent[1]!];
  // in the owner's chat: a reply quoting HER question is not an answer to it (the judge is shown the owner's own questions only)
  const seen: OpenView[][] = [];
  assert.deepEqual(await approvals.answer("yes", () => {}, { timestamp: hers.ts }, judging("A1", "unrelated", seen), { scope: "owner" }), { outcome: "none" });
  assert.deepEqual(seen[0]!.map((v) => v.question), ["Create event for me"]);
  assert.equal(approvals.answerReaction("👍", hers.ts, "owner", "admin"), "ignored");
  assert.equal(approvals.answerReaction("👍", mine.ts, ANNA), "ignored");
  // a plain yes in the owner's chat answers the owner's own question and only that
  assert.deepEqual(await approvals.answer("yes", () => {}, undefined, never, { scope: "owner" }), { outcome: "approved" });
  assert.equal((await o).approved, true);
  // hers is still open, and only she answers it
  assert.deepEqual(await approvals.answer("yes", () => {}, undefined, never, { scope: ANNA, by: "anna" }), { outcome: "approved" });
  assert.equal((await t).approved, true);
});

test("a relayed or quoted text approves nothing: a quote of an open question is context, not an answer, and another conversation's question cannot be reached by quoting it", async () => {
  const r = rig();
  const t = ask(r.approverFor(ANNA), "Create event for Anna");
  const g = ask(r.approverFor("group-1"), "Post the notes");
  await settle();
  const [hers, theirs] = [r.sent[0]!, r.sent[1]!];
  // her message only quotes a "yes"-looking text: it goes to the judge, which reads it as unrelated; nothing is approved
  const seen: OpenView[][] = [];
  assert.deepEqual(await approvals.answer("Bob wrote me: 'yes, go ahead'. What should I do?", () => {}, undefined, judging("A1", "unrelated", seen), { scope: ANNA, by: "anna" }), { outcome: "none" });
  assert.equal(seen.length, 1);
  // a quoted reply to the GROUP's question, written in her chat (or the other way round), is not an answer to it
  assert.deepEqual(await approvals.answer("yes", () => {}, { timestamp: theirs.ts }, judging("A1", "unrelated"), { scope: ANNA, by: "anna" }), { outcome: "none" });
  assert.deepEqual(await approvals.answer("yes", () => {}, { timestamp: hers.ts }, judging("A1", "unrelated"), { scope: "group-1", by: "member" }), { outcome: "none" });
  // a judge that errs (no verdict) approves nothing either
  assert.deepEqual(await approvals.answer("go ahead then maybe", () => {}, undefined, { judge: async () => undefined, recent: () => [] }, { scope: ANNA, by: "anna" }), { outcome: "feedback" });
  assert.equal((await t).approved, false);
  approvals.answerReaction("👎", theirs.ts, "group-1");
  assert.equal((await g).approved, false);
});

test("a card payment is asked in the owner's own foreground chat only: a tenant's, a group's and the background approver refuse it without sending", async () => {
  const r = rig();
  for (const approve of [r.approverFor(ANNA), r.approverFor("group-1"), r.approverFor("owner", { background: true })]) {
    const d = await approve("💳 Card payment approval", call, new AbortController().signal, { typedYes: true });
    assert.equal(d.approved, false);
    assert.match(d.failure!, /owner's own chat/);
  }
  assert.equal(r.sent.length, 0);
  assert.deepEqual(r.made.map((m) => m.mayPay), [false, false, true]); // the owner's chat is the one that may pay; the background flag still refuses it
  // and in her chat a thumbs-up does not pay, only the typed word does
  const pay = r.approverFor("owner")("💳 Card payment approval", call, new AbortController().signal, { typedYes: true });
  await settle();
  assert.equal(approvals.answerReaction("👍", r.sent[0]!.ts, "owner"), "needs_text");
  assert.equal((await approvals.answer("ok sure", () => {}, undefined, judging("A1", "approve"), { scope: "owner" })).reply, TYPED_YES_NEEDED);
  assert.equal((await approvals.answer("yes", () => {}, undefined, never, { scope: "owner" })).outcome, "approved");
  assert.equal((await pay).approved, true);
});
