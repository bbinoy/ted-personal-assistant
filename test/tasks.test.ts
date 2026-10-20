import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES } from "../src/profiles.ts";
import { group, owner, type Conversation } from "../src/conversation.ts";
import { parseGate } from "../src/gate.ts";
import { recordMessage, type Kind } from "../src/messages.ts";
import { HEARTBEAT_SCHEMA } from "../src/heartbeat/rules.ts";
import { settings } from "../src/settings.ts";
import { briefOwed, briefTask, buildTask } from "../src/tasks.ts";
import { lookState } from "../src/ledger.ts";
import { ledgerEntries } from "../src/messages.ts";
import { createWakeups } from "../src/wake.ts";

const s = settings as unknown as Record<string, unknown>;
const T0 = new Date(2026, 9, 14, 9, 0, 0); // a Wednesday, 09:00 local
const min = (m: number) => new Date(T0.getTime() + m * 60_000);

interface Rig { profiles: string[]; order: string[]; gates: string[]; briefs: string[]; notices: string[]; groupRuns: string[]; prompts: string[]; recorded: [string, string][] }
function rig(o: { gate?: (conv: Conversation) => unknown; brief?: "ok" | "incomplete" | "throw"; groups?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tasks-"));
  mkdirSync(join(dir, "n"));
  const conv: Conversation = { ...owner(), logFile: `logs/tasks-owner-${Math.random().toString(36).slice(2)}.jsonl`, notesDir: join(dir, "n") };
  const r: Rig = { profiles: [], order: [], gates: [], briefs: [], notices: [], groupRuns: [], prompts: [], recorded: [] };
  let now = T0;
  const pipeline = {
    canSpeak: () => false,
    enqueue: <T>(_c: Conversation, job: () => Promise<T>) => job(),
    record: (c: Conversation, kind: Kind, ts: number, text: string) => (r.recorded.push([kind, text]), recordMessage(kind, ts, text, now, c.kind === "owner" ? conv.logFile : c.logFile)),
    runTurn: async (_c: Conversation, turn: any) => {
      try {
        const { text } = await turn.run();
        return { spoke: text.trim() !== "[[silent]]" };
      } catch (e) {
        return { spoke: false, error: e };
      }
    },
  };
  const w = createWakeups({
    pipeline: pipeline as any,
    groupChats: true,
    vouch: async () => true,
    runProfile: async (profile, prompt, extra) => {
      r.profiles.push(profile);
      r.prompts.push(prompt);
      if (profile === "brief") {
        r.order.push("brief-run");
        if (o.brief === "throw") throw new Error("boom");
        if (o.brief !== "incomplete") extra?.onToolSuccess?.("mcp__mailbird__send_self_briefing", { markdownBody: "# Brief\nFocus: pottery" });
        return { text: o.brief === "incomplete" ? "mail tools down" : "done\nROUTINE_COMPLETE", costUsd: 0.1 };
      }
      if (profile === "heartbeat") return { text: "", costUsd: 0.01, structured: { message: "[[silent]]", nextCheckMinutes: 30 } }; // (the owner's look: test/heartbeatrun.test.ts)
      return { text: "Hello from background" };
    },
    presets: { sendBrief: async (m) => void r.briefs.push(m), notify: async (t) => void r.notices.push(t), beforeBrief: async () => void r.order.push("dream") },
    runGroup: async (build) => (r.groupRuns.push(build().prompt), "Group says hi"),
    gate: async ({ conv: c }) => (r.gates.push(c.kind), parseGate((o.gate ?? (() => ({ act: false, nextCheckMinutes: 30 })))(c))),
    groups: () => o.groups ?? [],
    context: () => ({ lines: ["Eve (a member): hi"], seenAt: undefined }),
    notesChangedAt: () => 0,
    now: () => now,
    guards: { paused: () => false, budgetSpent: () => false },
  });
  // The presets run as background jobs, so a look returns "brief-started"; these tests want how the run ended.
  const wake = { ...w, look: async (c: Conversation, d: Date) => { const res = await w.look(c, d); const done = await w.idle(); return res.endsWith("-started") ? done.at(-1)! : res; } };
  return { r, w: wake, raw: w, conv, at: (d: Date) => (now = d) };
}
const withSettings = async (over: Record<string, unknown>, f: () => Promise<void>) => {
  const was = Object.fromEntries(Object.keys(over).map((k) => [k, s[k]]));
  Object.assign(s, over);
  try {
    await f();
  } finally {
    Object.assign(s, was);
  }
};
const lines = (r: Rig, kind = "action") => r.recorded.filter(([k]) => k === kind).map(([, t]) => t);

test("profiles: named in code; brief and the heartbeat run are owner runs with their own source, limits and schema", () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ["background", "brief", "browse", "chat", "group", "handler", "heartbeat"]);
  assert.deepEqual([PROFILES.brief.source, PROFILES.brief.maxTurns, PROFILES.brief.maxBudgetUsd], ["brief", 120, 5]);
  assert.deepEqual([PROFILES.heartbeat.source, PROFILES.heartbeat.maxTurns, PROFILES.heartbeat.maxBudgetUsd], ["background", 120, 2]);
  assert.equal(PROFILES.heartbeat.outputSchema, HEARTBEAT_SCHEMA);
  assert.equal(PROFILES.heartbeat.model, settings.heartbeatModel);
  assert.equal(PROFILES.brief.outputSchema, undefined);
  assert.deepEqual([PROFILES.background.source, PROFILES.group.source], ["background", "group"]);
});

