import { test } from "node:test";
import assert from "node:assert/strict";
import { tick as settle } from "./util.ts";
import { answer, request } from "./approvalrig.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { resetDeclined } from "../src/approvals/declined.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import type { AnswerDeps } from "../src/approvals/approvals.ts";
import type { AnswerJudgement } from "../src/approvals/approvalprompt.ts";
import { settings } from "../src/core/settings.ts";
import { OWNER_CHAT } from "./runkinds.ts";

(settings as { warm: boolean }).warm = false;
const CREATE = "mcp__claude_ai_Google_Calendar__create_event";
const opts = { signal: new AbortController().signal } as never;
const judging = (j: AnswerJudgement): AnswerDeps => ({ judge: async () => j, recent: () => [] });
const ask: () => Promise<Verdict> = async () => ({ decision: "ask", reason: "the call does not match the request" });

// The 20 October incident, first half: the create is asked, the owner answers with a CHANGE, the old question closes, the agent re-proposes in the same turn.
test("a change as the reply closes the open question; the agent re-proposes and exactly one question is open", async () => {
  resetDeclined();
  let ts = 70_000;
  const sent: string[] = [];
  const approve = (description: string, call: { tool: string; input: Record<string, unknown> }, signal: AbortSignal) => request(async (t) => (sent.push(t), ++ts), description, call, signal, { question: description });
  const canUse = makeCanUseTool(approve as never, OWNER_CHAT, undefined, ask as never, undefined, undefined, false, { provenance: () => ({ kind: "owner", message: "coffee tomorrow with Benjamin" }), conversation: "owner" });
  const first = canUse(CREATE, { summary: "Coffee", startTime: "2026-10-21T10:00:00", endTime: "2026-10-21T11:00:00" }, opts);
  await settle();
  // "Make it 9-10 and invite Benjamin": neither yes nor no, and not an allowed edit
  const r = await answer("Make it 9-10 and invite Benjamin", () => {}, undefined, judging({ target: "A1", outcome: "other" }));
  assert.deepEqual(r, { outcome: "feedback" }, "consumed, nothing is said to the owner by the judge");
  const denied = (await first) as { behavior: string; message: string };
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message, /question is closed/);
  assert.match(denied.message, /Make a new proposal now, in this turn/);
  assert.match(denied.message, /Make it 9-10 and invite Benjamin/);
  assert.deepEqual(await answer("yes", () => {}, undefined, judging({ target: "none", outcome: "unrelated" })), { outcome: "none" }, "no old approval is left open");
  // the re-proposal is a fresh question; the owner says yes to it
  const second = canUse(CREATE, { summary: "Coffee", startTime: "2026-10-21T09:00:00", endTime: "2026-10-21T10:00:00", attendees: ["benjamin@example.com"] }, opts);
  await settle();
  assert.equal(sent.length, 2);
  assert.deepEqual(await answer("yes", () => {}, undefined, { recent: () => [] }), { outcome: "approved" });
  assert.equal(((await second) as { behavior: string }).behavior, "allow");
});

test("a reply that supersedes is not a decline: the same action can be proposed again without the declined notice", async () => {
  resetDeclined();
  const sent: string[] = [];
  let ts = 71_000;
  const approve = (description: string, call: { tool: string; input: Record<string, unknown> }, signal: AbortSignal) => request(async (t) => (sent.push(t), ++ts), description, call, signal, { question: description });
  const canUse = makeCanUseTool(approve as never, OWNER_CHAT, undefined, ask as never, undefined, undefined, false, { provenance: () => ({ kind: "owner", message: "m" }), conversation: "owner" });
  const input = { summary: "Dinner", startTime: "2026-10-21T19:00:00" };
  const p = canUse(CREATE, input, opts);
  await settle();
  await answer("later", () => {}, undefined, judging({ target: "A1", outcome: "other" }));
  await p;
  const again = canUse(CREATE, input, opts);
  await settle();
  assert.doesNotMatch(sent[1]!, /declined/);
  await answer("no", () => {}, undefined, { recent: () => [] });
  await again;
});

test("a newer question about the same action closes the older one; different actions stay open together", async () => {
  let ts = 72_000;
  const send = async () => ++ts;
  const a = request(send, "Create A", { tool: CREATE, input: { summary: "A", startTime: "2026-10-21T09:00:00" } });
  const b = request(send, "Create B", { tool: CREATE, input: { summary: "B", startTime: "2026-10-21T09:00:00" } });
  await settle();
  const a2 = request(send, "Create A again", { tool: CREATE, input: { summary: "A", startTime: "2026-10-21T10:00:00" } });
  assert.deepEqual(await a, { approved: false, superseded: true }, "same title, same day: the same action");
  await settle();
  const r = await answer("no to all", () => {}, undefined, judging({ target: "multi", outcome: "multi", answers: [{ target: "A1", outcome: "decline" }, { target: "A2", outcome: "decline" }] }));
  assert.equal(r.outcome, "declined");
  assert.deepEqual([(await b).approved, (await a2).approved], [false, false]);
});
