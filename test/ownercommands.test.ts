import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { appendRow, type HeartbeatRow } from "../src/core/looks.ts";
import { instanceDb } from "../src/core/instancedb.ts";
import { commandReply, lastOwnerLook, parseCommand, statusText } from "../src/conversation/ownercommands.ts";
import { isPaused, pauseText } from "../src/core/pause.ts";
import { dataPath, readText, writeText } from "../src/core/state.ts";
import { RunStopped, stopRuns, withCeiling } from "../src/run/ceiling.ts";
import { groupConvId, instancePaths, OWNER_CONV } from "../src/core/convpaths.ts";

const NOW = new Date(2026, 9, 14, 14, 30, 20); // 14:30 local
const ownerConv = { kind: "owner", key: "owner", convId: OWNER_CONV } as const;
const friendConv = { kind: "tenant", key: "tenant:x", convId: "friend-x" } as const;
const clear = () => rmSync(dataPath(instancePaths().paused), { force: true });

test("parseCommand: exactly the commands, nothing inside a sentence", () => {
  assert.deepEqual(parseCommand("/stop", NOW), { kind: "stop" });
  assert.deepEqual(parseCommand("  Stop!  ", NOW), { kind: "stop" });
  assert.deepEqual(parseCommand("/Resume", NOW), { kind: "resume" });
  assert.deepEqual(parseCommand("/status", NOW), { kind: "status" });
  for (const t of ["stop", "please /stop", "/stop it", "stop! now", "/statuses", "/pausefoo", "hello"]) assert.equal(parseCommand(t, NOW), undefined, t);
});

