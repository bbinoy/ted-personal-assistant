import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_BACKOFF_MS, coolingDown, noteRateLimit, noteSuccess, observeRateLimit, resetCooldown, skipForCooldown } from "../src/cooldown.ts";
import { failure, RateLimitError } from "../src/errors.ts";
import { group, type Conversation } from "../src/conversation.ts";
import { idleFingerprint, parseGate } from "../src/gate.ts";
import { recordMessage, type Kind } from "../src/messages.ts";
import { settings } from "../src/settings.ts";
import { createWakeups } from "../src/wake.ts";

(settings as unknown as Record<string, unknown>).briefBackstopHour = 24;
const T0 = new Date(2026, 9, 14, 9, 0, 0);
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

beforeEach(() => resetCooldown());

function captureLog<T>(f: () => T): { out: T; lines: string[] } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { out: f(), lines };
  } finally {
    console.log = orig;
  }
}

test("cooldown: a rate limit starts a backoff that doubles to a cap; a success clears it", () => {
  const t = 1_000_000;
  assert.equal(coolingDown(t), false);
  noteRateLimit(t);
  assert.equal(coolingDown(t + BASE_BACKOFF_MS - 1), true);
  assert.equal(coolingDown(t + BASE_BACKOFF_MS), false);
  noteRateLimit(t + BASE_BACKOFF_MS); // the probe failed too: twice as long
  assert.equal(coolingDown(t + BASE_BACKOFF_MS + 2 * BASE_BACKOFF_MS - 1), true);
  for (let i = 0; i < 10; i++) noteRateLimit(t);
  assert.equal(coolingDown(t + 2 * 3600_000 - 1), true);
  assert.equal(coolingDown(t + 2 * 3600_000 + 1), false); // capped
  noteSuccess();
  assert.equal(coolingDown(t), false);
});

test("cooldown: the SDK's own reset time is used when it gave one; the RateLimitError path starts it", () => {
  const now = Date.now();
  observeRateLimit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.round(now / 1000) + 3 * 3600 } });
  noteRateLimit(now);
  assert.equal(coolingDown(now + 2.9 * 3600_000), true);
  assert.equal(coolingDown(now + 3.1 * 3600_000), false);
  resetCooldown();
  observeRateLimit({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: Math.round(now / 1000) + 3 * 3600 } }); // not a refusal: ignored
  assert.ok(failure("rate_limit", "success") instanceof RateLimitError);
  assert.equal(coolingDown(), true);
  assert.equal(coolingDown(now + 16 * 60_000), false); // 15 minutes
});

test("cooldown: one log line per episode, not per skip; a success ends the episode", () => {
  noteRateLimit();
  const { lines } = captureLog(() => {
    for (let i = 0; i < 5; i++) assert.equal(skipForCooldown("a job"), true);
  });
  assert.equal(lines.filter((l) => /^cooldown: usage limit/.test(l)).length, 1);
  const cleared = captureLog(() => noteSuccess());
  assert.equal(cleared.lines.length, 1);
  assert.equal(skipForCooldown("a job"), false);
  noteRateLimit(); // a new episode logs again
  assert.equal(captureLog(() => skipForCooldown("a job")).lines.length, 1);
});

// ---- the clock look ----

function rig(gate: (n: number) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), "idle-"));
  const notesDir = join(dir, "notes");
  mkdirSync(notesDir);
  // (a group: the gate's look is a group's or a friend's; the owner's is the heartbeat run, test/heartbeatrun.test.ts)
  const conv: Conversation = { ...group("idle-group-0123456789abcdef"), logFile: `logs/idle-group-${Math.random().toString(36).slice(2)}.jsonl`, notesDir };
  let now = T0;
  let calls = 0;
  const pipeline = {
    canSpeak: () => true,
    enqueue: <T>(_c: Conversation, job: () => Promise<T>) => job(),
    record: (c: Conversation, kind: Kind, ts: number, text: string) => recordMessage(kind, ts, text, now, c.logFile),
    runTurn: async (_c: Conversation, turn: any) => ((await turn.run()), { spoke: true }),
  };
  const ran: string[] = [];
  const w = createWakeups({
    pipeline: pipeline as any,
    groupChats: false,
    vouch: async () => true,
    runProfile: async () => ({ text: "" }),
    runGroup: async (build) => (ran.push(build().prompt), "done"),
    context: () => ({ lines: [], seenAt: undefined }),
    gate: async () => {
      calls++;
      const g = gate(calls);
      if (g instanceof Error) throw g;
      return parseGate(g);
    },
    notesChangedAt: () => 0,
    now: () => now,
    guards: { paused: () => false, budgetSpent: () => false },
  });
  return { w, conv, notesDir, ran, calls: () => calls, at: (d: Date) => void (now = d), say: (text: string) => recordMessage("member", now.getTime(), text, now, conv.logFile) };
}
const QUIET = { act: false, nextCheckMinutes: 15 };

test("cooldown: the clock look makes no model call while it is active, logs once, and looks again when it lifts or a call succeeds", async () => {
  const r = rig(() => QUIET);
  noteRateLimit(Date.now());
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    for (let i = 0; i < 4; i++) {
      r.at(min(i * 15));
      assert.equal(await r.w.look(r.conv, min(i * 15)), "cooldown");
    }
  } finally {
    console.log = orig;
  }
  assert.equal(r.calls(), 0);
  assert.equal(logged.filter((l) => l.startsWith("cooldown:")).length, 1);
  resetCooldown(); // lifted
  assert.equal(await r.w.look(r.conv, min(60)), "no");
  assert.equal(r.calls(), 1);
});

