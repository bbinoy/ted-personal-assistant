import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES } from "../src/profiles.ts";
import { group, owner, type Conversation } from "../src/conversation.ts";
import { gateSystem, parseGate } from "../src/gate.ts";
import { recordMessage, type Kind } from "../src/messages.ts";
import { RADAR_SCHEMA } from "../src/radar-rules.ts";
import { settings } from "../src/settings.ts";
import { briefPending, buildTask } from "../src/tasks.ts";
import { ledgerEntries } from "../src/messages.ts";
import { lookState } from "../src/ledger.ts";
import { dataPath } from "../src/state.ts";
import { readFileSync } from "node:fs";
import { createWakeups } from "../src/wake.ts";

const s = settings as unknown as Record<string, unknown>;
const T0 = new Date(2026, 9, 14, 9, 0, 0); // a Wednesday, 09:00 local
const min = (m: number) => new Date(T0.getTime() + m * 60_000);

interface Rig { profiles: string[]; order: string[]; gates: string[]; briefs: string[]; notices: string[]; groupRuns: string[]; prompts: string[]; recorded: [string, string][] }
function rig(o: { gate?: (conv: Conversation) => unknown; brief?: "ok" | "incomplete" | "throw"; radar?: unknown; groups?: string[] } = {}) {
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
      if (profile === "radar") return { text: "", costUsd: 0.01, structured: o.radar ?? { eventsSeen: 4, nextStartMinutes: 150, messages: [{ kind: "prep", key: "prep:standup", text: "Standup in 40 min" }] } };
      return { text: "Hello from background" };
    },
    presets: { sendBrief: async (m) => void r.briefs.push(m), notify: async (t) => void r.notices.push(t), beforeBrief: async () => void r.order.push("dream") },
    runGroup: async (build) => (r.groupRuns.push(build().prompt), "Group says hi"),
    gate: async ({ conv: c }) => (r.gates.push(c.kind), parseGate((o.gate ?? (() => ({ act: true, task: "brief", nextCheckMinutes: 30 })))(c))),
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

test("profiles: named in code; brief, radar and background are owner runs with their own source, limits and schema", () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ["background", "brief", "browse", "chat", "group", "handler", "radar"]);
  assert.deepEqual([PROFILES.brief.source, PROFILES.brief.maxTurns, PROFILES.brief.maxBudgetUsd], ["brief", 120, 5]);
  assert.deepEqual([PROFILES.radar.source, PROFILES.radar.maxTurns, PROFILES.radar.maxBudgetUsd], ["radar", 30, 1]);
  assert.equal(PROFILES.radar.outputSchema, RADAR_SCHEMA);
  assert.equal(PROFILES.brief.outputSchema, undefined);
  assert.deepEqual([PROFILES.background.source, PROFILES.group.source], ["background", "group"]);
});

test("tasks: the gate names a task; presets are owner-only and fail closed", () => {
  const brief = buildTask(true, { task: "brief" })!;
  assert.deepEqual([brief.name, brief.profile, brief.after, brief.retries], ["brief", "brief", "brief", settings.briefMaxAttempts - 1]);
  assert.match(brief.instructions, /daily-brief/);
  const radar = buildTask(true, { task: "radar" }, { radar: true })!;
  assert.deepEqual([radar.profile, radar.after], ["radar", "radar"]);
  assert.match(radar.instructions, /radar/);
  assert.equal(buildTask(true, { task: "task", instructions: " do it " })!.profile, "background");
  // groups never get a preset: the plain group task if there are instructions, else nothing
  for (const name of ["brief", "radar"] as const) {
    assert.deepEqual(buildTask(false, { task: name, instructions: "say hi" }, { radar: true }), { name: "task", instructions: "say hi", profile: "group", after: "post" });
    assert.equal(buildTask(false, { task: name }, { radar: true }), undefined);
  }
  // an unknown name is the plain task
  assert.equal(parseGate({ act: true, task: "format-disk", instructions: "x" }).task, "task");
  assert.equal(parseGate({ act: true, task: "brief" }).task, "brief");
  // radar off: no radar preset
  assert.equal(buildTask(true, { task: "radar", instructions: "look" }, { radar: false })!.name, "task");
});

