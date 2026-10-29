import { test } from "node:test";
import assert from "node:assert/strict";
import { told } from "./told.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, owner, type Conversation } from "../src/conversation/conversation.ts";
import { clampLook, parseHeartbeatAnswer, HEARTBEAT_SCHEMA } from "../src/run/rules.ts";
import { lastLookText, lookInstruction, lookPrompt, preemptible } from "../src/heartbeat/look.ts";
import { heartbeatReport } from "../src/heartbeat/report.ts";
import { chatSystem } from "../src/run/persona.ts";
import { readRows, type HeartbeatRow } from "../src/core/looks.ts";
import { readAudit } from "../src/core/audit.ts";
import { ledgerEntries, parseWake, recordMessage, type Kind } from "../src/core/messages.ts";
import { lookState } from "../src/conversation/ledger.ts";
import { createSeenMail } from "../src/modules/seenmail/seenmail.ts";
import { settings } from "../src/core/settings.ts";
import { instanceDb } from "../src/core/instancedb.ts";
import { createWakeups } from "../src/heartbeat/wake.ts";
import { readRecord } from "../src/tasks/routines.ts";
import { liveConvDb } from "../src/core/convdb.ts";
import { RunTimeout } from "../src/run/ceiling.ts";
import { heldPosts, resetHeld, ownerNotices } from "../src/heartbeat/notices.ts";
import type { RunProvenance } from "../src/approvals/autojudge.ts";
import { scratchLog } from "./scratch.ts";

const s = settings as unknown as Record<string, unknown>;
s.briefBackstopHour = 24; // the brief is the brief tests' (test/tasks.test.ts); here the owner's look is all that runs
const DAY = new Date(2026, 9, 14, 14, 0, 0); // a Wednesday, 14:00 local
const NIGHT = new Date(2026, 9, 14, 23, 30, 0);
const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const row = (at: Date, over: Partial<HeartbeatRow> = {}): HeartbeatRow => ({ at: at.toISOString(), kind: "owner", night: false, message: false, nextCheckMinutes: 30, costUsd: 0.01, toolCalls: 0, archived: 0, delegations: 0, outcome: "silent", ...over });
const reset = () => (instanceDb().run("DELETE FROM looks"), resetHeld(owner())); // (the rows, and what quiet hours held)

