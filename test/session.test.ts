import { test } from "node:test";
import assert from "node:assert/strict";
import { planSession, type ChatSession } from "../src/run/session.ts";
import { scratch } from "./scratch.ts";

const opts = { compactTokens: 60_000, compactGrowth: 40_000 };
const now = new Date("2026-10-12T12:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();
const session = (s: Partial<ChatSession>): ChatSession => ({ sessionId: "s1", costUsd: 1, ...s });

test("session: no saved session means fresh", () => {
  assert.equal(planSession({ costUsd: 0 }, now, opts), "fresh");
});

test("session: token boundary is strictly more than the limit", () => {
  assert.equal(planSession(session({ lastTurnAt: ago(1), lastContextTokens: 60_000 }), now, opts), "resume");
  assert.equal(planSession(session({ lastTurnAt: ago(1), lastContextTokens: 60_001 }), now, opts), "resume then compact");
});

test("session: old session.json without the new fields still resumes", () => {
  assert.equal(planSession(session({}), now, opts), "resume");
  assert.equal(planSession(session({ lastTurnAt: "garbage" }), now, opts), "resume");
  assert.equal(planSession(session({ lastTurnAt: ago(1) }), now, opts), "resume"); // no token count: nothing to compact
});

test("session: the thresholds come from settings", () => {
  const tight = { compactTokens: 10_000, compactGrowth: 5_000 };
  assert.equal(planSession(session({ lastTurnAt: ago(2) }), now, tight), "resume");
  assert.equal(planSession(session({ lastTurnAt: ago(0.5), lastContextTokens: 10_001 }), now, tight), "resume then compact");
});

test("session: a failed compaction backs off for an hour, then tries again", () => {
  const base = { sessionId: "s", costUsd: 1, lastTurnAt: "2026-10-12T10:00:00Z", lastContextTokens: 90_000 };
  const opts = { compactTokens: 60_000, compactGrowth: 40_000 };
  const failedAt = "2026-10-12T10:05:00Z";
  assert.equal(planSession({ ...base, compactFailedAt: failedAt }, new Date("2026-10-12T10:30:00Z"), opts), "resume");
  assert.equal(planSession({ ...base, compactFailedAt: failedAt }, new Date("2026-10-12T11:06:00Z"), opts), "resume then compact");
  assert.equal(planSession(base, new Date("2026-10-12T10:30:00Z"), opts), "resume then compact");
});

test("session: compaction counts growth since the first turn, the same for a big owner floor and a small group floor", () => {
  const at = (base: number, last: number) => planSession(session({ lastTurnAt: ago(1), baseTokens: base, lastContextTokens: last }), now, opts);
  assert.equal(at(50_000, 90_000), "resume"); // owner: 40k of conversation is exactly the limit
  assert.equal(at(50_000, 90_001), "resume then compact");
  assert.equal(at(10_000, 50_000), "resume"); // group: the same 40k of conversation
  assert.equal(at(10_000, 50_001), "resume then compact");
  // a session saved before the baseline existed keeps the absolute limit
  assert.equal(planSession(session({ lastTurnAt: ago(1), lastContextTokens: 60_001 }), now, opts), "resume then compact");
});

test("session: time alone never starts a fresh session; a turn from last month still resumes", () => {
  assert.equal(planSession(session({ lastTurnAt: ago(30) }), now, opts), "resume");
  assert.equal(planSession(session({ lastTurnAt: ago(24 * 40) }), now, { ...opts, mode: "off" }), "resume");
});

test("session: quiet compaction waits for the conversation to be still; urgent needs 1.5 times the growth", () => {
  const q = { ...opts, quietMinutes: 5 };
  const at = (mode: "quiet" | "urgent", mins: number, last: number) =>
    planSession(session({ lastTurnAt: new Date(now.getTime() - mins * 60_000).toISOString(), baseTokens: 10_000, lastContextTokens: last }), now, { ...q, mode });
  assert.equal(at("quiet", 4.9, 60_000), "resume"); // grown, but written to a moment ago
  assert.equal(at("quiet", 5, 60_000), "resume then compact");
  assert.equal(at("quiet", 30, 50_000), "resume"); // exactly the limit (10k + 40k) is not more
  assert.equal(at("urgent", 0, 70_000), "resume"); // 10k + 1.5 * 40k = 70k is not more
  assert.equal(at("urgent", 0, 70_001), "resume then compact");
  assert.equal(at("urgent", 0, 60_000), "resume"); // quiet would compact later
  assert.equal(planSession(session({ lastTurnAt: ago(1), lastContextTokens: 90_000 }), now, { ...q, mode: "urgent" }), "resume"); // fallback limit 60k * 1.5
  assert.equal(planSession(session({ lastTurnAt: ago(1), lastContextTokens: 90_001 }), now, { ...q, mode: "urgent" }), "resume then compact");
  assert.equal(planSession(session({ lastTurnAt: ago(1), baseTokens: 1, lastContextTokens: 900_000 }), now, { ...q, mode: "off" }), "resume");
  // a recent failure backs off in both modes
  assert.equal(planSession(session({ lastTurnAt: ago(1), baseTokens: 1, lastContextTokens: 900_000, compactFailedAt: ago(0.5) }), now, { ...q, mode: "urgent" }), "resume");
});

test("session: a session the SDK can no longer resume is forgotten, any other error is not", async () => {
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { forgetUnresumable } = await import("../src/run/chatsession.ts");
  const file = scratch(`session-${process.pid}.json`); // state files are relative to the data dir (HARNESS_DATA_DIR in tests)
  const { dataPath } = await import("../src/core/state.ts");
  mkdirSync(dirname(dataPath(file)), { recursive: true }); // a fresh data directory has no state/ yet
  writeFileSync(dataPath(file), JSON.stringify({ sessionId: "s1", costUsd: 3, baseTokens: 50_000, lastContextTokens: 80_000, seenAt: "x" }));
  assert.equal(forgetUnresumable(file, new Error("network down"), "chat"), false);
  assert.equal(JSON.parse(readFileSync(dataPath(file), "utf8")).sessionId, "s1");
  assert.equal(forgetUnresumable(file, new Error("No conversation found with session ID: s1"), "chat"), true);
  const after = JSON.parse(readFileSync(dataPath(file), "utf8"));
  assert.equal(after.sessionId, undefined);
  assert.equal(after.seenAt, "x", "a group keeps what it has been shown");
  assert.equal(planSession(after, now, opts), "fresh");
});