test("tasks: the brief is a fixed task; the gate's free-form task is for groups and friends only and fails closed", () => {
  const brief = briefTask();
  assert.deepEqual([brief.name, brief.profile, brief.after, brief.retries], ["brief", "brief", "brief", settings.briefMaxAttempts - 1]);
  assert.match(brief.instructions, /daily-brief/);
  assert.deepEqual(buildTask({ instructions: " say hi " }), { name: "task", instructions: "say hi", profile: "group", after: "post" });
  assert.equal(buildTask({}), undefined);
  // the gate cannot name a preset any more: an unknown field is dropped
  assert.equal("task" in parseGate({ act: true, task: "brief", instructions: "x" }), false);
});

test("the brief is due from its start hour, by code: the first look after it starts the brief, the gate is not asked", async () => {
  const { r, w, conv } = rig();
  assert.equal(await w.look(conv, T0), "brief-delivered");
  assert.deepEqual(r.order, ["dream", "brief-run"]);
  assert.deepEqual(r.profiles, ["brief"]);
  assert.deepEqual(r.briefs, ["# Brief\nFocus: pottery"]);
  assert.deepEqual(lines(r), ["[brief] attempt 1 started", "[brief] attempt 1 → delivered"]);
  assert.deepEqual(r.gates, [], "the owner has no gate");
  // once a day
  r.order.length = 0;
  assert.notEqual(await w.look(conv, min(40)), "brief-delivered");
  assert.deepEqual(r.order, []);
  // before the start hour: nothing; BRIEF_BACKSTOP_HOUR=24: never
  const early = rig();
  await early.w.look(early.conv, new Date(2026, 9, 14, 6, 59));
  assert.ok(!early.r.profiles.includes("brief"));
  await withSettings({ briefBackstopHour: 24 }, async () => {
    const off = rig();
    await off.w.look(off.conv, T0);
    assert.ok(!off.r.profiles.includes("brief"));
  });
  assert.equal(briefOwed(lookState([], T0), T0), "backstop");
});

