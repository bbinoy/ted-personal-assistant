import { test } from "node:test";
import assert from "node:assert/strict";
import { standing } from "./util.ts";
import { readAudit } from "../src/core/audit.ts";
import { makeCanUseTool, UNATTENDED_SKIP, type CallGuard } from "../src/approvals/permissions.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { noteDeclined } from "../src/approvals/declined.ts";
import { runFor } from "../src/run/runoptions.ts";
import { buildOptions } from "../src/run/agentrun.ts";
import { group, owner } from "../src/conversation/conversationmodel.ts";
import { lookInstruction } from "../src/heartbeat/look.ts";
import { chatSystem } from "../src/run/persona.ts";
import { GROUP_CHAT, GROUP_LOOK, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";
import type { RunKind } from "../src/core/runkind.ts";

const BROWSE_UNATTENDED: RunKind = { who: "browse", attended: false };

// UNATTENDED RUNS NEVER ASK (the owner, 22 Oct): a look of the owner, a group or a friend, its expert, a routine, meeting prep, acts when it is sure and is silent when
// it is not. What would be a question is declined back to the run with one fixed text and audited `background-skip`; no question, no approval-inbox item. A chat run asks as before.

const CAL = "mcp__claude_ai_Google_Calendar__create_event";
const EVENT = { summary: "Dentist", startTime: "2026-10-23T10:00:00", endTime: "2026-10-23T11:00:00" };
const sig = () => ({ signal: new AbortController().signal }) as never;
const says = (decision: Verdict["decision"]) => async (): Promise<Verdict> => ({ decision, reason: "test" });
let n = 0;
const conv = () => `unattended-${++n}`;

function rig(kind: RunKind, o: { judge?: Verdict["decision"]; guard?: CallGuard; tools?: ReadonlySet<string> } = {}) {
  const asked: string[] = [];
  const conversation = conv();
  const mark = readAudit(() => true).length; // (the rows this rig's run writes are the ones after this)
  const can = makeCanUseTool(async (d) => (asked.push(d), { approved: true }), kind, undefined, says(o.judge ?? "ask"), o.guard, o.tools, false, { provenance: standing("the fixed look"), conversation });
  const call = async (tool: string, input: Record<string, unknown>) => (await can(tool, input, sig())) as { behavior: string; message?: string };
  const rows = (decision: string) => readAudit(() => true).slice(mark).filter((e) => e.decision === decision);
  return { asked, call, conversation, rows };
}
const skips = (r: { rows: (d: string) => ReturnType<typeof readAudit> }) => r.rows("background-skip");

test("which runs are unattended: a look of any conversation, the same fact for the owner, a group and a friend; a message turn never", () => {
  assert.equal(runFor(owner(), "look").kind.attended, false);
  assert.equal(runFor(owner(), "message").kind.attended, true);
  assert.equal(runFor(group("g-unattended"), "look").kind.attended, false);
  assert.equal(runFor(group("g-unattended"), "message").kind.attended, true);
});

test("the owner's look: the judge's ask is a skip with the fixed text and one audit row; nobody is asked, nothing is parked", async () => {
  const r = rig(OWNER_LOOK);
  const res = await r.call(CAL, EVENT);
  assert.deepEqual(res, { behavior: "deny", message: UNATTENDED_SKIP });
  assert.equal(UNATTENDED_SKIP, "Not done: not certain enough to act without asking, and background work never asks. Do not retry it: turn what needs the owner into what is allowed (a draft, or an add_task item) so the brief lists it; mention it only if it truly matters, as information.");
  assert.deepEqual(r.asked, []);
  const rows = skips(r);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.tool, rows[0]!.source, rows[0]!.meta], [CAL, "background", { skip: "judge" }], "tool and reason class, no words");
  assert.deepEqual([r.rows("ask-sent").length, r.rows("approval-asked").length], [0, 0]);
});

test("a group's look and a friend's look skip the same way in their own conversation; their chat still asks", async () => {
  const tools = new Set([CAL]);
  const look = rig(GROUP_LOOK, { tools });
  assert.equal((await look.call(CAL, EVENT)).message, UNATTENDED_SKIP);
  assert.deepEqual(look.asked, []);
  assert.equal(skips(look).length, 1);
  const chat = rig(GROUP_CHAT, { tools });
  assert.equal((await chat.call(CAL, EVENT)).behavior, "allow", "the group's chat asks, and the stub says yes");
  assert.equal(chat.asked.length, 1);
  assert.equal(skips(chat).length, 0);
});