test("gate prompt: the owner's gate offers the presets, a group's does not", () => {
  assert.match(gateSystem({ kind: "owner" }, "clock", ""), /task "brief"/);
  assert.match(gateSystem({ kind: "owner" }, "clock", ""), /task "radar"/);
  assert.doesNotMatch(gateSystem({ kind: "group" }, "clock", ""), /"brief"/);
});

test("gate picks brief: the brief profile runs after the dream, the email is captured, the Signal summary goes out, the ledger says so", async () => {
  const { r, w, conv } = rig();
  assert.equal(await w.look(conv, T0), "brief-delivered");
  assert.deepEqual(r.order, ["dream", "brief-run"]);
  assert.deepEqual(r.profiles, ["brief"]);
  assert.deepEqual(r.briefs, ["# Brief\nFocus: pottery"]);
  assert.deepEqual(lines(r), ["[brief] attempt 1 started", "[brief] attempt 1 → delivered"]);
  // once a day: the gate asking again is refused by code
  const { r: r2, w: w2, conv: c2 } = rig();
  await w2.look(c2, T0);
  r2.order.length = 0;
  assert.equal(await w2.look(c2, min(40)), "refused:brief-done");
  assert.deepEqual(r2.order, []);
});

test("brief retries: an incomplete attempt is retried by code after a gap, up to the cap, then the owner is told", async () => {
  await withSettings({ briefMaxAttempts: 3 }, async () => {
    const { r, w, conv } = rig({ brief: "incomplete", gate: () => ({ act: false, nextCheckMinutes: 60 }) });
    s.briefBackstopHour = 24;
    // the gate (not code) starts the first attempt
    const first = rig({ brief: "incomplete" });
    assert.equal(await first.w.look(first.conv, T0), "brief-incomplete");
    // code retries without asking the gate: too early, then on time, then the cap
    first.r.gates.length = 0;
    assert.equal(await first.w.look(first.conv, min(5)), "not-due");
    first.at(min(11));
    assert.equal(await first.w.look(first.conv, min(11)), "brief-incomplete");
    first.at(min(25));
    assert.equal(await first.w.look(first.conv, min(25)), "brief-incomplete");
    assert.equal(first.r.gates.length, 0, "retries are not the gate's decision");
    assert.deepEqual(first.r.profiles, ["brief", "brief", "brief"]);
    assert.match(first.r.notices.at(-1)!, /failed 3 times/);
    first.at(min(60));
    assert.notEqual(await first.w.look(first.conv, min(60)), "brief-incomplete"); // the cap holds
    assert.equal(first.r.profiles.length, 3);
    void r; void w; void conv;
  });
});

test("brief backstop: no brief logged by the backstop hour runs it anyway, without the gate; earlier or already done it does not", async () => {
  await withSettings({ briefBackstopHour: 9 }, async () => {
    const quiet = rig({ gate: () => ({ act: false, nextCheckMinutes: 60 }) });
    quiet.at(new Date(2026, 9, 14, 8, 59));
    await quiet.w.look(quiet.conv, new Date(2026, 9, 14, 8, 59));
    assert.deepEqual(quiet.r.profiles, []);
    const late = rig({ gate: () => ({ act: false, nextCheckMinutes: 60 }) }); // the gate says no, the backstop does not care
    assert.equal(await late.w.look(late.conv, T0), "brief-delivered");
    assert.equal(late.r.gates.length, 0);
    assert.deepEqual(late.r.order, ["dream", "brief-run"], "the dream runs before the brief");
    const done = rig({ gate: () => ({ act: false, nextCheckMinutes: 60 }) });
    recordMessage("brief", 1, "Focus today", T0, done.conv.logFile); // a brief is logged today
    assert.notEqual(await done.w.look(done.conv, T0), "brief-delivered");
    assert.deepEqual(done.r.profiles, []);
  });
});

