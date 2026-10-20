import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { owner, type Conversation } from "../src/conversation.ts";
import { parseGate } from "../src/gate.ts";
import { clampLook, parseAnswer, HEARTBEAT_SCHEMA } from "../src/heartbeat/rules.ts";
import { lastLookText, lookInstruction, lookPrompt } from "../src/heartbeat/look.ts";
import { heartbeatReport } from "../src/heartbeat/report.ts";
import { HEARTBEAT_LOG, readRows, type HeartbeatRow } from "../src/heartbeat/rows.ts";
import { ledgerEntries, recordMessage, type Kind } from "../src/messages.ts";
import { lookState, parseWake } from "../src/ledger.ts";
import { settings } from "../src/settings.ts";
import { dataPath, readText } from "../src/state.ts";
import { createWakeups } from "../src/wake.ts";
import type { RunProvenance } from "../src/approvals/autojudge.ts";

const s = settings as unknown as Record<string, unknown>;
s.briefBackstopHour = 24; // the brief is the brief tests' (test/tasks.test.ts); here the owner's look is all that runs
const DAY = new Date(2026, 9, 14, 14, 0, 0); // a Wednesday, 14:00 local
const NIGHT = new Date(2026, 9, 14, 23, 30, 0);
const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const row = (at: Date, over: Partial<HeartbeatRow> = {}): HeartbeatRow => ({ at: at.toISOString(), night: false, message: false, nextCheckMinutes: 30, costUsd: 0.01, toolCalls: 0, archived: 0, delegations: 0, outcome: "silent", ...over });
const reset = () => rmSync(dataPath(HEARTBEAT_LOG), { force: true });

interface Answer { message?: string; nextCheckMinutes?: number; throws?: boolean; calls?: string[]; delegates?: number }
function rig(answer: () => Answer, o: { paused?: boolean; spent?: boolean; groups?: string[] } = {}) {
  reset();
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  mkdirSync(join(dir, "n"));
  const conv: Conversation = { ...owner(), logFile: `logs/hb-owner-${Math.random().toString(36).slice(2)}.jsonl`, notesDir: join(dir, "n") };
  const seen = { profiles: [] as string[], prompts: [] as string[], provenance: [] as (RunProvenance | undefined)[], posted: [] as string[], gates: 0, groupRuns: 0, recorded: [] as [string, string][] };
  let now = DAY;
  const pipeline = {
    canSpeak: () => false,
    enqueue: <T>(_c: Conversation, job: () => Promise<T>) => job(),
    record: (c: Conversation, kind: Kind, ts: number, text: string) => (seen.recorded.push([kind, text]), recordMessage(kind, ts, text, now, c.kind === "owner" ? conv.logFile : c.logFile)),
    runTurn: async (_c: Conversation, turn: any) => {
      const { text } = await turn.run();
      seen.posted.push(text);
      return { spoke: true };
    },
  };
  const w = createWakeups({
    pipeline: pipeline as any,
    groupChats: !!o.groups,
    vouch: async () => true,
    groups: () => o.groups ?? [],
    context: () => ({ lines: ["Eve: hi"], seenAt: undefined }),
    runGroup: async () => (seen.groupRuns++, "hello group"),
    runProfile: async (profile, prompt, extra) => {
      seen.profiles.push(profile);
      seen.prompts.push(prompt);
      seen.provenance.push(extra?.provenance);
      const a = answer();
      if (a.throws) throw new Error("boom");
      for (const t of a.calls ?? []) extra?.onToolSuccess?.(t, {});
      for (let i = 0; i < (a.delegates ?? 0); i++) extra?.onDelegate?.("expert");
      return { text: "", costUsd: 0.02, structured: { message: a.message ?? "[[silent]]", nextCheckMinutes: a.nextCheckMinutes ?? 30 } };
    },
    gate: async () => (seen.gates++, parseGate(o.groups ? { act: true, instructions: "Post a fun fact", nextCheckMinutes: 30 } : { act: false, nextCheckMinutes: 30 })),
    notesChangedAt: () => 0,
    now: () => now,
    guards: { paused: () => !!o.paused, budgetSpent: () => !!o.spent },
  });
  const wakeLine = () => ledgerEntries(conv.logFile).filter((e) => e.kind === "wake").map((e) => parseWake(e.text)!).at(-1)!;
  return { w, conv, seen, at: (d: Date) => (now = d), wakeLine };
}
test("the next look is clamped to 10..120 minutes, whatever the model says, and falls back to the day default", () => {
  assert.equal(clampLook(1), 10);
  assert.equal(clampLook(0), 10);
  assert.equal(clampLook(10), 10);
  assert.equal(clampLook(45.4), 45);
  assert.equal(clampLook("90"), 90);
  assert.equal(clampLook(500), 120);
  assert.equal(clampLook(Infinity), 30, "not a usable number: the day default");
  assert.equal(clampLook(undefined), 30);
  assert.equal(clampLook(""), 30);
  assert.equal(clampLook("soon"), 30);
  const schema = (HEARTBEAT_SCHEMA as unknown as { schema: { properties: { nextCheckMinutes: { minimum: number; maximum: number } } } }).schema;
  assert.deepEqual([schema.properties.nextCheckMinutes.minimum, schema.properties.nextCheckMinutes.maximum], [10, 120]);
});

