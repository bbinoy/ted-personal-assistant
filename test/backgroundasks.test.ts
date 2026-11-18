import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { standing, tick } from "./util.ts";
import { readAudit } from "../src/core/audit.ts";
import { makeCanUseTool, type CallGuard } from "../src/approvals/permissions.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import * as approvals from "../src/approvals/approvals.ts";
import { makeApprove } from "../src/approvals/approvalask.ts";
import { declinedAgo, resetDeclined } from "../src/approvals/declined.ts";
import { createApprovers } from "../src/approvals/approvers.ts";
import { handoffFor, setContinuation } from "../src/approvals/handoff.ts";
import { runFor } from "../src/run/runoptions.ts";
import { group, owner } from "../src/conversation/conversationmodel.ts";
import { clearQuiet, setQuiet } from "../src/conversation/quiet.ts";
import { heldPosts, resetHeld, submitPost } from "../src/heartbeat/notices.ts";
import { OWNER_CONV } from "../src/core/convpaths.ts";
import { settings } from "../src/core/settings.ts";
import { FRIEND_LOOK, GROUP_LOOK, OWNER_LOOK } from "./runkinds.ts";
import type { RunKind } from "../src/core/runkind.ts";

// EVERY RUN MAY ASK (the owner, 18 Nov): a background run's judge-ask goes to the conversation's chat through the same ask path as a chat turn, handed off so the run carries on;
// a yes runs the call later as a grant; nothing answered lapses after a day; quiet hours hold the question; a payment still needs the card holder's typed YES. Fakes only.
(settings as { warm: boolean }).warm = false;
const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;

const CAL = "mcp__mailbird__create_calendar_event";
const sig = () => ({ signal: new AbortController().signal }) as never;
const says = (decision: Verdict["decision"]) => async (): Promise<Verdict> => ({ decision, reason: "test" });
const BROWSE_BG: RunKind = { who: "browse", attended: false };
let n = 0;
let ts = 7000;
const event = () => ({ summary: `Dentist ${++n}`, startTime: "2026-10-23T10:00:00", endTime: "2026-10-23T11:00:00" });
const continued: { scope: string; prompt: string }[] = [];
setContinuation((scope, prompt) => void continued.push({ scope, prompt }));
const sent: { to?: string; text: string; ts: number }[] = [];
const out = { reply: async (text: string, o: { plain: true; kind: "approval"; target?: string }) => (sent.push({ to: o.target, text, ts: ++ts }), ts) };
const compose = async (q: { details: string }) => ({ text: `Shall I? ${q.details.split("\n")[0]}`, ms: 0 });
const approverFor = (hold?: (key: string, text: string) => boolean) => createApprovers(out, { hold, target: (id) => `+${id}`, make: (send, o) => makeApprove(send, { ...o, compose: compose as never }) });
after(() => {
  for (const m of sent) for (const scope of ["owner", "g-bgask", "tenant:fr"]) approvals.answerReaction("👎", m.ts, scope); // (no question stays open: its timer would keep the process alive)
});

function rig(kind: RunKind, key: string, o: { judge?: Verdict["decision"]; guard?: CallGuard; tools?: ReadonlySet<string>; hold?: (key: string, text: string) => boolean } = {}) {
  const mark = readAudit(() => true).length;
  const approve = approverFor(o.hold)(key, { background: true });
  const can = makeCanUseTool(approve, kind, undefined, says(o.judge ?? "ask"), o.guard, o.tools, false, { provenance: standing("the fixed look"), conversation: key });
  const call = async (tool: string, input: Record<string, unknown>) => (await can(tool, input, sig())) as { behavior: string; message?: string };
  const rows = (decision: string) => readAudit(() => true).slice(mark).filter((e) => e.decision === decision);
  return { call, rows };
}

test("which runs are unattended: a look of any conversation; a message turn never (what attendance still changes: the tools, not the questions)", () => {
  assert.equal(runFor(owner(), "look").kind.attended, false);
  assert.equal(runFor(owner(), "message").kind.attended, true);
  assert.equal(runFor(group("g-unattended"), "look").kind.attended, false);
});

