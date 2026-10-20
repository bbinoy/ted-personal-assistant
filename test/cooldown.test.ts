import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_BACKOFF_MS, coolingDown, noteRateLimit, noteSuccess, observeRateLimit, resetCooldown, skipForCooldown } from "../src/core/cooldown.ts";
import { failure, RateLimitError } from "../src/tenants/errors.ts";
import { group, type Conversation } from "../src/conversation/conversation.ts";
import { recordMessage, type Kind } from "../src/core/messages.ts";
import { settings } from "../src/core/settings.ts";
import { createWakeups } from "../src/heartbeat/wake.ts";

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

// A group's look is the same heartbeat run as the owner's (test/heartbeatrun.test.ts has the run itself); here only what the usage-limit cooldown does to it.
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "idle-"));
  const notesDir = join(dir, "notes");
  mkdirSync(notesDir);
  writeFileSync(join(notesDir, "scheduling-fact.md"), "Post a fun fact every morning.");
  const conv: Conversation = { ...group("idle-group-0123456789abcdef"), logFile: `logs/idle-group-${Math.random().toString(36).slice(2)}.jsonl`, notesDir };
  let now = T0;
  let runs = 0;
  const pipeline = {
    busy: () => false, sendWhile: async (_c: unknown, run: () => Promise<unknown>) => run(),
    enqueue: <T>(_c: Conversation, job: () => Promise<T>) => job(),
    record: (c: Conversation, kind: Kind, ts: number, text: string) => recordMessage(kind, ts, text, now, c.logFile),
    runTurn: async (_c: Conversation, turn: any) => ((await turn.run()), { spoke: true }),
  };
  const w = createWakeups({
    pipeline: pipeline as any,
    groupChats: false,
    vouch: async () => true,
    run: async () => (runs++, { text: "", structured: { message: "[[silent]]", nextCheckMinutes: 15 } }),
    notesChangedAt: () => 0,
    now: () => now,
    guards: { paused: () => false, budgetSpent: () => false },
  });
  return { w, conv, runs: () => runs, at: (d: Date) => void (now = d) };
}

test("cooldown: the clock look makes no model call while it is active, logs once, and looks again when it lifts", async () => {
  const r = rig();
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
  assert.equal(r.runs(), 0);
  assert.equal(logged.filter((l) => l.startsWith("cooldown:")).length, 1);
  resetCooldown(); // lifted
  assert.equal(await r.w.look(r.conv, min(60)), "silent");
  assert.equal(r.runs(), 1);
});