test("gate picks radar: the radar profile runs, its messages are posted, keys go to the ledger and are never sent twice", async () => {
  const { r, w, conv } = rig({ gate: () => ({ act: true, task: "radar", nextCheckMinutes: 30 }) });
  // before today's brief the radar waits
  assert.equal(await w.look(conv, T0), "refused:brief-first");
  assert.deepEqual(r.profiles, []);
  recordMessage("brief", 1, "Focus today", T0, conv.logFile);
  assert.equal(await w.look(conv, min(40)), "radar-posted");
  assert.deepEqual(r.profiles, ["radar"]);
  assert.deepEqual(r.notices, ["Standup in 40 min"]);
  const ran = lines(r).find((l) => l.startsWith("[radar] ran"))!;
  assert.match(ran, /next meeting at 12:10/); // 09:40 + 150 min
  assert.match(ran, /keys: \["prep:standup"\]/);
  // later: the same key again is dropped (the dedupe is the log), a new one goes out
  r.notices.length = 0;
  assert.equal(await w.look(conv, min(120)), "radar-quiet");
  assert.deepEqual(r.notices, []);
  // too soon after the last run
  assert.equal(await w.look(conv, min(125)), "not-due");
});

test("radar: the generic cap on posts per day applies, and the radar off means no radar", async () => {
  await withSettings({ maxProactivePerDay: 1 }, async () => {
    const { w, conv } = rig({ gate: () => ({ act: true, task: "radar", nextCheckMinutes: 30 }) });
    recordMessage("brief", 1, "Focus today", T0, conv.logFile);
    recordMessage("notice", 2, "an alert earlier", T0, conv.logFile);
    recordMessage("notice", 3, "another mail alert", T0, conv.logFile);
    assert.equal(await w.look(conv, T0), "radar-posted"); // mail alerts do not count against the radar's own cap
    assert.equal(await w.look(conv, min(120)), "refused:post-cap"); // its own message today reached the cap: no further run
  });
  await withSettings({ proactive: false }, async () => {
    const { r, w, conv } = rig({ gate: () => ({ act: true, task: "radar", nextCheckMinutes: 30 }) });
    recordMessage("brief", 1, "Focus today", T0, conv.logFile);
    assert.equal(await w.look(conv, T0), "no-instructions");
    assert.deepEqual(r.profiles, []);
  });
});

test("presets are detached background jobs: the look returns at once, one run per task at a time, the ledger is written when the run ends", async () => {
  const { r, conv } = rig();
  recordMessage("brief", 1, "Focus today", T0, conv.logFile);
  // a radar run that stays open until we say so
  let finish!: () => void;
  const open = new Promise<void>((res) => (finish = res));
  const w = createWakeups({
    groupChats: true,
    pipeline: { canSpeak: () => false, enqueue: (_c: any, j: any) => j(), record: (_c: Conversation, k: Kind, ts: number, text: string) => recordMessage(k, ts, text, T0, conv.logFile), runTurn: async () => ({ spoke: false }) } as any,
    vouch: async () => true,
    runProfile: async (profile) => { r.profiles.push(profile); await open; return { text: "", structured: { eventsSeen: 2, messages: [] } }; },
    presets: { sendBrief: async () => {}, notify: async () => {} },
    gate: async () => parseGate({ act: true, task: "radar", nextCheckMinutes: 30 }),
    groups: () => [],
    notesChangedAt: () => 0,
    now: () => T0,
    guards: { paused: () => false, budgetSpent: () => false },
  });
  const ownerConv = conv;
  assert.equal(await w.look(ownerConv, T0), "radar-started"); // returned while the run is still open
  assert.deepEqual(r.profiles, ["radar"]);
  const st = () => lookState(ledgerEntries(conv.logFile), T0);
  assert.notEqual(st().lastRadarAt, undefined); // "[radar] started" is written before the run
  // looked at again meanwhile: the same task never doubles up
  const again = await w.look(ownerConv, min(31));
  assert.ok(["radar-running", "refused:too-soon", "not-due"].includes(again), again);
  assert.deepEqual(r.profiles, ["radar"]);
  finish();
  assert.deepEqual(await w.idle(), ["radar-quiet"]);
  assert.match(lines(r).join("\n") + readFileSync(dataPath(conv.logFile), "utf8"), /\[radar\] ran: 0 message\(s\) sent, 2 event\(s\) read/);
});