test("the answer: a message or [[silent]]; anything that does not follow the format is silent", () => {
  assert.deepEqual(parseAnswer({ message: " Eve is waiting ", nextCheckMinutes: 15 }, ""), { message: "Eve is waiting", nextCheckMinutes: 15 });
  assert.deepEqual(parseAnswer(undefined, JSON.stringify({ message: "hi", nextCheckMinutes: 600 })), { message: "hi", nextCheckMinutes: 120 });
  for (const m of ["[[silent]]", "[[SILENT]]", "", "   ", "[[silent]] nothing to say"]) assert.equal(parseAnswer({ message: m, nextCheckMinutes: 30 }, "").message, undefined, m);
  assert.equal(parseAnswer({ message: null, nextCheckMinutes: 30 }, "").message, undefined);
  assert.equal(parseAnswer(undefined, "I looked at the mail and thought about it").message, undefined, "free text is never posted");
  assert.equal(parseAnswer(undefined, "").nextCheckMinutes, 30);
});

test("the instruction: the clock, the zone, the last look and the quiet window as text; no brief status, no gate vocabulary", () => {
  const text = lookInstruction(DAY, new Date(2026, 9, 14, 13, 30).toISOString());
  assert.match(text, /Wednesday 2026-10-14 14:00/);
  assert.ok(text.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.match(text, /Your last look was at 13:30\./);
  assert.match(text, /Quiet hours \(night\) are 22:00-07:00/);
  assert.match(text, /very few messages: a handful at most/);
  assert.match(text, /working late, tell me everything tonight/);
  assert.match(text, /memory note/);
  assert.match(text, /at most 5 mails per look/);
  assert.match(text, /\[\[silent\]\]/);
  assert.doesNotMatch(text, /brief status|daily brief today|OVERDUE/i);
  assert.match(lastLookText(undefined, DAY), /first look/);
  assert.match(lastLookText(new Date(2026, 9, 13, 9, 0).toISOString(), DAY), /an earlier day/);
  const prompt = lookPrompt(DAY, text, ["[10-14 13:00] Ben: call Eve"]);
  assert.match(prompt, /CURRENT TIME/);
  assert.match(prompt, /call Eve/);
});

test("owner's look: ONE heartbeat run with standing provenance, no gate, the message posted, the next look recorded, one row without words", async () => {
  const { w, conv, seen, wakeLine } = rig(() => ({ message: "Eve still waits for your answer about Friday.", nextCheckMinutes: 45, calls: ["mcp__mailbird__list_conversations", "mcp__mailbird__archive_conversation", "mcp__mailbird__archive_conversation"] }));
  assert.equal(await w.look(conv, DAY), "posted");
  assert.deepEqual(seen.profiles, ["heartbeat"]);
  assert.equal(seen.gates, 0, "the owner has no gate");
  assert.equal(seen.provenance[0]?.kind, "standing", "the judge reads the fixed instruction as the reason for the run");
  assert.match((seen.provenance[0] as { task: string }).task, /periodic look/);
  assert.doesNotMatch((seen.provenance[0] as { task: string }).task, /call Eve|Friday/, "no chat in the standing task");
  assert.deepEqual(seen.posted, ["Eve still waits for your answer about Friday."]);
  const wake = wakeLine();
  assert.equal(Date.parse(wake.next) - DAY.getTime(), 45 * 60_000);
  assert.equal(Date.parse(wake.looked), DAY.getTime());
  const rows = readRows();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { at: DAY.toISOString(), night: false, message: true, nextCheckMinutes: 45, costUsd: 0.02, toolCalls: 3, archived: 2, delegations: 0, outcome: "posted" });
  assert.doesNotMatch(readText(HEARTBEAT_LOG)!, /Eve|Friday|waits/, "the row carries no words");
  assert.ok(seen.recorded.some(([k, t]) => k === "action" && /\[heartbeat\] look: 3 tool call\(s\), 2 mail archived, message sent/.test(t)), "the log gets a counted summary line");
});