interface Answer { mail?: string[]; hold?: Promise<unknown>; hang?: boolean; timeout?: boolean; urgent?: boolean; sends?: number; message?: string; nextCheckMinutes?: number; throws?: boolean; calls?: string[]; delegates?: number; agents?: string[]; results?: Record<string, string>; mailed?: boolean; during?: () => void }
function rig(answer: () => Answer, o: { clocks?: { wall: () => number; mono: () => number }; paused?: boolean; spent?: boolean; groups?: string[]; busy?: () => boolean; pipeline?: object; awaitingApproval?: () => boolean; stagger?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  reset();
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  mkdirSync(join(dir, "n"));
  for (const [skill, when] of [["daily-brief", "every day at 07:30"], ["evening-wrap", "every weekday at 18:30"], ["weekly-review", "every fri at 16:30"]]) writeFileSync(join(dir, "n", `routine-${skill}.md`), `---\nwhen: ${when}\n---\nRun the ted-personal-assistant:${skill} skill and deliver it as it says.\n`); // (the owner's routine notes)
  const conv: Conversation = { ...owner(), logFile: scratchLog(`hb-owner-${Math.random().toString(36).slice(2)}.jsonl`), notesDir: join(dir, "n") };
  const seen = { runs: [] as string[], prompts: [] as string[], provenance: [] as (RunProvenance | undefined)[], posted: [] as string[], recorded: [] as [string, string][] };
  let now = DAY;
  let sends = 0; // what the run sent with the send tool while it worked (the real tool is the pipeline's sendWhile)
  const pipeline = {
    ...o.pipeline, canSpeak: () => false, busy: () => !!o.busy?.(), sendWhile: async (_c: unknown, run: () => Promise<unknown>, onSend?: () => void) => { const r = await run(); for (let i = 0; i < sends; i++) onSend?.(); return r; },
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
    run: async (c, _payer, build, extra) => {
      seen.runs.push(c.kind);
      seen.prompts.push(told(build, extra));
      seen.provenance.push(extra.provenance);
      const a = answer();
      sends = a.sends ?? 0;
      a.during?.();
      for (let i = 0; i < (a.delegates ?? 0); i++) extra.onDelegate?.("expert");
      for (const g of a.agents ?? []) extra.onDelegate?.(g);
      for (const [g, text] of Object.entries(a.results ?? {})) extra.onToolSuccess?.("Agent", { subagent_type: g }, { content: [{ type: "text", text }] });
      if (a.mailed) extra.onToolSuccess?.("mcp__claude_ai_Gmail__send_message", {});
      if (a.hold) await Promise.race([a.hold, new Promise((_, no) => extra.signal?.addEventListener("abort", () => no(new Error("aborted")), { once: true }))]); // a run that goes on until it is called off
      if (a.hang) await new Promise<never>((_, no) => extra.signal?.addEventListener("abort", () => no(new Error("aborted")), { once: true }));
      if (a.timeout) throw new RunTimeout(10 * 60_000);
      if (a.throws) throw new Error("boom");
      for (const t of a.calls ?? []) extra.onToolSuccess?.(t, {});
      if (a.mail) extra.seenMail?.unseen(a.mail);
      return { text: "", costUsd: 0.02, structured: { message: a.message ?? "[[silent]]", nextCheckMinutes: a.nextCheckMinutes ?? 30, ...(a.urgent ? { urgent: true } : {}) } };
    },
    notesChangedAt: () => 0,
    now: () => now,
    awaitingApproval: o.awaitingApproval,
    stagger: o.stagger,
    sleep: o.sleep,
    guards: { paused: () => !!o.paused, budgetSpent: () => !!o.spent },
    clocks: o.clocks,
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
  assert.deepEqual(parseHeartbeatAnswer({ message: " Eve is waiting ", nextCheckMinutes: 15 }, ""), { message: "Eve is waiting", nextCheckMinutes: 15, urgent: false });
  assert.deepEqual(parseHeartbeatAnswer(undefined, JSON.stringify({ message: "hi", nextCheckMinutes: 600 })), { message: "hi", nextCheckMinutes: 120, urgent: false });
  for (const m of ["[[silent]]", "[[SILENT]]", "", "   ", "[[silent]] nothing to say"]) assert.equal(parseHeartbeatAnswer({ message: m, nextCheckMinutes: 30 }, "").message, undefined, m);
  assert.equal(parseHeartbeatAnswer({ message: null, nextCheckMinutes: 30 }, "").message, undefined);
  assert.equal(parseHeartbeatAnswer(undefined, "I looked at the mail and thought about it").message, undefined, "free text is never posted");
  assert.equal(parseHeartbeatAnswer(undefined, "").nextCheckMinutes, 30);
});

test("the instruction: the clock, the zone, the last look, the quiet window and the brief rules as text; no gate vocabulary", () => {
  const text = lookInstruction(DAY, new Date(2026, 9, 14, 13, 30).toISOString());
  assert.match(text, /Wednesday 2026-10-14 14:00/);
  assert.ok(text.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.match(text, /Your last check was at 13:30\./);
  assert.match(text, /Quiet hours \(night\) are 22:00-07:00/);
  assert.match(text, /^Background check at /);
  // what to do in a check is the conversation's prompt (the same for a chat turn): the message holds only the time and the facts
  const rules = chatSystem();
  assert.match(rules, /Code holds what you would post unprompted at night/);
  assert.match(rules, /Set "urgent" to true only for what is truly time-critical/);
  assert.match(rules, /working late, tell me everything tonight/);
  assert.match(rules, /memory note/);
  assert.match(rules, /seen_mail tool/);
  assert.match(rules, /load ted-personal-assistant:mail/);
  assert.match(rules, /with the send tool/);
  assert.doesNotMatch(rules + text, /at most 5 mails|never mail you have not read/, "the archive floor is gone");
  assert.match(rules, /\[\[silent\]\]/);
  assert.doesNotMatch(rules + text, /idle fingerprint|nextCheckMinutes|"act"/i);
  assert.match(lastLookText(undefined, DAY), /first check/);
  assert.match(lastLookText(new Date(2026, 9, 13, 9, 0).toISOString(), DAY), /an earlier day/);
  const prompt = lookPrompt(text, ["[10-14 13:00] Alex: call Eve"]);
  assert.doesNotMatch(prompt, /CURRENT TIME/, "the clock is the run path's (agent.ts)");
  assert.match(prompt, /call Eve/);
});

test("a look logs one cost line, like a chat turn's replied line", async () => {
  const { w, conv } = rig(() => ({ message: "Eve waits." }));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await w.look(conv, DAY);
  } finally {
    console.log = log;
  }
  assert.equal(lines.filter((l) => /^owner look posted \(\$\d+\.\d{4}, 0 tool call\(s\), 0 delegation\(s\)\)$/.test(l)).length, 1, lines.join("\n"));
});

test("owner's look: ONE heartbeat run with standing provenance, no gate, the message posted, the next look recorded, one row without words", async () => {
  const { w, conv, seen, wakeLine } = rig(() => ({ message: "Eve still waits for your answer about Friday.", nextCheckMinutes: 45, calls: ["mcp__mailbird__list_conversations", "mcp__mailbird__archive_conversation", "mcp__mailbird__archive_conversation"] }));
  assert.equal(await w.look(conv, DAY), "posted");
  assert.deepEqual(seen.runs, ["owner"]);
  assert.equal(seen.provenance[0]?.kind, "standing", "the judge reads the fixed instruction as the reason for the run");
  assert.match((seen.provenance[0] as { task: string }).task, /Background check at/);
  assert.doesNotMatch((seen.provenance[0] as { task: string }).task, /call Eve|Friday/, "no chat in the standing task");
  assert.deepEqual(seen.posted, ["Eve still waits for your answer about Friday."]);
  const wake = wakeLine();
  assert.equal(Date.parse(wake.next) - DAY.getTime(), 45 * 60_000);
  assert.equal(Date.parse(wake.looked), DAY.getTime());
  const rows = readRows();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { at: DAY.toISOString(), kind: "owner", night: false, message: true, sent: 0, nextCheckMinutes: 45, costUsd: 0.02, toolCalls: 3, archived: 2, delegations: 0, outcome: "posted" });
  assert.doesNotMatch(JSON.stringify(readRows()), /Eve|Friday|waits/, "the row carries no words");
  assert.ok(!seen.recorded.some(([k]) => k === "action"), "no coarse action line any more: what the look did is one journal line per action, written as each call succeeds (core/events.ts)");
  assert.deepEqual(readAudit((e) => e.tool === "wake").map((e) => [e.decision, e.source]).at(-1), ["posted", "background"], "the audit row of the look comes from the same event as the metrics row");
});

