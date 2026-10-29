import { test } from "node:test";
import assert from "node:assert/strict";
import { tick } from "./util.ts";
import { settings } from "../src/core/settings.ts";
import { composeQuestion, type QuestionInput } from "../src/approvals/approvalmodel.ts";
import { judgeContext } from "../src/approvals/judgecontext.ts";
import { judgePrompt } from "../src/approvals/autojudge.ts";
import { APPROVAL_SYSTEM, parseCheck } from "../src/approvals/approvalprompt.ts";
import { discardJudge, runJudge } from "../src/approvals/approvaljudge.ts";
import { forgetSeen, peopleFor, rememberNames } from "../src/approvals/seennames.ts";

const CAL = "mcp__claude_ai_Google_Calendar__update_event";
const CONV = "owner";
const args = { eventId: "e1", calendarId: "primary", attendees: ["c.mignon@example.com"], sendUpdates: "all" };
const details = "Update calendar event e1: add guest c.mignon@example.com\nNotifies: c.mignon@example.com\nNamed: “Embassy reception”, Fri 21 Nov, 18:00";
const provenance = { kind: "owner", message: "add Christophe to the reception" } as const;
const input = (over: Partial<QuestionInput> = {}): QuestionInput => ({ tool: CAL, args, details, recent: [{ from: "owner", text: "add Christophe to the reception" }], source: "chat", conversation: CONV, provenance, untrusted: true, ...over });

const scripted = (steps: ((p: string) => unknown)[]) => {
  const prompts: string[] = [];
  return { prompts, run: async (p: string) => (prompts.push(p), steps.shift()!(p)) };
};
const write = (t: string) => () => ({ task: "write", text: t });
const GOOD = "Add Christophe Mignon (c.mignon@example.com) as a guest to “Embassy reception” on Fri 21 Nov, 18:00? He gets an invitation. OK to go ahead?";
const read = () => rememberNames(CONV, JSON.stringify([{ id: "m1", subject: "Reception", from: "Christophe Mignon <c.mignon@example.com>" }]));

test("seen names: a name a read gave to an address is a fact for that address, from JSON or from Name <address> text", () => {
  forgetSeen();
  rememberNames(CONV, JSON.stringify({ messages: [{ id: "m1", subject: "Reception", from: "Christophe Mignon <c.mignon@example.com>" }, { id: "m2", subject: "x", to: [{ name: "Ann Lee", email: "ann@example.com" }] }] }));
  rememberNames(CONV, "Reply to Bob Roe <bob@example.com> soon");
  assert.deepEqual(peopleFor(CONV, JSON.stringify(args)), ["Christophe Mignon <c.mignon@example.com>"]);
  assert.deepEqual(peopleFor(CONV, "ann@example.com, BOB@example.com"), ["Ann Lee <ann@example.com>", "Bob Roe <BOB@example.com>"]);
  assert.deepEqual(peopleFor("other", "ann@example.com"), [], "another conversation's reads are not facts here");
  assert.deepEqual(peopleFor(CONV, "zed@example.com"), []);
});

test("one context: the action judge, the writer and the check read the same fenced block", async () => {
  forgetSeen();
  read();
  const w = scripted([write(GOOD)]);
  const k = scripted([() => ({ task: "check", faithful: true, reason: "ok" })]);
  const c = await composeQuestion(input(), {}, 1000, w.run, k.run);
  assert.equal(c.text, GOOD);
  const ctx = judgeContext({ details, provenance, untrusted: true, recent: input().recent, names: ["Christophe Mignon <c.mignon@example.com>"] });
  assert.ok(w.prompts[0]!.includes(ctx), "the writer reads the shared context");
  assert.ok(k.prompts[0]!.includes(ctx), "the check reads the very same context");
  for (const part of ["PROVENANCE: owner message", "untrusted_input_in_run: true", "<recent_messages>", "add Christophe to the reception", "<seen_names>", "Christophe Mignon <c.mignon@example.com>", "<action>", "Embassy reception"]) assert.ok(ctx.includes(part), part);
  assert.ok(judgePrompt({ description: details, provenance, untrustedInput: true }).includes("PROVENANCE: owner message"), "the action task is built by the same function");
  assert.doesNotMatch(w.prompts[0]!, /Details rendered by code/, "no per-task copy of the details");
});

test("the Christophe case: a name the seen names tie to the address is faithful; an invented notification is refused with a reason the writer acts on", async () => {
  forgetSeen();
  read();
  // a stand-in for the model's rule: the name is accepted when the context carries it; a claim about who else is notified is not
  const check = (p: string) => {
    const q = p.slice(p.indexOf("<question>"));
    const named = !q.includes("Christophe Mignon") || p.includes("<seen_names>\nChristophe Mignon <c.mignon@example.com>");
    const invented = /Ben will be notified/.test(q);
    return { task: "check", faithful: named && !invented, reason: invented ? "claims Ben will be notified too" : "ok" };
  };
  const invented = "Add Christophe Mignon (c.mignon@example.com) to “Embassy reception” on Fri 21 Nov, 18:00? Ben will be notified too. OK?";
  const w = scripted([write(invented), write(GOOD)]);
  const c = await composeQuestion(input(), {}, 1000, w.run, scripted([check, check]).run);
  assert.equal(c.text, GOOD);
  assert.match(w.prompts[1]!, /refused by the checker: "claims Ben will be notified too"/);
  // without the seen name the same question is not supported
  forgetSeen();
  const none = await composeQuestion(input(), {}, 1000, scripted([write(GOOD)]).run, scripted([check]).run);
  assert.equal(none.text, undefined);
});

test("the check accepts what the context supports and stays strict; the writer adds nothing unsupported", () => {
  assert.match(APPROVAL_SYSTEM, /neither the details nor the context support/);
  assert.match(APPROVAL_SYSTEM, /a person's name that a seen name or the recent chat ties to that address/);
  assert.match(APPROVAL_SYSTEM, /who else is notified or affected when the details do not say/);
  assert.match(APPROVAL_SYSTEM, /Recipients, attachments, verbatim text and card payments stay exactly as strict/);
  assert.match(APPROVAL_SYSTEM, /never say who else is notified or affected unless the details say so/);
  assert.equal(parseCheck({ faithful: "true" }).faithful, false);
});

test("warm for every task: write, check, answer and action run on a spare prepared after the one before", async () => {
  const was = settings.warm;
  (settings as { warm: boolean }).warm = true;
  try {
    discardJudge();
    let started = 0;
    let nextTask = "write";
    const stream = () => (async function* () { yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0, result: "", structured_output: { task: nextTask, faithful: true } }; })();
    const io = { start: (async () => (started++, { query: stream, close() {} })) as never, query: stream as never };
    const prepared = async (n: number) => { for (let i = 0; i < 100 && started < n; i++) await tick(); }; // the spare starts on a later turn of the event loop: wait for it, not for one tick
    assert.equal((await runJudge("write", "p", io))?.warm, false); // nothing was prepared yet
    let n = 1;
    for (const task of ["check", "answer", "action"] as const) {
      await prepared(n++);
      nextTask = task;
      assert.equal((await runJudge(task, "p", io))?.warm, true, `${task} is warm`);
    }
    await prepared(4);
    assert.equal(started, 4, "and one is ready for the next task");
  } finally {
    discardJudge();
    (settings as { warm: boolean }).warm = was;
  }
});