test("cooldown: a gate that is refused starts the cooldown, and the next tick does not ask again", async () => {
  const r = rig(() => failure("rate_limit", "success"));
  assert.equal(await r.w.look(r.conv, T0), "no"); // failed closed
  assert.equal(r.calls(), 1);
  r.at(min(30)); // a failed look waits the default 30 minutes
  assert.equal(await r.w.look(r.conv, min(30)), "cooldown");
  assert.equal(r.calls(), 1);
});

// ---- skipping an idle look ----

test("idle: an unchanged quiet look is not asked again; a message, a new hour or a note is", async () => {
  const r = rig(() => QUIET);
  assert.equal(await r.w.look(r.conv, T0), "no");
  r.at(min(15));
  assert.equal(await r.w.look(r.conv, min(15)), "idle"); // same inputs, same hour
  r.at(min(30));
  assert.equal(await r.w.look(r.conv, min(30)), "idle");
  assert.equal(r.calls(), 1);
  r.at(min(45));
  r.say("hello");
  assert.equal(await r.w.look(r.conv, min(45)), "no"); // new message
  assert.equal(r.calls(), 2);
  r.at(min(60 + 5));
  assert.equal(await r.w.look(r.conv, min(65)), "no"); // next hour
  assert.equal(r.calls(), 3);
  writeFileSync(join(r.notesDir, "scheduling-fact.md"), "Every morning post a fun fact.");
  r.at(min(80));
  assert.equal(await r.w.look(r.conv, min(80)), "no"); // the notes changed
  assert.equal(r.calls(), 4);
});

test("idle: a note that names a time is looked at again exactly when that time has passed, and a due schedule that acts runs", async () => {
  const r = rig((n) => (n < 2 ? QUIET : { act: true, instructions: "Post the fact", nextCheckMinutes: 30 }));
  writeFileSync(join(r.notesDir, "scheduling-fact.md"), "Post a fun fact at 9:40.");
  assert.equal(await r.w.look(r.conv, T0), "no");
  r.at(min(15));
  assert.equal(await r.w.look(r.conv, min(15)), "idle"); // 9:15: the named time has not come, nothing changed
  r.at(min(30));
  assert.equal(await r.w.look(r.conv, min(30)), "idle");
  assert.equal(r.calls(), 1);
  r.at(min(45));
  assert.equal(await r.w.look(r.conv, min(45)), "posted"); // 9:40 crossed: the look that is due next asks again
  assert.equal(r.calls(), 2);
  assert.equal(r.ran.length, 1);
  const f = (d: Date) => idleFingerprint({ conv: r.conv, now: d, tail: [] });
  assert.notEqual(f(T0), f(min(40)));
  assert.equal(f(T0), f(min(15)));
  rmNotes(r.notesDir);
  assert.equal(f(T0), f(min(15)));
});

test("idle: a time hint the extraction cannot read keeps the minute (nothing is skipped)", () => {
  const r = rig(() => QUIET);
  writeFileSync(join(r.notesDir, "scheduling-fact.md"), "Post a fun fact at o'clock sharp.");
  const f = (d: Date) => idleFingerprint({ conv: r.conv, now: d, tail: [] });
  assert.notEqual(f(T0), f(min(1)));
});

test("idle: with named times the fingerprint moves with the day part and the passed times only", () => {
  const r = rig(() => QUIET);
  const at = (h: number, m = 0, day = 14) => new Date(2026, 9, day, h, m);
  const f = (d: Date) => idleFingerprint({ conv: r.conv, now: d, tail: [] });
  writeFileSync(join(r.notesDir, "scheduling-fact.md"), "Fun fact at 9:40 and at 18 Uhr.");
  assert.equal(f(at(6, 0)), f(at(6, 59))); // same part, nothing crossed
  assert.equal(f(at(7, 0)), f(at(8, 30)));
  assert.notEqual(f(at(9, 39)), f(at(9, 40))); // crossed
  assert.equal(f(at(10, 0)), f(at(11, 30)));
  assert.notEqual(f(at(11, 59)), f(at(12, 0))); // the afternoon begins
  assert.notEqual(f(at(17, 59)), f(at(18, 0))); // crossed
  assert.notEqual(f(at(9, 0)), f(at(9, 0, 15))); // a new day
});

test("idle: a failed gate call is not a quiet decision, and the model's own look lines do not change the fingerprint", async () => {
  const r = rig((n) => (n === 1 ? new Error("boom") : QUIET));
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(await r.w.look(r.conv, T0), "no");
    r.at(min(30));
    assert.equal(await r.w.look(r.conv, min(30)), "no"); // asked again after the failure
  } finally {
    console.error = orig;
  }
  assert.equal(r.calls(), 2);
  const a = idleFingerprint({ conv: r.conv, now: T0, tail: ["[10-14 09:00] Ben: hi"] });
  const b = idleFingerprint({ conv: r.conv, now: min(15), tail: ["[10-14 09:00] Ben: hi", "[10-14 09:00] (you looked and planned to look again at 10-14 09:15)"] });
  assert.equal(a, b);
});

function rmNotes(dir: string) {
  writeFileSync(join(dir, "scheduling-fact.md"), "Post a fun fact every morning.");
}