test("a look's judge-ask puts a question to the owner's chat and the look carries on: handed off, no skip row, stored once, never twice", async () => {
  const r = rig(OWNER_LOOK, "owner");
  const input = event();
  const before = sent.length;
  const res = await r.call(CAL, input);
  assert.equal(res.behavior, "deny");
  assert.match(res.message ?? "", /Asked .*; it runs on their yes/);
  assert.equal(sent.length, before + 1, "one question, in the owner's chat");
  assert.equal(sent.at(-1)!.to, undefined);
  assert.deepEqual([r.rows("background-skip").length, r.rows("ask-sent").length, r.rows("ask-handed-off").length], [0, 1, 1]);
  const again = await r.call(CAL, input);
  assert.match(again.message ?? "", /already asked/);
  assert.equal(sent.length, before + 1, "no duplicate question");
  approvals.answerReaction("👎", sent.at(-1)!.ts, "owner");
});

test("a group's look asks in that group, under its own rules, never in the owner's chat", async () => {
  const r = rig(GROUP_LOOK, "g-bgask", { tools: new Set([CAL]) });
  const before = sent.length;
  assert.match((await r.call(CAL, event())).message ?? "", /Asked/);
  assert.deepEqual(sent.slice(before).map((m) => m.to), ["g-bgask"]);
  approvals.answerReaction("👎", sent.at(-1)!.ts, "g-bgask");
});

test("a yes to a look's question becomes a grant: the call runs once when it is made again, in the same conversation", async () => {
  const r = rig(OWNER_LOOK, "owner");
  const input = event();
  await r.call(CAL, input);
  const c0 = continued.length;
  assert.equal(approvals.answerReaction("👍", sent.at(-1)!.ts, "owner"), "approved");
  await tick();
  assert.equal(continued.length, c0 + 1, "a turn continues the conversation with the approved call");
  assert.equal((await r.call(CAL, input)).behavior, "allow");
  assert.equal(r.rows("granted-run").length, 1);
  assert.notEqual((await r.call(CAL, input)).behavior, "allow", "single use");
});