test("owner's look: the delegations to experts are counted in the row and the log line; the expert's cost is in the run's cost", async () => {
  const { w, conv, seen } = rig(() => ({ delegates: 2, calls: ["Agent", "mcp__claude_ai_Notion__notion-fetch", "Agent"] }));
  assert.equal(await w.look(conv, DAY), "silent", "the expert delivered itself; the run answered [[silent]]");
  assert.deepEqual(readRows().map((r) => [r.delegations, r.toolCalls, r.costUsd]), [[2, 3, 0.02]]);
  assert.ok(seen.recorded.some(([k, t]) => k === "action" && /look: 3 tool call\(s\), 0 mail archived, 2 delegated, no message/.test(t)));
});

test("owner's look: [[silent]] posts nothing, a model's 3 minutes becomes 10, and at night the clamp holds too", async () => {
  const day = rig(() => ({ nextCheckMinutes: 3 }));
  assert.equal(await day.w.look(day.conv, DAY), "silent");
  assert.deepEqual(day.seen.posted, []);
  assert.equal(Date.parse(day.wakeLine().next) - DAY.getTime(), 10 * 60_000);
  const night = rig(() => ({ nextCheckMinutes: 400 }));
  assert.equal(await night.w.look(night.conv, NIGHT), "silent");
  assert.equal(Date.parse(night.wakeLine().next) - NIGHT.getTime(), 120 * 60_000);
  assert.deepEqual(readRows().map((r) => [r.night, r.nextCheckMinutes]), [[true, 120]]);
});

test("owner's look at night: no cap in code, every message the model writes is posted (night behaviour is the instruction's)", async () => {
  const { w, conv, seen, at } = rig(() => ({ message: `urgent #${seen.posted.length + 1}`, nextCheckMinutes: 10 }));
  for (let i = 0; i < 4; i++) {
    const t = min(NIGHT, i * 11);
    at(t);
    assert.equal(await w.look(conv, t), "posted");
  }
  assert.deepEqual(seen.posted, ["urgent #1", "urgent #2", "urgent #3", "urgent #4"]);
  assert.deepEqual(readRows().map((r) => [r.night, r.outcome]), [[true, "posted"], [true, "posted"], [true, "posted"], [true, "posted"]]);
  assert.ok(!seen.recorded.some(([, t]) => /held/.test(t)));
});

test("owner's look: due only when the chosen time has come, the owner wrote or a note changed", async () => {
  const { w, conv, seen, at } = rig(() => ({ nextCheckMinutes: 30 }));
  assert.equal(await w.look(conv, DAY), "silent");
  at(min(DAY, 10));
  assert.equal(await w.look(conv, min(DAY, 10)), "not-due");
  recordMessage("owner", min(DAY, 11).getTime(), "can you check the invoice", min(DAY, 11), conv.logFile); // she wrote after the look began
  at(min(DAY, 12));
  assert.equal(await w.look(conv, min(DAY, 12)), "silent", "someone wrote: the look comes early");
  assert.equal(seen.profiles.length, 2);
  at(min(DAY, 50));
  assert.equal(await w.look(conv, min(DAY, 50)), "silent", "the chosen time came");
  assert.equal(lookState(ledgerEntries(conv.logFile), min(DAY, 50)).wake !== undefined, true);
});

