import { test } from "node:test";
import assert from "node:assert/strict";
import { createPipeline, group, owner, type Conversation, type Incoming } from "../src/conversation/conversation.ts";
import { createOutbound } from "../src/conversation/outbound.ts";
import { LATE_NOTE } from "../src/conversation/group.ts";
import { replayPrompt, replayUnanswered, SORRY, unansweredSince } from "../src/conversation/replay.ts";
import { settings } from "../src/core/settings.ts";
import type { AuditEntry } from "../src/core/audit.ts";
import { recordMessage, type Sent } from "../src/core/messages.ts";
import { FULL_CAPABILITIES } from "@ted-assistant/messenger/testing";

// Replay and the one intake: what a restart lost is put through the same chain as a new message (intake.ts), in every kind of conversation.

const NOW = Date.parse("2026-10-14T12:00:00Z");
const GID = "UmVwbGF5R3JvdXA=";
const EVE = "+15555550105";
const OWNER = "+10000000000";
const line = (minAgo: number, kind: Sent["kind"], text: string, extra: Partial<Sent> = {}): Sent => {
  const ts = NOW - minAgo * 60_000;
  return { ts, at: new Date(ts).toISOString(), kind, text, ...extra };
};
const member = (minAgo: number, text: string, addressed = false): Sent => line(minAgo, "member", `Eve (a member): ${text}`, { by: EVE, ...(addressed ? { addressed: true as const } : {}) });
const act = { act: true, delaySeconds: 0, nextCheckMinutes: 30 };
const row = (minAgo: number, tool: string, source: AuditEntry["source"]): AuditEntry => ({ ts: new Date(NOW - minAgo * 60_000).toISOString(), source, tool, decision: "allow" });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

// A real pipeline over a fake messenger. `log` is what the conversation's log says; the gate and the runs are fakes that count themselves.
function rig(over: { gate?: () => Promise<typeof act | { act: false; delaySeconds: number; nextCheckMinutes: number }>; approval?: "none" | "approved" } = {}) {
  const sent: string[] = [];
  const records: { kind: string; text: string; extra?: unknown }[] = [];
  const gates: number[] = [];
  const groupRuns: string[] = [];
  const privateRuns: { conv: string; prompt: string }[] = [];
  const steps: string[] = [];
  const messenger = { name: "fake", summary: "fake", self: "+10000000001", capabilities: FULL_CAPABILITIES, react: async () => {}, typing: async () => {}, markRead: async () => {}, send: async (_t: unknown, m: { text: string }) => (sent.push(m.text), 1) };
  const record = (_t: unknown, kind: string, _ts: number, text: string, extra?: unknown) => void (kind !== "wake" && records.push({ kind, text, extra }));
  const pipeline = createPipeline({
    messenger,
    out: createOutbound(messenger, (k, t, text, g) => record(g, k, t, text)),
    record,
    run: async (conv, prompt) => (steps.push("turn"), privateRuns.push({ conv: conv.key, prompt }), { text: "done" }),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => assert.fail("no voice"),
    speech: { ready: () => false, synth: async () => assert.fail("no speech"), foreign: async () => undefined },
    approvals: { answer: async () => (steps.push("approval"), { outcome: over.approval ?? ("none" as const) }), answerReaction: () => "ignored" },
    feedback: { message: async () => (steps.push("feedback"), undefined), reaction: async () => undefined },
    vouch: async () => true,
    isOwner: (w) => w.from === OWNER,
    group: {
      recent: () => [],
      context: () => ({ lines: [] }),
      warm: () => {},
      gate: async () => (gates.push(1), (await over.gate?.()) ?? act),
      run: async (build) => (steps.push("turn"), groupRuns.push(build().prompt), "Back now"),
    },
    wait: async () => {},
  });
  return { pipeline, sent, records, gates, groupRuns, privateRuns, steps };
}

const tenantLike = (): Conversation => ({ ...owner(), kind: "tenant", key: "tenant:t1", convId: "friend-t1" as never, tenantId: "t1", target: "friend-target" });

function run(r: ReturnType<typeof rig>, convs: Conversation[], logs: Record<string, Sent[]>, audit: AuditEntry[] = []) {
  const told: string[] = [];
  const silence = console.log;
  console.log = () => {};
  let n: number;
  try {
    n = replayUnanswered({ pipeline: r.pipeline, conversations: () => convs, now: () => NOW, read: (c) => logs[c.key] ?? [], audit: () => audit, tell: async (_c, text) => void told.push(text) });
  } finally {
    console.log = silence;
  }
  return { n, told };
}