test("parseCommand /pause: a span, a clock time (today's or tomorrow's), a day, or until /resume", () => {
  const two = parseCommand("/pause 2h", NOW);
  assert.equal(two?.kind === "pause" && two.until, new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
  const half = parseCommand("/pause 30m", NOW);
  assert.equal(half?.kind === "pause" && half.until, new Date(NOW.getTime() + 30 * 60_000).toISOString());
  const eve = parseCommand("/pause until 18:00", NOW);
  assert.equal(eve?.kind === "pause" && new Date(eve.until).getTime(), new Date(2026, 9, 14, 18, 0, 0).getTime());
  assert.match(eve?.kind === "pause" ? eve.text : "", /18:00\. \/resume/);
  const next = parseCommand("/pause until 9", NOW);
  assert.equal(next?.kind === "pause" && new Date(next.until).getTime(), new Date(2026, 9, 15, 9, 0, 0).getTime(), "9:00 has passed today: tomorrow");
  assert.match(next?.kind === "pause" ? next.text : "", /tomorrow/);
  assert.deepEqual(parseCommand("/pause until 2026-12-24", NOW), { kind: "pause", until: "2026-12-24", text: "Paused until 2026-12-24. /resume to undo." });
  assert.equal(parseCommand("/pause", NOW)?.kind === "pause" && (parseCommand("/pause", NOW) as { until: string }).until, "");
  for (const bad of ["/pause soon", "/pause 0h", "/pause 2x", "/pause until 25:00", "/pause until 2026-13-45"]) assert.deepEqual(parseCommand(bad, NOW), { kind: "pause-usage" }, bad);
});

test("/pause writes the pause switch (a time inside), /resume removes it, and the switch honours the time", () => {
  clear();
  const made: string[] = [];
  const reply = commandReply(ownerConv, "/pause 2h", { now: () => NOW, setPause: (c) => (made.push(c), writeText(instancePaths().paused, c)) });
  assert.match(reply!, /^Paused until 16:30\./);
  assert.equal(isPaused(NOW), true);
  assert.equal(isPaused(new Date(NOW.getTime() + 119 * 60_000)), true);
  assert.equal(isPaused(new Date(NOW.getTime() + 121 * 60_000)), false, "the time has come: running again");
  assert.match(pauseText(NOW) ?? "", /^paused until /);
  assert.equal(commandReply(ownerConv, "/resume"), "Resumed.");
  assert.equal(readText(instancePaths().paused), undefined);
  assert.equal(isPaused(NOW), false);
  commandReply(ownerConv, "/pause", { now: () => NOW });
  assert.equal(readText(instancePaths().paused), "", "bare /pause: until /resume");
  assert.equal(isPaused(new Date(2030, 0, 1)), true);
  clear();
  writeText(instancePaths().paused, "2026-10-20");
  assert.equal(isPaused(NOW), true, "a day inside still works as before");
  assert.equal(isPaused(new Date(2026, 9, 20, 8)), false);
  clear();
});

test("pause, resume and status are the owner's; a friend can only stop her own run", () => {
  clear();
  assert.equal(commandReply(friendConv, "/pause 2h"), undefined);
  assert.equal(commandReply(friendConv, "/status"), undefined);
  assert.equal(commandReply(friendConv, "/resume"), undefined);
  assert.equal(readText(instancePaths().paused), undefined);
  let stopped = "";
  assert.equal(commandReply(friendConv, "stop!", { stop: (s) => ((stopped = s), 1) }), "Stopped.");
  assert.equal(stopped, "friend-x");
  assert.equal(commandReply(ownerConv, "/stop", { stop: () => 0 }), "Nothing is running right now.");
  assert.equal(commandReply({ kind: "group", key: "g", convId: groupConvId("g") }, "/stop"), undefined, "a group has no commands");
  assert.match(commandReply(ownerConv, "/pause banana")!, /\/pause 2h/);
});

test("/stop aborts the conversation's running turn at once, with RunStopped; other runs and later ones are untouched", async () => {
  let signal: AbortSignal | undefined;
  const running = withCeiling(60_000, (c) => ((signal = c.signal), new Promise<string>(() => {})), OWNER_CONV);
  const other = withCeiling(60_000, (c) => new Promise<string>((r) => c.signal.addEventListener("abort", () => r("aborted"))), "other/session.json");
  other.catch(() => {});
  assert.equal(stopRuns(OWNER_CONV), 1);
  await assert.rejects(running, RunStopped);
  assert.equal(signal?.aborted, true, "the query's abort signal fired");
  assert.equal(stopRuns(OWNER_CONV), 0, "nothing left to stop");
  assert.equal(stopRuns("other/session.json"), 1);
  assert.equal(await withCeiling(60_000, async () => "fine", OWNER_CONV), "fine", "the next turn runs normally");
});

test("/status: a phone-sized summary", () => {
  const text = statusText({ pause: "paused until 16:30", spentUsd: 3.456, limitUsd: 20, lastLook: { at: new Date(2026, 9, 14, 14, 2), outcome: "silent" }, approvals: 2, down: ["Notion"] });
  assert.equal(text, "Paused: paused until 16:30.\nBudget today: $3.46 of $20.\nLast look: 14:02 (silent).\nOpen approvals: 2.\nConnectors down: Notion. See `npm run doctor`.");
  assert.match(statusText({ spentUsd: 21, limitUsd: 20, approvals: 0, down: [] }), /Running \(not paused\)\.\nBudget today: \$21\.00 of \$20 \(reached.*\nLast look: none yet\.\nOpen approvals: 0\.\nConnectors: none down\./);
  const real = commandReply(ownerConv, "/status");
  assert.match(real!, /Budget today/);
});

test("the last look comes from the heartbeat's own rows (the owner's), newest first", () => {
  assert.equal(lastOwnerLook(), undefined, "no look yet");
  for (const r of [{ at: "2026-10-14T10:00:00.000Z", kind: "owner", outcome: "posted" }, { at: "2026-10-14T11:00:00.000Z", kind: "group", outcome: "failed" }, { at: "2026-10-14T12:00:00.000Z", outcome: "silent" }] as const) {
    appendRow({ night: false, message: false, nextCheckMinutes: 30, costUsd: 0, toolCalls: 0, archived: 0, delegations: 0, ...r } as HeartbeatRow);
  }
  assert.deepEqual(lastOwnerLook(), { at: new Date("2026-10-14T12:00:00.000Z"), outcome: "silent" }, "a row with no kind is the owner's");
  instanceDb().run("DELETE FROM looks WHERE at = ?", "2026-10-14T12:00:00.000Z");
  assert.deepEqual(lastOwnerLook(), { at: new Date("2026-10-14T10:00:00.000Z"), outcome: "posted" }, "the group's later look is not the owner's");
});

test("/stop also drops the messages still waiting for their turn, and says Stopped. for that alone", () => {
  assert.equal(commandReply(ownerConv, "/stop", { stop: () => 0, dropQueued: () => 2 }), "Stopped.");
  assert.equal(commandReply(ownerConv, "/stop", { stop: () => 0, dropQueued: () => 0 }), "Nothing is running right now.");
});