test("owner's look: pause and mayRun stop it before any model call, nothing is recorded", async () => {
  const paused = rig(() => ({}), { paused: true });
  assert.equal(await paused.w.look(paused.conv, DAY), "guarded");
  const spent = rig(() => ({}), { spent: true });
  assert.equal(await spent.w.look(spent.conv, DAY), "blocked");
  const { coolingDown, resetCooldown } = await import("../src/cooldown.ts");
  const { failure } = await import("../src/errors.ts");
  failure("rate_limit", "success"); // a usage limit starts the cooldown
  assert.ok(coolingDown());
  const cooling = rig(() => ({}));
  assert.equal(await cooling.w.look(cooling.conv, DAY), "cooldown");
  resetCooldown();
  for (const r of [paused, spent, cooling]) {
    assert.deepEqual(r.seen.profiles, [], "no run started");
    assert.deepEqual(readRows(), []);
    assert.equal(lookState(ledgerEntries(r.conv.logFile), DAY).wake, undefined, "nothing recorded: the next tick looks again");
  }
  // the tick itself stops while paused
  const t = rig(() => ({}), { paused: true });
  await t.w.tick(DAY);
  assert.deepEqual(t.seen.profiles, []);
});

test("owner's look: a failing run is a failed row and a default next look; it never posts", async () => {
  const err = console.error;
  console.error = () => {};
  try {
    const { w, conv, seen } = rig(() => ({ throws: true }));
    assert.equal(await w.look(conv, DAY), "failed");
    assert.deepEqual(seen.posted, []);
    assert.deepEqual(readRows().map((r) => [r.outcome, r.message, r.costUsd]), [["failed", false, 0]]);
  } finally {
    console.error = err;
  }
});

test("groups keep today's path: the gate decides, the group run answers, and no heartbeat run starts for them", async () => {
  const G = "hb-group-0123456789abcdef";
  const { w, seen, at } = rig(() => ({}), { groups: [G] });
  at(DAY);
  await w.tick(DAY);
  await w.idle();
  assert.equal(seen.gates, 1, "the group's look asked the gate");
  assert.equal(seen.groupRuns, 1);
  assert.equal(seen.profiles.filter((p) => p === "heartbeat").length, 1, "only the owner's look ran a heartbeat run");
  assert.equal(readRows().length, 1, "one row: the owner's");
});

test("the report: counts per day, messages by day and night, dollars and the next looks it chose, from the rows only", () => {
  const rows = [
    row(new Date(2026, 9, 13, 10, 0), { message: true, costUsd: 0.03, toolCalls: 4, archived: 2, nextCheckMinutes: 30, outcome: "posted" }),
    row(new Date(2026, 9, 13, 23, 0), { message: true, night: true, costUsd: 0.02, nextCheckMinutes: 120, outcome: "posted" }),
    row(new Date(2026, 9, 13, 23, 40), { night: true, costUsd: 0.01, nextCheckMinutes: 12 }),
    row(new Date(2026, 9, 14, 9, 0), { costUsd: 0.01, nextCheckMinutes: 45 }),
    row(new Date(2026, 8, 1, 9, 0)), // too old
  ];
  const text = heartbeatReport(rows, DAY, 7).join("\n");
  assert.match(text, /4 look\(s\) on 2 day\(s\)/);
  assert.match(text, /2026-10-13 {2}\s*3 {2}\s*2 {2}\s*1 {2}\s*0/);
  assert.match(text, /cost: \$0\.07 in total, \$0\.04 per day/);
  assert.match(text, /messages: 2 sent \(1 at night\), 1\.0 per day/);
  assert.match(text, /10-14 min {2}\s*1/);
  assert.match(text, /60-120 min\s*1/);
  assert.deepEqual(heartbeatReport([], DAY), ["No heartbeat looks in the last 7 day(s)."]);
});