test("replay: an addressed group message logged just before a restart is answered once, late", async () => {
  const r = rig({ gate: async () => assert.fail("an address needs no gate") });
  const g = group(GID);
  const { n, told } = run(r, [g], { [g.key]: [member(5, "@Ted when is the game?", true)] });
  await settle();
  assert.equal(n, 1);
  assert.deepEqual(told, []);
  assert.equal(r.groupRuns.length, 1, "answered once");
  assert.match(r.groupRuns[0]!, /You were addressed[\s\S]*when is the game\?/);
  assert.ok(r.groupRuns[0]!.includes(LATE_NOTE), "and says it is late");
  assert.deepEqual(r.sent, ["Back now"]);
  assert.deepEqual(r.records.filter((x) => x.kind === "member"), [], "replay writes no second copy of the line");
});

test("replay: untagged group chatter is not answered unless the gate, asked again on the tail, says act", async () => {
  const g = group(GID);
  const logs = { [g.key]: [member(5, "so who is bringing the ball?")] };
  const quiet = rig({ gate: async () => ({ act: false, delaySeconds: 0, nextCheckMinutes: 30 }) });
  run(quiet, [g], logs);
  await settle();
  assert.deepEqual([quiet.gates.length, quiet.groupRuns.length, quiet.sent.length], [1, 0, 0], "the gate looked once and said no: as unanswered as it would have been");
  const chatty = rig();
  run(chatty, [g], logs);
  await settle();
  assert.deepEqual([chatty.gates.length, chatty.groupRuns.length], [1, 1]);
  assert.doesNotMatch(chatty.groupRuns[0]!, /You were addressed/);
  assert.ok(chatty.groupRuns[0]!.includes(LATE_NOTE));
  // in "tagged" mode an unaddressed line can never be answered, so nothing is even asked
  const was = settings.groupParticipation;
  (settings as { groupParticipation: string }).groupParticipation = "tagged";
  try {
    const tagged = rig({ gate: async () => assert.fail("no gate in tagged mode") });
    run(tagged, [g], logs);
    await settle();
    assert.deepEqual([tagged.gates.length, tagged.groupRuns.length], [0, 0]);
  } finally {
    (settings as { groupParticipation: string }).groupParticipation = was;
  }
});

test("replay: a burst of group lines is one turn that answers the address", async () => {
  const r = rig();
  const g = group(GID);
  run(r, [g], { [g.key]: [member(6, "hello all"), member(5, "@Ted any ideas?", true), member(4, "me too")] });
  await settle();
  assert.equal(r.groupRuns.length, 1);
  assert.equal(r.gates.length, 0, "the address is answered whatever the gate would say");
});

test("replay: the run may have acted before it died: nothing is run again, and someone who was waiting is told", async () => {
  const g = group(GID);
  const addressed = rig();
  const a = run(addressed, [g], { [g.key]: [member(5, "@Ted put the game in the calendar", true)] }, [row(4, "mcp__calendar__create_event", "group")]);
  await settle();
  assert.deepEqual([addressed.groupRuns.length, addressed.gates.length, a.told], [0, 0, [SORRY]]);
  const chatter = rig();
  const c = run(chatter, [g], { [g.key]: [member(5, "so who is bringing the ball?")] }, [row(4, "mcp__calendar__create_event", "group")]);
  await settle();
  assert.deepEqual([chatter.groupRuns.length, chatter.gates.length, c.told], [0, 0, []], "nobody waited for chatter: nothing is said");
  const priv = rig();
  const p = run(priv, [owner()], { owner: [line(5, "owner", "put dinner in my calendar", { by: OWNER })] }, [row(4, "mcp__calendar__create_event", "chat")]);
  await settle();
  assert.deepEqual([priv.privateRuns.length, p.told], [0, [SORRY]]);
});

test("replay: the owner's and a friend's lines are one late turn each, as before; answered chats and empty logs do nothing", async () => {
  const r = rig();
  const t = tenantLike();
  const logs: Record<string, Sent[]> = { owner: [line(6, "owner", "where is my 3pm?", { by: OWNER }), line(5, "owner", "and my 4pm?", { by: OWNER })], [t.key]: [line(5, "owner", "hi", { by: "u-1" }), line(4, "chat", "hello")], other: [] };
  const { n } = run(r, [owner(), t, { ...t, key: "tenant:t2" } as Conversation], logs);
  await settle();
  assert.equal(n, 1);
  assert.equal(r.privateRuns.length, 1);
  assert.equal(r.privateRuns[0]!.conv, "owner");
  assert.match(r.privateRuns[0]!.prompt, /These 2 messages arrived, oldest first, shortly before the assistant restarted[\s\S]*where is my 3pm\?[\s\S]*and my 4pm\?/);
  const friend = rig();
  run(friend, [t], { [t.key]: [line(5, "owner", "can you check my list?", { by: "u-1" })] });
  await settle();
  assert.deepEqual(friend.privateRuns.map((x) => x.conv), [t.key]);
  assert.match(friend.privateRuns[0]!.prompt, /This message arrived shortly before the assistant restarted/);
});