test("a failing preset run is contained: the guard is freed and the next look can run it again", async () => {
  const { r, w, conv } = rig({ brief: "incomplete", gate: () => ({ act: true, task: "brief", nextCheckMinutes: 30 }) });
  assert.equal(await w.look(conv, T0), "brief-incomplete");
  assert.equal(await w.look(conv, min(11)), "brief-incomplete");
  assert.deepEqual(r.profiles, ["brief", "brief"]);
});

test("groups can never run a preset, whatever the gate says", async () => {
  const G = "tasks-group-0123456789abcdef";
  const { r, w, conv } = rig({ groups: [G], gate: (c) => (c.kind === "group" ? { act: true, task: "brief", instructions: "Post a fun fact", nextCheckMinutes: 30 } : { act: false, nextCheckMinutes: 60 }) });
  await w.tick(T0);
  assert.deepEqual(r.profiles, []); // no owner profile ran for the group
  assert.equal(r.groupRuns.length, 1);
  assert.match(r.groupRuns[0]!, /Post a fun fact/);
  const bare = rig({ groups: [G], gate: (c) => (c.kind === "group" ? { act: true, task: "radar", nextCheckMinutes: 30 } : { act: false, nextCheckMinutes: 60 }) });
  await bare.w.tick(T0);
  assert.deepEqual([bare.r.profiles, bare.r.groupRuns], [[], []]);
  void conv;
  assert.equal(await group(G).kind, "group");
});

test("a free-form task of the owner runs the background profile and posts the answer", async () => {
  const { r, w, conv } = rig({ gate: () => ({ act: true, task: "task", instructions: "Remind me to call Eve", nextCheckMinutes: 30 }) });
  assert.equal(await w.look(conv, T0), "posted");
  assert.deepEqual(r.profiles, ["background"]);
});

test("briefPending: only a bounded window, so urgent mail is not swallowed all day when no brief runs", async () => {
  const st = (over: Partial<ReturnType<typeof lookState>> = {}) => ({ ...lookState([], T0), ...over });
  const at = (h: number) => new Date(2026, 9, 14, h, 30);
  await withSettings({ briefStartHour: 7, briefBackstopHour: 9, briefMaxAttempts: 3 }, async () => {
    assert.equal(briefPending(st(), at(6)), false); // before the start hour
    assert.equal(briefPending(st(), at(8)), true); // waiting for the brief
    assert.equal(briefPending(st(), at(10)), false); // past the backstop with no attempt: nothing is coming (a note said no brief; the backstop ran it or is guarded)
    assert.equal(briefPending(st({ briefAttempts: 1 }), at(10)), true); // an attempt is under way or will be retried
    assert.equal(briefPending(st({ briefAttempts: 3 }), at(10)), false); // given up
    assert.equal(briefPending(st({ briefDone: true }), at(8)), false);
  });
  await withSettings({ briefStartHour: 7, briefBackstopHour: 24, briefMaxAttempts: 3 }, async () => {
    assert.equal(briefPending(st(), at(8)), true);
    assert.equal(briefPending(st(), at(14)), false); // backstop off: not pending all day
  });
});