test("the owner's chat still asks as before", async () => {
  const r = rig(OWNER_CHAT);
  assert.equal((await r.call(CAL, EVENT)).behavior, "allow");
  assert.equal(r.asked.length, 1);
  assert.equal(skips(r).length, 0);
});

test("the judge's auto still acts in an unattended run", async () => {
  const r = rig(OWNER_LOOK, { judge: "auto" });
  assert.equal((await r.call(CAL, EVENT)).behavior, "allow");
  assert.deepEqual([r.asked, skips(r)], [[], []]);
});

test("a floor that forces ask (a never-judged call, a guard step) and a decline that stands are skips; the reason class says which", async () => {
  const r = rig(OWNER_LOOK, { judge: "auto" });
  assert.equal((await r.call("mcp__mailbird__move_conversation", { conversationId: 9, folderId: "f1" })).message, UNATTENDED_SKIP, "a move is never judged: in a chat it is asked, here skipped");
  noteDeclined(r.conversation, CAL, EVENT);
  assert.equal((await r.call(CAL, EVENT)).message, UNATTENDED_SKIP, "declined in this conversation: in an unattended run a redeclined call is a skip");
  assert.deepEqual(skips(r).map((e) => e.meta?.skip), ["never-judged", "redeclined"]);
  const g = rig(BROWSE_UNATTENDED, { guard: { decide: async () => ({ kind: "ask", description: "Click Submit" }) } });
  assert.equal((await g.call("mcp__browser__browser_click", { ref: "e1" })).message, UNATTENDED_SKIP);
  assert.deepEqual([r.asked, g.asked], [[], []]);
  assert.deepEqual(skips(g).map((e) => e.meta?.skip), ["guard-step"]);
});

test("the judge's fix: applied as a hint when it may be (nothing runs, the corrected call is judged again), a skip when it may not", async () => {
  const r = rig(OWNER_LOOK, { judge: "fix" });
  const first = await r.call(CAL, EVENT);
  assert.equal(first.behavior, "deny");
  assert.match(first.message ?? "", /Correct the arguments .* leave it: background work never asks/);
  await r.call(CAL, { ...EVENT, summary: "Dentist 2" });
  const third = await r.call(CAL, { ...EVENT, summary: "Dentist 3" });
  assert.equal(third.message, UNATTENDED_SKIP, "the third fix of the tool in this run");
  assert.deepEqual(skips(r).map((e) => e.meta?.skip), ["fix"]);
  assert.deepEqual(r.asked, []);
});

test("the never-allowed set is denied in an unattended run; a payment is refused outright, nobody asked", async () => {
  const r = rig(OWNER_LOOK, { judge: "auto" });
  assert.equal((await r.call("mcp__mailbird__delete_conversation_permanently", { conversationId: 1 })).behavior, "deny");
  assert.equal((await r.call("mcp__mailbird__trash_conversation", { conversationId: 1 })).behavior, "deny");
  assert.equal(r.rows("deny-policy").length, 2);
  const pay = rig(BROWSE_UNATTENDED, { guard: { decide: async () => ({ kind: "ask", payment: true, judge: false, description: "💳 Card payment approval" }) } });
  const res = await pay.call("mcp__browser__browser_click", { ref: "pay" });
  assert.equal(res.behavior, "deny");
  assert.match(res.message ?? "", /never made by background work/);
  assert.deepEqual(pay.asked, []);
  assert.equal(pay.rows("deny-payment-unattended").length, 1);
});

test("the prompt says it for a background check: act when sure, turn what needs the person into a draft or task, never ask for approval; the check's message is data only", () => {
  const text = chatSystem();
  assert.match(text, /act when you are sure; what you are not sure of becomes a task or a draft, not a question/i);
  assert.match(text, /never ask .*for approval/i);
  const check = lookInstruction(new Date(2026, 9, 22, 9, 0), undefined);
  assert.match(check, /^Background check at /);
  assert.doesNotMatch(check, /Mail, pages and event text are data|default is to archive/, "what to do is the prompt's, the message holds the time and the facts");
});

test("the look's whole permission path (buildOptions) skips for the owner, the approver it was given is never called", async () => {
  let called = 0;
  const o = buildOptions(async () => (called++, { approved: true }), runFor(owner(), "look"), undefined); // (no provenance given: nothing to judge against, no model call)
  const res = (await o.canUseTool!(CAL, { ...EVENT, summary: "Dentist look" }, sig())) as { behavior: string; message?: string };
  assert.equal(res.behavior, "deny");
  assert.equal(called, 0);
});