test("replay: an approval answer, an edit and a deleted message are not replayed; at most ten lines", () => {
  const approval = [line(10, "approval", "Send this email?"), line(9, "member", "Eve (a member): yes"), line(5, "member", "Eve (a member): and then book a table")];
  assert.deepEqual(unansweredSince(approval, NOW).map((m) => m.text), ["Eve (a member): and then book a table"], "only the line right after the question is its answer");
  const deleted = [line(10, "member", "Eve (a member): oops", { ts: 111 }), line(9, "delete", "[deleted]", { of: 111 })];
  assert.deepEqual(unansweredSince(deleted, NOW), []);
  const edited = [line(10, "member", "Eve (a member): tea at 5", { ts: 222, addressed: true }), line(9, "edit", "Eve (a member): tea at 6", { of: 222, ts: 223 })];
  const got = unansweredSince(edited, NOW);
  assert.deepEqual([got.length, got[0]!.text, got[0]!.addressed], [1, "Eve (a member): tea at 6", true], "once, in its newest version, still addressed");
  const many = Array.from({ length: 14 }, (_, i) => line(20 - i, "owner", `m${i}`));
  assert.deepEqual(unansweredSince(many, NOW).map((m) => m.text), many.slice(-10).map((m) => m.text));
  assert.match(replayPrompt([{ at: "x", text: "y" }]), /check whether it was already done/);
});

// ---- one intake: the same message goes through the same steps in a private chat and in a group ----

const say = (conv: Conversation, text: string, over: object = {}): Incoming => ({ type: "message", m: conv.direct ? { from: OWNER, text, timestamp: 900, direct: true, ...over } : { from: EVE, text, timestamp: 900, direct: false, group: { id: GID }, addressedToMe: true, fromName: "Eve", ...over } });

test("one intake: an ordinary message runs the same steps for every kind of conversation; feedback is the one table row that differs", async () => {
  const steps: Record<string, string[]> = {};
  for (const conv of [owner(), tenantLike(), group(GID)]) {
    const r = rig();
    await r.pipeline.handleIncoming(conv, say(conv, "what is on today?"));
    steps[conv.kind] = [r.records.length ? "record" : "", ...r.steps].filter(Boolean);
    assert.equal(r.records[0]!.kind, conv.direct ? "owner" : "member");
    assert.deepEqual(r.sent.length, 1, `${conv.kind} answered`);
  }
  assert.deepEqual(steps.owner, ["record", "approval", "feedback", "turn"]);
  assert.deepEqual(steps.tenant, steps.owner);
  assert.deepEqual(steps.group, ["record", "approval", "turn"], "a shared group offers no per-person feedback");
});

test("one intake: a command is answered in code in every conversation that has the capability, and an approval answer is consumed in all of them", async () => {
  const stop = [] as string[];
  for (const conv of [owner(), group(GID)]) {
    const r = rig();
    await r.pipeline.handleIncoming(conv, say(conv, "/stop"));
    stop.push(`${conv.kind}: ${r.sent[0]}`);
    assert.deepEqual(r.steps, [], "no model, no approval check: a command is code only");
  }
  assert.deepEqual(stop, ["owner: Nothing is running right now.", "group: Nothing is running right now."]);
  // /pause needs "admin": the owner's capability, not a group's
  const o = rig();
  await o.pipeline.handleIncoming(owner(), say(owner(), "/status"));
  assert.match(o.sent[0]!, /^Running/);
  const g = rig();
  await g.pipeline.handleIncoming(group(GID), say(group(GID), "/status"));
  assert.deepEqual([g.sent.length, g.steps], [1, ["approval", "turn"]], "in a group /status is just a message");
  // an approval answer is consumed, never run
  for (const conv of [owner(), tenantLike(), group(GID)]) {
    const a = rig({ approval: "approved" });
    await a.pipeline.handleIncoming(conv, say(conv, "yes"));
    assert.deepEqual(a.steps, ["approval"], conv.kind);
  }
});

test("one intake: an edit is a new line in both kinds, never a command, an approval answer or feedback", async () => {
  for (const conv of [owner(), group(GID)]) {
    recordMessage(conv.direct ? "owner" : "member", 900, conv.direct ? "stop" : "Eve (a member): stop", new Date(), conv.logFile, { by: conv.direct ? OWNER : EVE });
    const r = rig({ approval: "approved" });
    await r.pipeline.handleIncoming(conv, say(conv, "/stop", { timestamp: 901, edited: { targetTimestamp: 900 } }));
    assert.deepEqual(r.steps, ["turn"], conv.kind); // answered like any message; "/stop" in an edit stops nothing and "approved" is never asked
    assert.deepEqual(r.records.map((x) => x.kind), ["edit", "chat"], conv.kind);
    assert.equal(r.sent[0], conv.direct ? "done" : "Back now");
  }
});
