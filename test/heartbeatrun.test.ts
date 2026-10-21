import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, owner, type Conversation } from "../src/conversation/conversation.ts";
import { clampLook, parseHeartbeatAnswer, HEARTBEAT_SCHEMA } from "../src/run/rules.ts";
import { lastLookText, lookInstruction, lookPrompt, preemptible } from "../src/heartbeat/look.ts";
import { heartbeatReport } from "../src/heartbeat/report.ts";
import { readRows, type HeartbeatRow } from "../src/core/looks.ts";
import { readAudit } from "../src/core/audit.ts";
import { ledgerEntries, recordMessage, type Kind } from "../src/core/messages.ts";
import { lookState, parseWake } from "../src/conversation/ledger.ts";
import { createSeenMail } from "../src/modules/seenmail/seenmail.ts";
import { settings } from "../src/core/settings.ts";
import { dataPath } from "../src/core/state.ts";
import { instanceDb } from "../src/core/instancedb.ts";
import { createWakeups } from "../src/heartbeat/wake.ts";
import { heldPosts, resetHeld, ownerNotices } from "../src/heartbeat/notices.ts";
import type { RunProvenance } from "../src/approvals/autojudge.ts";
import { clearPending, openItems } from "../src/approvals/pending.ts";
import { queueCall, setPendingRuntime } from "../src/approvals/pendingflow.ts";
import { scratchLog } from "./scratch.ts";

const s = settings as unknown as Record<string, unknown>;
s.briefBackstopHour = 24; // the brief is the brief tests' (test/tasks.test.ts); here the owner's look is all that runs
const DAY = new Date(2026, 9, 14, 14, 0, 0); // a Wednesday, 14:00 local
const NIGHT = new Date(2026, 9, 14, 23, 30, 0);
const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const row = (at: Date, over: Partial<HeartbeatRow> = {}): HeartbeatRow => ({ at: at.toISOString(), kind: "owner", night: false, message: false, nextCheckMinutes: 30, costUsd: 0.01, toolCalls: 0, archived: 0, delegations: 0, outcome: "silent", ...over });
const reset = () => (instanceDb().run("DELETE FROM looks"), resetHeld(owner())); // (the rows, and what quiet hours held)

interface Answer { mail?: string[]; hold?: Promise<unknown>; urgent?: boolean; sends?: number; message?: string; nextCheckMinutes?: number; throws?: boolean; calls?: string[]; delegates?: number; during?: () => void }
function rig(answer: () => Answer, o: { paused?: boolean; spent?: boolean; groups?: string[]; busy?: () => boolean; pipeline?: object; awaitingApproval?: () => boolean; stagger?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  reset();
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  mkdirSync(join(dir, "n"));
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
    run: async (c, _payer, prompt, extra) => {
      seen.runs.push(c.kind);
      seen.prompts.push(prompt);
      seen.provenance.push(extra.provenance);
      const a = answer();
      sends = a.sends ?? 0;
      a.during?.();
      if (a.hold) await Promise.race([a.hold, new Promise((_, no) => extra.signal?.addEventListener("abort", () => no(new Error("aborted")), { once: true }))]); // a run that goes on until it is called off
      if (a.throws) throw new Error("boom");
      for (const t of a.calls ?? []) extra.onToolSuccess?.(t, {});
      if (a.mail) extra.seenMail?.unseen(a.mail);
      for (let i = 0; i < (a.delegates ?? 0); i++) extra.onDelegate?.("expert");
      return { text: "", costUsd: 0.02, structured: { message: a.message ?? "[[silent]]", nextCheckMinutes: a.nextCheckMinutes ?? 30, ...(a.urgent ? { urgent: true } : {}) } };
    },
    notesChangedAt: () => 0,
    now: () => now,
    awaitingApproval: o.awaitingApproval,
    stagger: o.stagger,
    sleep: o.sleep,
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
  assert.deepEqual(parseHeartbeatAnswer({ message: " Eve is waiting ", nextCheckMinutes: 15 }, ""), { message: "Eve is waiting", nextCheckMinutes: 15, urgent: false, needsYou: false });
  assert.deepEqual(parseHeartbeatAnswer(undefined, JSON.stringify({ message: "hi", nextCheckMinutes: 600 })), { message: "hi", nextCheckMinutes: 120, urgent: false, needsYou: false });
  for (const m of ["[[silent]]", "[[SILENT]]", "", "   ", "[[silent]] nothing to say"]) assert.equal(parseHeartbeatAnswer({ message: m, nextCheckMinutes: 30 }, "").message, undefined, m);
  assert.equal(parseHeartbeatAnswer({ message: null, nextCheckMinutes: 30 }, "").message, undefined);
  assert.equal(parseHeartbeatAnswer(undefined, "I looked at the mail and thought about it").message, undefined, "free text is never posted");
  assert.equal(parseHeartbeatAnswer(undefined, "").nextCheckMinutes, 30);
});