test("a question nobody answers lapses after a day, not before: nothing runs and the next run is told", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(approvals.APPROVAL_TIMEOUT_MINUTES, 24 * 60);
    const r = rig(OWNER_LOOK, "owner");
    await r.call(CAL, event());
    const open = approvals.openCount("owner");
    mock.timers.tick(24 * 3_600_000 - 60_000);
    assert.equal(approvals.openCount("owner"), open, "still open a minute before the day is out");
    const lapsedBefore = approvals.lapsedIn("owner").length;
    mock.timers.tick(61_000);
    assert.equal(approvals.openCount("owner"), open - 1);
    assert.equal(approvals.lapsedIn("owner").length, lapsedBefore + 1, "a journal line says it lapsed");
    assert.equal(r.rows("granted-run").length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("quiet hours hold a background question as a held post for the next look: nothing is sent, nothing runs", async () => {
  const conv = { kind: "owner", key: "owner", convId: OWNER_CONV } as const;
  const NOW = new Date(2026, 9, 14, 14, 30, 20);
  setQuiet(conv, new Date(NOW.getTime() + 3_600_000).toISOString()); // /quiet holds, whatever the hour
  resetHeld(conv);
  const hold = (_k: string, text: string) => submitPost(owner(), text, false, NOW) === "held";
  const r = rig(OWNER_LOOK, "owner", { hold });
  const before = sent.length;
  const res = await r.call(CAL, event());
  assert.match(res.message ?? "", /Not asked now: it is quiet hours/);
  assert.equal(sent.length, before, "nothing was sent");
  assert.equal(r.rows("ask-held").length, 1);
  assert.equal(heldPosts(conv).length, 1);
  assert.match(heldPosts(conv)[0]!.text, /propose it again/i);
  resetHeld(conv);
  clearQuiet(conv);
});

test("a payment from a background run asks like a foreground one: a typed YES in the card holder's own chat; a thumbs-up or an ordinary reply never pays; a group's is refused", async () => {
  const pay: CallGuard = { decide: async () => ({ kind: "ask", payment: true, judge: false, description: "💳 Card payment approval\nMerchant: Shop" }) };
  const r = rig(BROWSE_BG, "owner", { guard: pay });
  const before = sent.length;
  const p = r.call("mcp__browser__browser_click", { ref: "pay" });
  await tick();
  assert.equal(sent.length, before + 1, "the payment question went to the owner's chat");
  assert.equal(r.rows("deny-payment-unattended").length, 0, "no special refusal for background work");
  assert.equal(approvals.answerReaction("👍", sent.at(-1)!.ts, "owner"), "needs_text", "a thumbs-up does not pay");
  const never = { judge: async () => ({ target: "A1", outcome: "approve" }) as never, recent: () => [] }; // (even a judge that reads it as a yes does not pay)
  const plain = await approvals.answer("ok, go for it", () => {}, undefined, never, { scope: "owner" });
  assert.notEqual(plain.outcome, "approved", "a plain yes-ish reply does not pay");
  assert.equal((await approvals.answer("YES", () => {}, undefined, never, { scope: "owner" })).outcome, "approved", "the typed YES does");
  assert.equal((await p).behavior, "allow");
  const g = rig({ who: "browse", attended: false }, "g-bgask", { guard: pay });
  const res = await g.call("mcp__browser__browser_click", { ref: "pay" });
  assert.equal(res.behavior, "deny");
  assert.match(res.message ?? "", /owner's own chat/);
});

test("the stale check: a yes that comes after the call changed does not run it and the run says so", async () => {
  const h = handoffFor({ conv: "owner", tool: CAL, input: event(), renderHash: "not-what-it-renders-now", label: "x", question: "q", provenance: undefined, untrusted: false, askedBy: "chat" } as never, 1440);
  h.sent(1, Date.now() + 60_000);
  const c0 = continued.length;
  h.decided({ approved: true });
  await tick();
  await tick();
  assert.equal(continued.length, c0 + 1);
  assert.match(continued.at(-1)!.prompt, /has changed since the question was sent[\s\S]*NOT run/);
  assert.equal(readAudit((e) => e.decision === "ask-stale").length > 0, true);
});

test("a friend's look asks in her own chat only, and nowhere else", async () => {
  const r = rig(FRIEND_LOOK, "tenant:fr", { tools: new Set([CAL]) });
  const before = sent.length;
  assert.match((await r.call(CAL, event())).message ?? "", /Asked/);
  assert.deepEqual(sent.slice(before).map((m) => m.to), ["+fr"]);
  assert.equal(approvals.answerReaction("👍", sent.at(-1)!.ts, "owner"), "ignored", "the owner's chat does not answer it");
  approvals.answerReaction("👎", sent.at(-1)!.ts, "tenant:fr");
});

// One answer rule for a look's question and a chat turn's: both go through approvals.answer, and an unquoted yes needs the question to be Ted's newest message.
test("a look's question: an unquoted yes after later messages does not answer it, a quoted one does, one right after does", async () => {
  const r = rig(OWNER_LOOK, "owner");
  const input = event();
  await r.call(CAL, input);
  const q = sent.at(-1)!.ts;
  const none = { judge: async () => assert.fail("no judge"), recent: () => [], latest: () => q + 50 } as never; // Ted spoke again after the question
  assert.deepEqual(await approvals.answer("yes", () => {}, undefined, none, { scope: "owner" }), { outcome: "none" });
  assert.deepEqual(await approvals.answer("YES", () => {}, undefined, none, { scope: "owner" }), { outcome: "none" });
  assert.equal(approvals.openCount("owner") > 0, true);
  const c0 = continued.length;
  assert.deepEqual(await approvals.answer("yes", () => {}, { timestamp: q }, none, { scope: "owner" }), { outcome: "approved" });
  await tick();
  assert.equal(continued.length, c0 + 1);
  const r2 = rig(OWNER_LOOK, "owner");
  await r2.call(CAL, event());
  const q2 = sent.at(-1)!.ts;
  const fresh = { judge: async () => assert.fail("no judge"), recent: () => [], latest: () => q2 } as never;
  assert.deepEqual(await approvals.answer("ok", () => {}, undefined, fresh, { scope: "owner" }), { outcome: "approved" });
});

test("a decline blocks a re-ask for the whole window, and so does a question that lapsed", async () => {
  resetDeclined();
  const input = event();
  const declineIt = async (r: ReturnType<typeof rig>) => {
    await r.call(CAL, input);
    approvals.answerReaction("👎", sent.at(-1)!.ts, "owner");
    await tick();
    await tick();
  };
  await declineIt(rig(OWNER_LOOK, "owner"));
  const day = 24 * 3_600_000;
  assert.notEqual(declinedAgo("owner", CAL, input, Date.now() + day - 60_000), undefined, "still declined 23 h 59 min later");
  assert.equal(declinedAgo("owner", CAL, input, Date.now() + day + 60_000), undefined);
  resetDeclined();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const r = rig(OWNER_LOOK, "owner");
    await r.call(CAL, input);
    mock.timers.tick(day + 1000);
    for (let k = 0; k < 20; k++) await Promise.resolve(); // (mock timers: tick() would wait on a real timer)
    assert.notEqual(declinedAgo("owner", CAL, input, Date.now()), undefined, "silence for the window counts as a decline");
  } finally {
    mock.timers.reset();
  }
});