test("owner's look: while a chat turn of the conversation is settling, queued or running the look waits, records nothing, and runs on the next tick", async () => {
  let turn = true;
  const { w, conv, seen } = rig(() => ({ message: "A correction." }), { busy: () => turn });
  assert.equal(await w.look(conv, DAY), "busy");
  assert.equal(await w.look(conv, min(DAY, 5)), "busy", "the free tick tries again");
  assert.deepEqual(seen.runs, [], "no model run while the turn works");
  assert.deepEqual(readRows(), [], "nothing is recorded: the look is still due, not dropped");
  turn = false;
  assert.equal(await w.look(conv, min(DAY, 10)), "posted");
  assert.deepEqual(seen.runs, ["owner"]);
});

test("owner's look: the delegations to experts are counted in the row; the expert's cost is in the run's cost", async () => {
  const { w, conv } = rig(() => ({ delegates: 2, calls: ["Agent", "mcp__claude_ai_Notion__notion-fetch", "Agent"] }));
  assert.equal(await w.look(conv, DAY), "silent", "the expert delivered itself; the run answered [[silent]]");
  assert.deepEqual(readRows().map((r) => [r.delegations, r.toolCalls, r.costUsd]), [[2, 3, 0.02]]);
});

test("owner's look: a run that spoke with the send tool while it worked counts as having said something, even when its final answer is [[silent]]", async () => {
  const { w, conv, seen } = rig(() => ({ sends: 2, delegates: 1, calls: ["Agent"] }));
  assert.equal(await w.look(conv, DAY), "posted");
  assert.deepEqual(seen.posted, [], "the final answer had nothing to add: nothing is posted twice");
  assert.deepEqual(readRows().map((r) => [r.message, r.sent, r.outcome]), [[true, 2, "posted"]]);
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

test("the incident: a post held at 22:35 is not sent at 07:00; the morning look gets it once as a fact, a second look does not", async () => {
  const EVENING = new Date(2026, 9, 22, 22, 35, 0);
  const TEXT = "Evening, Alex. Bit of a bump to report: today's morning brief never made it through. Two attempts ran out of steam, so I'm not retrying tonight.";
  let message = TEXT;
  const { w, conv, seen, at } = rig(() => ({ message, nextCheckMinutes: 120 }));
  at(EVENING);
  assert.equal(await w.look(conv, EVENING), "silent", "held by quiet hours");
  message = "[[silent]]";
  const release = new Date(2026, 9, 23, 7, 0, 0);
  at(release);
  await w.tick(release); // the look chose 120 minutes, yet it is due now: something was held for it
  assert.deepEqual(seen.posted, [], "never delivered verbatim");
  assert.equal(seen.runs.length, 2, "the morning look ran at once");
  const block = `Held back and not sent (written 22:35 yesterday): "${TEXT}"`;
  assert.equal(seen.prompts[1]!.split(block).length - 1, 1, "the held text, once");
  assert.match(seen.prompts[1]!, /These were not delivered\. Say again only what is still true and still matters now, in today's words/);
  assert.doesNotMatch((seen.provenance[1] as { task: string }).task, /Held back/, "not in the standing reason the judge reads");
  assert.deepEqual(heldPosts(conv), [], "handed over: no longer held");
  assert.equal(await w.look(conv, min(release, 20)), "not-due", "nothing waits any more: the look keeps the time it chose");
  const later = min(release, 125);
  at(later);
  assert.equal(await w.look(conv, later), "silent");
  assert.equal(seen.runs.length, 3);
  assert.doesNotMatch(seen.prompts[2]!, /Held back/, "passed exactly once");
});

test("owner's look at night: the posts are HELD in code, an urgent one goes at once, and the morning look gets the rest as facts (held after midnight)", async () => {
  let urgent = false;
  const { w, conv, seen, at } = rig(() => ({ message: `news #${seen.recorded.length + 1}`, nextCheckMinutes: 10, urgent }));
  const AFTER = new Date(2026, 9, 15, 0, 30, 0); // (the morning's own day: a post of the day before goes to the look instead, the test above)
  at(AFTER);
  assert.equal(await w.look(conv, AFTER), "silent", "held, not posted");
  const t2 = min(AFTER, 11);
  at(t2);
  assert.equal(await w.look(conv, t2), "silent");
  assert.deepEqual(seen.posted, []);
  const held = ledgerEntries().filter((e) => e.kind === "journal" && e.cat === "notice" && /Held a message for later: news #\d+/.test(e.text) && /quiet hours/.test(e.text));
  assert.ok(held.length >= 2, "the journal says each post was held, with why");
  urgent = true;
  const t3 = min(AFTER, 22);
  at(t3);
  assert.equal(await w.look(conv, t3), "posted", "urgent: posted at night");
  assert.equal(seen.posted.length, 1);
  assert.deepEqual(readRows().map((r) => [r.night, r.outcome]), [[true, "silent"], [true, "silent"], [true, "posted"]]);
  const morning = new Date(2026, 9, 15, 7, 5, 0);
  at(morning);
  await w.tick(morning); // the look is due at once: it is handed what was held (and posts its own urgent news)
  assert.equal(seen.posted.length, 2, "nothing held is sent as it was written");
  assert.equal(seen.prompts[seen.prompts.length - 1]!.split("Held back and not sent").length - 1, 2, "both held posts are in the morning look's prompt");
});

test("owner's look in the day: the daily cap holds the posts past it (urgent ones exempt)", async () => {
  s.maxUnpromptedPerDay = 2;
  try {
    let urgent = false;
    const { w, conv, seen, at } = rig(() => ({ message: `msg #${seen.recorded.length + seen.posted.length + 1}`, nextCheckMinutes: 10, urgent }));
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = min(DAY, i * 11);
      at(t);
      outcomes.push(await w.look(conv, t));
    }
    urgent = true;
    const t = min(DAY, 40);
    at(t);
    outcomes.push(await w.look(conv, t));
    assert.deepEqual(outcomes, ["posted", "posted", "silent", "posted"]);
    assert.equal(seen.posted.length, 3);
  } finally {
    s.maxUnpromptedPerDay = 6;
  }
});

test("owner's look: due only when the chosen time has come, the owner wrote or a note changed", async () => {
  const { w, conv, seen, at } = rig(() => ({ nextCheckMinutes: 30 }));
  assert.equal(await w.look(conv, DAY), "silent");
  at(min(DAY, 10));
  assert.equal(await w.look(conv, min(DAY, 10)), "not-due");
  recordMessage("owner", min(DAY, 11).getTime(), "can you check the invoice", min(DAY, 11), conv.logFile); // she wrote after the look began
  at(min(DAY, 12));
  assert.equal(await w.look(conv, min(DAY, 12)), "silent", "someone wrote: the look comes early");
  assert.equal(seen.runs.length, 2);
  at(min(DAY, 50));
  assert.equal(await w.look(conv, min(DAY, 50)), "silent", "the chosen time came");
  assert.equal(lookState(ledgerEntries(conv.logFile)).wake !== undefined, true);
});

test("owner's look: pause and mayRun stop it before any model call, nothing is recorded", async () => {
  const paused = rig(() => ({}), { paused: true });
  assert.equal(await paused.w.look(paused.conv, DAY), "guarded");
  const spent = rig(() => ({}), { spent: true });
  assert.equal(await spent.w.look(spent.conv, DAY), "blocked");
  const { coolingDown, resetCooldown } = await import("../src/core/cooldown.ts");
  const { failure } = await import("../src/tenants/errors.ts");
  failure("rate_limit", "success"); // a usage limit starts the cooldown
  assert.ok(coolingDown());
  const cooling = rig(() => ({}));
  assert.equal(await cooling.w.look(cooling.conv, DAY), "cooldown");
  resetCooldown();
  for (const r of [paused, spent, cooling]) {
    assert.deepEqual(r.seen.runs, [], "no run started");
    assert.deepEqual(readRows(), []);
    assert.equal(lookState(ledgerEntries(r.conv.logFile)).wake, undefined, "nothing recorded: the next tick looks again");
  }
  // the tick itself stops while paused
  const t = rig(() => ({}), { paused: true });
  await t.w.tick(DAY);
  assert.deepEqual(t.seen.runs, []);
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

test("a look that times out is a 'timeout' row, posts nothing, and is due again on the next ticks (10 min: the tick within the 10..120 rule), not after the day's 30", async () => {
  const err = console.error;
  console.error = () => {};
  try {
    for (const [answer, outcome] of [[{ timeout: true }, "timeout"], [{ throws: true }, "failed"]] as const) {
      const { w, conv, seen, wakeLine, at } = rig(() => answer);
      assert.equal(await w.look(conv, DAY), outcome);
      assert.deepEqual(seen.posted, []);
      const rows = readRows();
      assert.deepEqual(rows.map((r) => [r.outcome, r.message, r.costUsd, r.nextCheckMinutes]), [[outcome, false, 0, 10]]);
      assert.equal(Date.parse(wakeLine().next), DAY.getTime() + 10 * 60_000);
      at(min(DAY, 5));
      assert.equal(await w.look(conv, min(DAY, 5)), "not-due", "not on the very next minute");
      assert.equal(await w.look(conv, min(DAY, 10)), outcome, "due again after the retry time");
    }
  } finally {
    console.error = err;
  }
});

test("the Mac slept: a look in flight is stopped, ends as a failed row without a message, and is due again at the very next check", async () => {
  const err = console.error;
  console.error = () => {};
  try {
    const { w, conv, seen, wakeLine } = rig(() => ({ hang: true }));
    const look = w.look(conv, DAY);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen.runs, ["owner"]);
    assert.equal(w.slept(), 1, "one run was stopped");
    assert.equal(await look, "failed");
    assert.deepEqual(seen.posted, []);
    assert.deepEqual(readRows().map((r) => [r.outcome, r.costUsd]), [["failed", 0]]);
    assert.equal(Date.parse(wakeLine().next), DAY.getTime(), "due at once: the normal due-check restarts it, no 10-minute wait");
    assert.equal(w.slept(), 0, "nothing in flight, nothing to stop");
  } finally {
    console.error = err;
  }
});

test("after a sleep every conversation takes its staggered first look again, as after a restart; one still napping when the Mac sleeps is dropped and left due", async () => {
  const naps: number[] = [];
  let release!: () => void;
  const { w, seen } = rig(() => ({ message: "[[silent]]" }), { stagger: () => 4000, sleep: (ms) => (naps.push(ms), new Promise<void>((r) => (release = r))) });
  const tick = w.tick(DAY);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(naps, [4000]);
  w.slept(); // asleep during the nap
  release();
  await tick;
  assert.deepEqual(seen.runs, [], "dropped: it would have started on dead connections");
  naps.length = 0;
  const again = w.tick(DAY); // the next tick: the first look after waking naps again
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(naps, [4000]);
  release();
  await again;
  assert.equal(seen.runs.length, 1, "and then it is looked at");
  await w.tick(DAY);
  assert.deepEqual(naps, [4000], "later ticks do not nap");
  assert.equal(w.slept(), 0, "nothing in flight");
});

test("the daily brief is a routine like the others: the look is handed it as a fact, its delegation is recorded as started, a result makes it delivered, a look that dies after delegating makes it failed", async () => {
  const err = console.error;
  console.error = () => {};
  const BRIEF = "expert-daily-brief";
  const record = () => readRecord(owner().convId, "routine-daily-brief");
  const arm = () => liveConvDb(owner().convId)!.run("INSERT OR REPLACE INTO routine_runs (name, since) VALUES ('routine-daily-brief', ?)", new Date(2026, 9, 1).getTime());
  try {
    arm();
    const ok = rig(() => ({ agents: [BRIEF], results: { [BRIEF]: "the brief" }, message: "Morning." }));
    ok.at(new Date(2026, 9, 14, 8, 0));
    await ok.w.look(ok.conv, new Date(2026, 9, 14, 8, 0));
    assert.match(ok.seen.prompts[0]!, /routine-daily-brief: due now \(every day at 07:30\)\. Delegate it now: call the Agent tool with subagent_type "expert"/);
    assert.equal(record()!.status, "delivered");
    assert.equal(record()!.attempts, 1);
    const again = rig(() => ({ message: "[[silent]]" }));
    await again.w.look(again.conv, new Date(2026, 9, 14, 8, 30));
    assert.doesNotMatch(again.seen.prompts[0] ?? "", /routine-daily-brief: due now/, "once per day: delivered is done");

    for (const answer of [{ agents: [BRIEF], timeout: true }, { agents: [BRIEF], throws: true }] as Answer[]) {
      arm();
      const dead = rig(() => answer);
      await dead.w.look(dead.conv, new Date(2026, 9, 14, 8, 0));
      assert.deepEqual([record()!.status, record()!.attempts], ["failed", 1], "the look died after delegating: failed at once, the next look redoes it");
    }
    arm();
    const none = rig(() => ({ timeout: true }));
    await none.w.look(none.conv, new Date(2026, 9, 14, 8, 0));
    assert.equal(record()!.status, undefined, "nothing was delegated: no attempt is recorded");
  } finally {
    liveConvDb(owner().convId)!.run("DELETE FROM routine_runs"); // (the record is the conversation's, shared by the tests)
    console.error = err;
  }
});

test("groups get the same heartbeat run: one per look, with their own notes, in their own chat; a group with nothing to look at costs nothing; Note to Self never wakes groups", async () => {
  const G = "hb-group-0123456789abcdef";
  const EMPTY = "hb-empty-group-0123456789ab";
  for (const id of [G, EMPTY]) mkdirSync(group(id).notesDir, { recursive: true });
  writeFileSync(join(group(G).notesDir, "scheduling-fact.md"), "Every morning post a fun fact.");
  const { w, seen, at } = rig(() => ({ message: "Fun fact: biscuits." }), { groups: [G, EMPTY] });
  at(DAY);
  await w.tick(DAY);
  await w.idle();
  assert.deepEqual([...seen.runs].sort(), ["group", "owner"], "the owner's look and the group's, nothing for the group with no notes and no tools to read");
  assert.deepEqual(seen.posted, ["Fun fact: biscuits.", "Fun fact: biscuits."]);
  const groupPrompt = seen.prompts[seen.runs.indexOf("group")]!;
  assert.match(groupPrompt, /the group's local time/);
  assert.doesNotMatch(groupPrompt, /archive|calendar for the next 36 hours/i, "a group has no mail or calendar in its instruction");
  assert.deepEqual(readRows().map((r) => r.kind).sort(), ["group", "owner"]);
  const nts = rig(() => ({}), { groups: [G] });
  const wakeups = createWakeups({ pipeline: { canSpeak: () => false, busy: () => false, sendWhile: async (_c: unknown, run: () => Promise<unknown>) => run(), enqueue: async (_c: unknown, j: () => Promise<unknown>) => j(), record: () => {}, runTurn: async () => ({ spoke: false }) } as never, groupChats: false, vouch: async () => true, groups: () => [G], run: async (c) => (nts.seen.runs.push(c.kind), { text: "" }), notesChangedAt: () => 0, now: () => DAY, guards: { paused: () => false, budgetSpent: () => false } });
  await wakeups.tick(DAY);
  assert.deepEqual(nts.seen.runs, ["owner"], "groups are not woken on Note to Self");
});

test("the repeated fact of the day: yesterday's post is listed once as the group's own post, and still in the tail after a night of looks", async () => {
  const G = `hb-facts-${Math.random().toString(36).slice(2, 14)}`;
  mkdirSync(group(G).notesDir, { recursive: true });
  writeFileSync(join(group(G).notesDir, "scheduling-fact.md"), "Every morning post a fun fact.");
  const log = group(G).logFile;
  const YESTERDAY = new Date(2026, 9, 13, 9, 17, 0);
  recordMessage("notice", 1, "Fun fact: octopuses have three hearts.", YESTERDAY, log);
  recordMessage("notice", 2, "A post from last month", new Date(2026, 8, 1, 9, 0, 0), log);
  for (let i = 0; i < 40; i++) {
    const t = min(YESTERDAY, 30 + i * 40);
    recordMessage("wake", 10 + i, JSON.stringify({ next: min(t, 40).toISOString(), looked: t.toISOString() }), t, log);
    recordMessage("journal", 100 + i, `Looked at the notes ${i}. Why: x.`, min(t, 1), log, { cat: "other" });
  }
  const { w, seen, at } = rig(() => ({}), { groups: [G] });
  at(DAY);
  await w.tick(DAY);
  await w.idle();
  const prompt = seen.prompts[seen.runs.indexOf("group")]!;
  const own = "[2026-10-13 09:17] Fun fact: octopuses have three hearts.";
  assert.equal(prompt.split(own).length - 1, 1, "listed once among its own posts");
  assert.match(prompt, /Your own posts here in the last 7 days \(newest first\):\n<own_posts>/);
  assert.match(prompt, /Do not repeat a fact, joke, quote or idea you posted in the last 7 days; a recurring post \(daily fact, pep talk\) must be new each time\./);
  assert.doesNotMatch(prompt.split("<own_posts>")[1]!.split("</own_posts>")[0]!, /A post from last month/, "only the last 7 days");
  assert.match(prompt.split("<chat_log>")[1]!, /octopuses have three hearts/, "and the tail still reaches it");
  assert.doesNotMatch((seen.provenance[seen.prompts.indexOf(prompt)] as { task: string }).task, /own_posts/, "not in the judge's standing reason");
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
  assert.doesNotMatch(text, /by conversation/, "only the owner's rows: no split");
  const mixed = heartbeatReport([...rows, row(new Date(2026, 9, 14, 9, 30), { kind: "tenant", message: true, costUsd: 0.02, outcome: "posted" }), row(new Date(2026, 9, 14, 9, 40), { kind: "group", costUsd: 0.01 })], DAY, 7).join("\n");
  assert.match(mixed, /by conversation: owner 4 look\(s\), 2 message\(s\), \$0\.07; groups 1 look\(s\), 0 message\(s\), \$0\.01; friends 1 look\(s\), 1 message\(s\), \$0\.02/);
  const timed = heartbeatReport([row(DAY, { outcome: "timeout", costUsd: 0 }), row(min(DAY, 5), { outcome: "failed", costUsd: 0 }), row(min(DAY, 10))], DAY, 7).join("\n");
  assert.match(timed, /failed looks: 2, of which 1 timed out/);
  assert.match(timed, /^\d{4}-\d\d-\d\d +3 +0 +0 +2 /m, "the failed column counts timeouts too");
  assert.deepEqual(heartbeatReport([], DAY), ["No heartbeat looks in the last 7 day(s)."]);
});

// ---- the lease: a look and a chat turn of one conversation (conversation.ts lease) ----
function leaseRig() {
  const lease = { aborts: 0, ended: 0, news: false, parked: undefined as undefined | (() => boolean), abort: undefined as undefined | (() => void) };
  const pipeline = {
    lease: (_c: unknown, abort: () => void, parked: () => boolean) => ((lease.abort = () => (lease.aborts++, abort())), (lease.parked = parked), { news: () => lease.news, end: () => void lease.ended++ }),
  };
  return { lease, pipeline };
}

test("a look is called off when a message overtakes it: no post, no run left, the mail not marked seen, the row says so", async () => {
  const l = leaseRig();
  const never = new Promise(() => {});
  const { w, conv, seen } = rig(() => ({ hold: never, message: "never said" }), { pipeline: l.pipeline });
  const done = w.look(conv, DAY);
  await new Promise((r) => setTimeout(r, 10));
  l.lease.news = true;
  l.lease.abort!(); // what conversation.ts overtake does for a message that is not an approval answer
  assert.equal(await done, "preempted");
  assert.deepEqual(seen.posted, []);
  assert.equal(l.lease.ended, 1, "the lease is given back");
  assert.equal(readRows().at(-1)?.outcome, "preempted");
});

test("a look that has only read, when news came meanwhile, drops its message-only post as stale; one that acted still posts", async () => {
  for (const [calls, outcome, posted] of [[[], "silent", 0], [["mcp__mailbird__list_conversations", "mcp__seenmail__seen_mail"], "silent", 0], [["mcp__mailbird__archive_conversation"], "posted", 1]] as const) {
    const l = leaseRig();
    const { w, conv, seen } = rig(() => ({ message: "Eve is waiting.", calls: [...calls] }), { pipeline: { lease: (c: unknown, a: () => void, p: () => boolean) => ((l.lease.news = true), l.pipeline.lease(c, a, p)) } });
    assert.equal(await w.look(conv, DAY), outcome);
    assert.equal(seen.posted.length, posted);
  }
});

test("without news a message-only post goes out as always, and the lease asks the approvals whether the look is parked", async () => {
  const l = leaseRig();
  const { w, conv, seen } = rig(() => ({ message: "Eve is waiting." }), { pipeline: l.pipeline, awaitingApproval: () => true });
  assert.equal(await w.look(conv, DAY), "posted");
  assert.deepEqual(seen.posted, ["Eve is waiting."]);
  assert.equal(l.lease.parked!(), true);
});

test("the first look of a conversation after a start waits its stagger once; later looks do not", async () => {
  const naps: number[] = [];
  const { w, seen } = rig(() => ({ message: "[[silent]]" }), { stagger: () => 4000, sleep: async (ms) => void naps.push(ms) });
  await w.tick(DAY);
  await w.tick(min(DAY, 60));
  assert.deepEqual(naps, [4000], "once for the conversation, not on every tick");
  assert.ok(seen.runs.length >= 1);
});

test("preemptible: not after 2 preempted looks in a row, nor when the last full look is older than 2x the interval (30 minutes at least)", () => {
  const T = DAY.getTime();
  assert.equal(preemptible({ preempted: 0 }, T, 30), true, "no history: yes");
  assert.equal(preemptible({ preempted: 1, completedAt: T - 10 * 60_000 }, T, 30), true);
  assert.equal(preemptible({ preempted: 2, completedAt: T - 10 * 60_000 }, T, 30), false, "two in a row");
  assert.equal(preemptible({ preempted: 0, completedAt: T - 59 * 60_000 }, T, 30), true);
  assert.equal(preemptible({ preempted: 0, completedAt: T - 61 * 60_000 }, T, 30), false, "older than 2x30");
  assert.equal(preemptible({ preempted: 0, completedAt: T - 29 * 60_000 }, T, 5), true, "30 minutes at least");
  assert.equal(preemptible({ preempted: 0, completedAt: T - 31 * 60_000 }, T, 5), false);
});

test("a look that was preempted twice runs to completion the third time, though the message still counts as news", async () => {
  const l = leaseRig();
  const never = new Promise(() => {});
  let release!: () => void;
  const { w, conv, seen } = rig(() => ({ hold: l.lease.aborts >= 2 ? new Promise<void>((r) => (release = r)) : never, message: "Eve is waiting." }), { pipeline: l.pipeline });
  for (let i = 0; i < 2; i++) {
    const done = w.look(conv, min(DAY, i * 40));
    await new Promise((r) => setTimeout(r, 10));
    l.lease.news = true;
    l.lease.abort!();
    assert.equal(await done, "preempted");
  }
  const third = w.look(conv, min(DAY, 80));
  await new Promise((r) => setTimeout(r, 10));
  l.lease.news = true;
  l.lease.abort!(); // the guard declines
  release();
  assert.equal(await third, "silent", "it ran to completion; read-only with news, so its post was dropped as stale");
  assert.deepEqual(seen.posted, []);
});

test("looks that fail again and again: nothing in the chat; after 2 hours of failing with the Mac AWAKE the owner's next look gets it as a fact, and a look that works ends it silently", async () => {
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  let wall = DAY.getTime();
  let mono = 0;
  try {
    let mode: "boom" | "ok" = "boom";
    const { w, conv, at, seen } = rig(() => (mode === "boom" ? { throws: true } : { message: "[[silent]]" }), { clocks: { wall: () => wall, mono: () => mono } });
    for (let i = 0; i < 4; i++) {
      const t = min(DAY, i * 45);
      at(t);
      mono = i * 45 * 60_000; // awake all the while
      wall = t.getTime();
      assert.equal(await w.look(conv, t), "failed");
      assert.doesNotMatch(seen.prompts.at(-1)!, /background looks have failed/);
    }
    assert.deepEqual(told, [], "no notice, no fixed text, ever");
    mode = "ok";
    const t = min(DAY, 180);
    at(t);
    mono = 180 * 60_000;
    assert.equal(await w.look(conv, t), "silent");
    assert.match(seen.prompts.at(-1)!, /Your own background looks have failed 4 times in a row since 14:00 \(2\.3 hours of that with the Mac awake/);
    assert.match(seen.prompts.at(-1)!, /npm run doctor/, "the cause's fix, for the model to pass on if it matters");
    const t2 = min(DAY, 220);
    at(t2);
    mono = 220 * 60_000;
    await w.look(conv, t2);
    assert.doesNotMatch(seen.prompts.at(-1)!, /background looks have failed/, "it worked: the streak is over, no 'back to normal'");
    assert.deepEqual(told, []);
  } finally {
    ownerNotices.sendTo(undefined);
  }
});

test("a look cut by its ceiling across a sleep is neutral: it counts as no failure, however often", async () => {
  let wall = DAY.getTime();
  let mono = 0;
  const { w, conv, at, seen } = rig(() => ({ timeout: true, during: () => void (wall += 3_600_000) }), { clocks: { wall: () => wall, mono: () => mono } }); // an hour on the wall clock, no time awake
  for (let i = 0; i < 6; i++) {
    const t = min(DAY, i * 45);
    at(t);
    mono = i * 45 * 60_000;
    wall = t.getTime();
    await w.look(conv, t);
  }
  assert.equal(readRows().filter((r) => r.outcome === "failed").length, 6, "the rows say what happened (failed, not timeout: the sleep's)");
  // counted, the 4th look on (3 failures, 2 hours awake) would carry the failing-looks fact: none does
  assert.equal(seen.prompts.length, 6);
  assert.ok(seen.prompts.every((p) => !/background looks have failed/.test(p)));
});

test("a group's and a friend's failing looks never reach the owner's chat, and no group look is told of them", async () => {
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  let mono = 0;
  try {
    const G = "hb-failing-group-0123456789";
    mkdirSync(group(G).notesDir, { recursive: true });
    writeFileSync(join(group(G).notesDir, "scheduling-fact.md"), "Every morning post a fun fact."); // (something to look at)
    const { w, at, seen } = rig(() => ({ throws: true }), { groups: [G], clocks: { wall: Date.now, mono: () => mono } });
    for (let i = 0; i < 6; i++) {
      const t = min(DAY, i * 45);
      at(t);
      mono = i * 45 * 60_000;
      await w.tick(t);
      await w.idle();
    }
    assert.ok(seen.runs.filter((k) => k === "group").length >= 3, "the group's looks ran and failed");
    assert.deepEqual(told, []);
    assert.ok(seen.prompts.filter((_, i) => seen.runs[i] === "group").every((p) => !/background looks have failed/.test(p)));
  } finally {
    ownerNotices.sendTo(undefined);
  }
});

test("a post dropped as stale does not mark the mail it reported as seen: the next look raises it again", async () => {
  const l = leaseRig();
  const id = `stale-${Math.random().toString(36).slice(2)}`;
  const { w, conv, seen } = rig(() => ({ message: "Eve is waiting.", mail: [id], calls: ["mcp__seenmail__seen_mail"] }), { pipeline: { lease: (c: unknown, a: () => void, p: () => boolean) => ((l.lease.news = true), l.pipeline.lease(c, a, p)) } });
  assert.equal(await w.look(conv, DAY), "silent");
  assert.deepEqual(seen.posted, []);
  assert.deepEqual(createSeenMail(conv.convId).unseen([id]), [id], "not committed");
});

test("owner's look: browser steps leave no line of their own, so the look writes one short journal line; a look that only read writes none", async () => {
  const { w, conv } = rig(() => ({ calls: ["mcp__browser__browser_click", "mcp__browser__browser_navigate"] }));
  const before = ledgerEntries().filter((e) => e.kind === "journal").length;
  await w.look(conv, DAY);
  const lines = ledgerEntries().filter((e) => e.kind === "journal").slice(before);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text, /^Looked and took 2 steps that leave no line of their own/);
  const reads = rig(() => ({ calls: ["mcp__mailbird__list_conversations"] }));
  await reads.w.look(reads.conv, min(DAY, 60));
  assert.equal(ledgerEntries().filter((e) => e.kind === "journal").length - before, 1, "reading is not acting");
});

// Routines (tasks/routines.ts): what a look that handed the evening wrap to its expert leaves in the record.
async function eveningLook(a: Answer, day = 14) { // (a day of its own for each look: the record is the conversation's, shared by the tests)
  const { readRecord } = await import("../src/tasks/routines.ts");
  const r = rig(() => a);
  await r.w.look(r.conv, new Date(2026, 9, day, 17, 0, 0)); // first sight of the routine: nothing is owed for a slot already gone
  const at = new Date(2026, 9, day, 18, 35, 0); // after 18:30
  r.at(at);
  const out = await r.w.look(r.conv, at);
  return { out, rec: readRecord(r.conv.convId, "routine-evening-wrap")!, seen: r.seen };
}

test("routines: delivered when the expert's result came back; delegating twice is one attempt", async () => {
  const done = await eveningLook({ agents: ["expert-evening-wrap", "expert-evening-wrap"], results: { "expert-evening-wrap": "A quiet one." } });
  assert.match(done.seen.prompts.at(-1)!, /routine-evening-wrap: due now/);
  assert.equal(done.rec.status, "delivered");
  assert.equal(done.rec.attempts, 1, "the same routine handed on twice in one look is one attempt");
});

test("routines: an expert that came back with nothing (it ran out of turns) is a failed attempt, not a delivery", async () => {
  const none = await eveningLook({ agents: ["expert-evening-wrap"] }, 15);
  assert.equal(none.rec.status, "failed");
  assert.equal(none.rec.attempts, 1);
  const blank = await eveningLook({ agents: ["expert-evening-wrap"], results: { "expert-evening-wrap": "  " } }, 16);
  assert.equal(blank.rec.status, "failed");
});