test("the instruction: the clock, the zone, the last look, the quiet window and the brief rules as text; no gate vocabulary", () => {
  const text = lookInstruction(DAY, new Date(2026, 9, 14, 13, 30).toISOString());
  assert.match(text, /Wednesday 2026-10-14 14:00/);
  assert.ok(text.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.match(text, /Your last look was at 13:30\./);
  assert.match(text, /Quiet hours \(night\) are 22:00-07:00/);
  assert.match(text, /Code holds what you would post unprompted at night/);
  assert.match(text, /Set "urgent" to true only for what is truly time-critical/);
  assert.match(text, /working late, tell me everything tonight/);
  assert.match(text, /memory note/);
  assert.match(text, /seen_mail tool/);
  assert.match(text, /Unread mail is archived like any other/);
  assert.match(text, /with the send tool/);
  assert.doesNotMatch(text, /at most 5 mails|never mail you have not read/, "the archive floor is gone");
  assert.match(text, /\[\[silent\]\]/);
  assert.doesNotMatch(text, /idle fingerprint|nextCheckMinutes|"act"/i);
  assert.match(lastLookText(undefined, DAY), /first look/);
  assert.match(lastLookText(new Date(2026, 9, 13, 9, 0).toISOString(), DAY), /an earlier day/);
  const prompt = lookPrompt(DAY, text, ["[10-14 13:00] Ben: call Eve"]);
  assert.match(prompt, /CURRENT TIME/);
  assert.match(prompt, /call Eve/);
});

test("owner's look: ONE heartbeat run with standing provenance, no gate, the message posted, the next look recorded, one row without words", async () => {
  const { w, conv, seen, wakeLine } = rig(() => ({ message: "Eve still waits for your answer about Friday.", nextCheckMinutes: 45, calls: ["mcp__mailbird__list_conversations", "mcp__mailbird__archive_conversation", "mcp__mailbird__archive_conversation"] }));
  assert.equal(await w.look(conv, DAY), "posted");
  assert.deepEqual(seen.runs, ["owner"]);
  assert.equal(seen.provenance[0]?.kind, "standing", "the judge reads the fixed instruction as the reason for the run");
  assert.match((seen.provenance[0] as { task: string }).task, /periodic look/);
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

test("owner's look: what the run needed a yes for is parked while it works and asked as ONE numbered message when the look ends", async () => {
  clearPending("owner");
  const sent: string[] = [];
  setPendingRuntime({ send: async (_s, t) => (sent.push(t), 77), holding: () => false, execute: async () => ({ ran: true, line: "ok" }), now: () => DAY });
  const park = (to: string) => queueCall("owner", { tool: "mcp__gmail__reply", input: { to }, label: `Reply to ${to}`, question: "Send it?", footer: "", source: "background" }, DAY);
  const { w, conv } = rig(() => ({ message: "[[silent]]", during: () => (park("a@example.com"), park("b@example.com"), assert.equal(sent.length, 0, "nothing is asked while the run works")) }));
  await w.look(conv, DAY);
  const batch = sent.filter((t) => t.startsWith("📬"));
  assert.equal(batch.length, 1);
  assert.match(batch[0]!, /^📬 2 things are waiting for your approval:\n1\. Reply to a@example\.com Send it\?\n2\. Reply to b@example\.com/);
  assert.equal(openItems("owner").length, 2, "they wait for the answer");
  setPendingRuntime(undefined);
  clearPending("owner");
});

test("the tick asks what quiet hours kept back and tells what expired, even when no look runs", async () => {
  clearPending("owner");
  const sent: string[] = [];
  let quiet = true;
  setPendingRuntime({ send: async (_s, t) => (sent.push(t), 78), holding: () => quiet, execute: async () => ({ ran: true, line: "ok" }), now: () => DAY });
  queueCall("owner", { tool: "mcp__gmail__reply", input: { to: "a@example.com" }, label: "Reply to a", question: "Send it?", footer: "", source: "background" }, DAY);
  queueCall("owner", { tool: "mcp__gmail__reply", input: { to: "old@example.com" }, label: "Reply to old", question: "Send it?", footer: "", source: "background" }, new Date(DAY.getTime() - 4 * 86_400_000));
  const { w } = rig(() => ({ message: "[[silent]]" }), { busy: () => true });
  await w.tick(DAY);
  assert.deepEqual(sent, [], "quiet: nothing is asked, nothing is told");
  quiet = false;
  await w.tick(DAY);
  assert.equal(sent.length, 2);
  assert.match(sent[0]!, /^⏳ Dropped, not answered in 3 days: #\d+ Reply to old\./);
  assert.match(sent[1]!, /^📬 1 thing is waiting for your approval:\n\d+\. Reply to a /);
  setPendingRuntime(undefined);
  clearPending("owner");
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
  const { w, conv, seen } = rig(() => ({ delegates: 2, calls: ["Agent", "mcp__claude_ai_Notion__notion-fetch", "Agent"] }));
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

test("owner's look at night: the posts are HELD in code, an urgent one goes at once, and the morning tick delivers the rest as one message", async () => {
  let urgent = false;
  const { w, conv, seen, at } = rig(() => ({ message: `news #${seen.recorded.length + 1}`, nextCheckMinutes: 10, urgent }));
  at(NIGHT);
  assert.equal(await w.look(conv, NIGHT), "silent", "held, not posted");
  const t2 = min(NIGHT, 11);
  at(t2);
  assert.equal(await w.look(conv, t2), "silent");
  assert.deepEqual(seen.posted, []);
  const held = ledgerEntries().filter((e) => e.kind === "journal" && e.cat === "notice" && /Held a message for later: news #\d+/.test(e.text) && /quiet hours/.test(e.text));
  assert.ok(held.length >= 2, "the journal says each post was held, with why");
  urgent = true;
  const t3 = min(NIGHT, 22);
  at(t3);
  assert.equal(await w.look(conv, t3), "posted", "urgent: posted at night");
  assert.equal(seen.posted.length, 1);
  assert.deepEqual(readRows().map((r) => [r.night, r.outcome]), [[true, "silent"], [true, "silent"], [true, "posted"]]);
  const morning = new Date(2026, 9, 15, 7, 5, 0);
  at(morning);
  await w.tick(morning); // the tick delivers what was held first (then the look that is due posts its own urgent news)
  assert.equal(seen.posted.length, 3);
  assert.match(seen.posted[1]!, /^A few things I held back:\n- news #\d+\n- news #\d+/);
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

test("groups get the same heartbeat run: one per look, with their own notes, in their own chat; a group with nothing to look at costs nothing; Note to Self never wakes groups", async () => {
  const G = "hb-group-0123456789abcdef";
  const EMPTY = "hb-empty-group-0123456789ab";
  for (const id of [G, EMPTY]) mkdirSync(group(id).notesDir, { recursive: true });
  writeFileSync(join(group(G).notesDir, "scheduling-fact.md"), "Every morning post a fun fact.");
  const { w, seen, at } = rig(() => ({ message: "Fun fact: biscuits." }), { groups: [G, EMPTY] });
  at(DAY);
  await w.tick(DAY);
  await w.idle();
  assert.deepEqual(seen.runs.sort(), ["group", "owner"], "the owner's look and the group's, nothing for the group with no notes and no tools to read");
  assert.deepEqual(seen.posted, ["Fun fact: biscuits.", "Fun fact: biscuits."]);
  const groupPrompt = seen.prompts.find((p) => /do nothing unprompted/.test(p))!;
  assert.match(groupPrompt, /the group's local time/);
  assert.doesNotMatch(groupPrompt, /archive|calendar for the next 36 hours|expert/i, "a group has no mail, calendar or expert in its instruction");
  assert.deepEqual(readRows().map((r) => r.kind).sort(), ["group", "owner"]);
  const nts = rig(() => ({}), { groups: [G] });
  const wakeups = createWakeups({ pipeline: { canSpeak: () => false, busy: () => false, sendWhile: async (_c: unknown, run: () => Promise<unknown>) => run(), enqueue: async (_c: unknown, j: () => Promise<unknown>) => j(), record: () => {}, runTurn: async () => ({ spoke: false }) } as never, groupChats: false, vouch: async () => true, groups: () => [G], run: async (c) => (nts.seen.runs.push(c.kind), { text: "" }), notesChangedAt: () => 0, now: () => DAY, guards: { paused: () => false, budgetSpent: () => false } });
  await wakeups.tick(DAY);
  assert.deepEqual(nts.seen.runs, ["owner"], "groups are not woken on Note to Self");
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

test("looks that fail again and again: ONE owner notice with the cause and the fix, then one 'back to normal'", async () => {
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  try {
    let mode: "boom" | "ok" = "boom";
    const { w, conv, at } = rig(() => (mode === "boom" ? { throws: true } : { message: "[[silent]]" }));
    for (let i = 0; i < 4; i++) {
      const t = min(DAY, i * 35); // (a failed look is retried at the day interval)
      at(t);
      assert.equal(await w.look(conv, t), "failed");
    }
    assert.equal(told.length, 1, "said once, not on every failure");
    assert.match(told[0]!, /failed 3 times in a row/);
    assert.match(told[0]!, /npm run doctor/);
    mode = "ok";
    const t = min(DAY, 140);
    at(t);
    assert.equal(await w.look(conv, t), "silent");
    assert.deepEqual(told.slice(1), ["My background checks work again."]);
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