test("brief retries: an incomplete attempt is retried by code after a gap, up to the cap, then the owner is told", async () => {
  await withSettings({ briefMaxAttempts: 3 }, async () => {
    const first = rig({ brief: "incomplete" });
    assert.equal(await first.w.look(first.conv, T0), "brief-incomplete");
    first.at(min(5));
    assert.notEqual(await first.w.look(first.conv, min(5)), "brief-incomplete", "too early");
    first.at(min(11));
    assert.equal(await first.w.look(first.conv, min(11)), "brief-incomplete");
    first.at(min(25));
    assert.equal(await first.w.look(first.conv, min(25)), "brief-incomplete");
    assert.equal(first.r.profiles.filter((p) => p === "brief").length, 3);
    assert.match(first.r.notices.at(-1)!, /failed 3 times/);
    first.at(min(60));
    assert.notEqual(await first.w.look(first.conv, min(60)), "brief-incomplete"); // the cap holds
    assert.equal(first.r.profiles.filter((p) => p === "brief").length, 3);
  });
});

test("a brief already logged today is not run again", async () => {
  const done = rig();
  recordMessage("brief", 1, "Focus today", T0, done.conv.logFile); // a brief is logged today
  assert.notEqual(await done.w.look(done.conv, T0), "brief-delivered");
  assert.ok(!done.r.profiles.includes("brief"));
});

test("the brief is a detached background job: the look returns at once, one run at a time, the ledger is written when the run ends", async () => {
  const { r, conv } = rig();
  let finish!: () => void;
  const open = new Promise<void>((res) => (finish = res));
  const w = createWakeups({
    groupChats: true,
    pipeline: { canSpeak: () => false, enqueue: (_c: any, j: any) => j(), record: (_c: Conversation, k: Kind, ts: number, text: string) => recordMessage(k, ts, text, T0, conv.logFile), runTurn: async () => ({ spoke: false }) } as any,
    vouch: async () => true,
    runProfile: async (profile) => { r.profiles.push(profile); await open; return { text: "mail tools down" }; },
    presets: { sendBrief: async () => {}, notify: async () => {} },
    gate: async () => parseGate({ act: false, nextCheckMinutes: 30 }),
    groups: () => [],
    notesChangedAt: () => 0,
    now: () => T0,
    guards: { paused: () => false, budgetSpent: () => false },
  });
  assert.equal(await w.look(conv, T0), "brief-started"); // returned while the run is still open
  assert.deepEqual(r.profiles, ["brief"]);
  assert.equal(lookState(ledgerEntries(conv.logFile), T0).briefAttempts, 1); // "[brief] attempt 1 started" is written before the run
  finish();
  assert.deepEqual(await w.idle(), ["brief-incomplete"]);
});

test("a failing preset run is contained: the guard is freed and the next look can run it again", async () => {
  const { r, w, conv } = rig({ brief: "incomplete" });
  assert.equal(await w.look(conv, T0), "brief-incomplete");
  assert.equal(await w.look(conv, min(11)), "brief-incomplete");
  assert.deepEqual(r.profiles.filter((p) => p === "brief"), ["brief", "brief"]);
});

test("groups can never run a preset or an owner profile, whatever the gate says", async () => {
  const G = "tasks-group-0123456789abcdef";
  const g = rig({ groups: [G], gate: (c) => (c.kind === "group" ? { act: true, task: "brief", instructions: "Post a fun fact", nextCheckMinutes: 30 } : { act: false, nextCheckMinutes: 60 }) });
  await g.raw.tick(T0);
  await g.raw.idle();
  assert.ok(!g.r.profiles.includes("background"), "no owner profile ran for the group");
  assert.equal(g.r.groupRuns.length, 1);
  assert.match(g.r.groupRuns[0]!, /Post a fun fact/);
  const bare = rig({ groups: [G], gate: (c) => (c.kind === "group" ? { act: true, task: "radar", nextCheckMinutes: 30 } : { act: false, nextCheckMinutes: 60 }) });
  await bare.raw.tick(T0);
  assert.deepEqual(bare.r.groupRuns, [], "no instructions, no run");
  assert.equal(await group(G).kind, "group");
});
