import { test } from "node:test";
import assert from "node:assert/strict";
import { told } from "./told.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reminders on time (src/tasks/remind.ts, src/heartbeat/remindtick.ts, src/heartbeat/look.ts): code decides WHEN (the planner, at most once, quiet hours, urgent, repeats, snooze), the conversation's
// look SAYS it in its own words (a fact in its prompt), and only a reminder that was told is journaled ("Reminded about ..."). The fixed line is only the fallback when no look says it.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "reminders-test-"));
process.env.TZ = "Europe/Berlin";

const R = await import("../src/tasks/remind.ts");
const T = await import("../src/heartbeat/remindtick.ts");
const S = await import("../src/tasks/store.ts");
const { group } = await import("../src/conversation/conversationmodel.ts");
const { settings } = await import("../src/core/settings.ts");
const { ledgerEntries, recordMessage } = await import("../src/core/messages.ts");
const { peekConvDb } = await import("../src/core/convdb.ts");
const { convPaths } = await import("../src/core/convpaths.ts");
const { statusText } = await import("../src/conversation/ownercommands.ts");

type Conv = ReturnType<typeof group>;
const ZONE = "Europe/Berlin";
const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
const berlin = (date: string, time: string): number => Date.parse(`${date}T${time}:00${date < "2026-10-25" && date > "2026-03-29" ? "+02:00" : "+01:00"}`);
const NOW = berlin("2026-10-22", "12:00"); // Thu, CEST
const MIN = 60_000;
const HOUR = 3_600_000;
let n = 0;
const fresh = (): Conv => group(`rem-conv-${++n}`);
const scope = (key: string, now = NOW): import("../src/tasks/store.ts").Scope => ({ key, zone: ZONE, by: "owner", origin: "owner", source: "chat", now });
let tsClock = 1_000_000;
function rig(o: { failFirst?: number; error?: string } = {}) {
  const sent: string[] = [];
  let fail = o.failFirst ?? 0;
  const pipeline = {
    enqueue: <T,>(_c: unknown, job: () => Promise<T>) => job(),
    runTurn: async (c: { logFile: string }, t: { run: () => Promise<{ text: string }> }) => {
      const text = (await t.run()).text;
      if (fail-- > 0) return { spoke: false, error: new Error(o.error ?? "messenger down") };
      sent.push(text);
      recordMessage("notice", ++tsClock, text, new Date(NOW), c.logFile);
      return { spoke: true };
    },
  } as never;
  return { sent, pipeline };
}
const tick = (r: ReturnType<typeof rig>, conv: Conv, at: number, looks = true) => T.fireReminders(r.pipeline, conv, new Date(at), { looks });
const rows = (conv: Conv, id: number) => peekConvDb(conv.convId)!.all<{ key: string; state: string; late: number; tries: number }>("SELECT key, state, late, tries FROM reminders WHERE item_id = ? ORDER BY seq", id);
const reminded = (conv: Conv) => ledgerEntries(convPaths(conv.convId).messages).filter((e) => e.kind === "journal" && /^Reminded about/.test(e.text)).map((e) => e.text);

test("the tick CLAIMS a due reminder, once, and says nothing: the look is due now; nothing is journaled before it was told", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - HOUR), { title: "Call Sam", remindAt: NOW - 2 * MIN, due: "2026-10-22" }).item;
  const r = rig();
  assert.equal(await tick(r, conv, NOW), 0);
  assert.deepEqual(r.sent, [], "no fixed text: the look says it");
  assert.deepEqual(rows(conv, it.id).map((x) => x.state), ["claimed"]);
  assert.equal(T.remindersWaiting(conv), true, "the look is due at once");
  assert.equal(S.getItem(conv.key, it.id)!.remindAt, undefined, "its reminder moved on (cleared for a one-off)");
  assert.ok(S.eventsOf(conv.key, it.id).some((e) => e.action === "reminded"), "the history row is written at the claim");
  assert.deepEqual(reminded(conv), [], "but no 'Reminded about' in the journal yet");
  await tick(r, conv, NOW + MIN);
  await tick(rig(), conv, NOW + 2 * MIN); // (a restart: the same file)
  assert.equal(rows(conv, it.id).length, 1, "at most once");
  assert.deepEqual(T.waitingReminders(conv).map((w) => w.item.title), ["Call Sam"]);
});

test("a look that posts tells its reminders: sent, journaled ONCE; a look that stays silent covers them (marked, not journaled) and NO fixed line follows; an abandoned look leaves them", async () => {
  const conv = fresh();
  const a = S.addItem(scope(conv.key, NOW - HOUR), { title: "Call Sam", remindAt: NOW - MIN }).item;
  const b = S.addItem(scope(conv.key, NOW - HOUR), { title: "Water plants", remindAt: NOW - MIN }).item;
  const r = rig();
  await tick(r, conv, NOW);
  const handed = T.waitingReminders(conv);
  T.afterLook(conv, handed.filter((w) => w.item.id === a.id), { posted: true, held: false }, NOW + MIN, ZONE);
  T.afterLook(conv, handed.filter((w) => w.item.id === b.id), { posted: false, held: false }, NOW + MIN, ZONE);
  assert.deepEqual(rows(conv, a.id).map((x) => x.state), ["sent"]);
  assert.deepEqual(rows(conv, b.id).map((x) => x.state), ["folded"]);
  assert.deepEqual(reminded(conv), ["Reminded about task #1 'Call Sam'. Why: its reminder time came."]);
  assert.equal(T.remindersWaiting(conv), false, "the silent look's reminder starts no new look");
  assert.equal(await tick(r, conv, NOW + 31 * MIN), 0, "the model is fine: no code text, ever");
  assert.deepEqual(r.sent, []);
});

test("the trigger line names the event: an own reminder, a snooze end", () => {
  const conv = fresh();
  const a = S.addItem(scope(conv.key, NOW - HOUR), { title: "Call Sam", remindAt: NOW }).item;
  const w = [{ item: a, key: `at:${NOW}`, fireAt: NOW }, { item: { ...a, title: "Nap" }, key: `snooze:${NOW}`, fireAt: NOW }];
  assert.deepEqual(R.reminderWhy(w, { now: NOW, zone: ZONE }).map((x) => x.replace(/ (at|Thu) .*/, "")), ["Triggered: your task 'Call Sam' has its reminder", "Triggered: your task 'Nap' was snoozed until"]);
  assert.match(R.reminderWhy(w, { now: NOW, zone: ZONE })[0]!, /has its reminder at .*12:00\./);
});

test("fixed text only when no model run is possible: no look (looks false) sends the line at once; a look that can run waits", async () => {
  const conv = fresh();
  S.addItem(scope(conv.key, NOW - HOUR), { title: "Call Sam", remindAt: NOW - MIN });
  const r = rig();
  assert.equal(await tick(r, conv, NOW, true), 0);
  assert.deepEqual(r.sent, [], "a look can run: it decides");
  assert.equal(await tick(r, conv, NOW + MIN, false), 1, "the model became unavailable: the claimed reminder gets the fixed line");
  assert.deepEqual(r.sent, ["⏰ Call Sam"]);
});

test("a send that fails is never journaled as 'Reminded': it is retried, three times at most, then left to the brief", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - HOUR), { title: "Never", remindAt: NOW - 2 * MIN }).item;
  const bad = rig({ failFirst: 99 });
  for (let i = 0; i < 6; i++) await tick(bad, conv, NOW + i * 5 * MIN, false); // (no look: the fallback at once)
  assert.equal(bad.sent.length, 0);
  assert.deepEqual(reminded(conv), [], "no false 'Reminded' line for a send that timed out");
  assert.deepEqual(rows(conv, it.id).map((x) => [x.state, x.tries]), [["folded", 3]]);
  const ok = fresh();
  S.addItem(scope(ok.key, NOW - HOUR), { title: "Once", remindAt: NOW - 2 * MIN });
  const flaky = rig({ failFirst: 1 });
  await tick(flaky, ok, NOW, false);
  await tick(flaky, ok, NOW + 5 * MIN, false);
  assert.deepEqual(flaky.sent, ["⏰ Once"]);
  assert.equal(reminded(ok).length, 1, "journaled once, after the send that worked");
});

test("a fallback reminder whose send outcome is unsure counts as told and is not sent again; one that surely failed is retried", async () => {
  const unsure = fresh();
  const a = S.addItem(scope(unsure.key, NOW - HOUR), { title: "Maybe", remindAt: NOW - 2 * MIN }).item;
  const timeout = rig({ failFirst: 99, error: "signal send timed out after 120s" });
  for (let i = 0; i < 3; i++) await tick(timeout, unsure, NOW + i * 5 * MIN, false);
  assert.equal(reminded(unsure).length, 1, "told once, not tried again");
  assert.deepEqual(rows(unsure, a.id).map((x) => x.tries), [0], "never retried");
  const refused = fresh();
  const b = S.addItem(scope(refused.key, NOW - HOUR), { title: "Surely", remindAt: NOW - 2 * MIN }).item;
  const down = rig({ failFirst: 1, error: "SignalClient is not connected" });
  await tick(down, refused, NOW, false);
  assert.deepEqual(rows(refused, b.id).map((x) => x.state), ["retry"]);
  await tick(down, refused, NOW + 5 * MIN, false);
  assert.deepEqual(down.sent, ["⏰ Surely"]);
});

test("a held look post tells its reminders (they go out with the held messages)", async () => {
  const conv = { ...fresh(), kind: "owner" as const };
  const plain = S.addItem(scope(conv.key, NOW - HOUR), { title: "Plain", remindAt: NOW - MIN }).item;
  const urgent = S.addItem(scope(conv.key, NOW - HOUR), { title: "Urgent", remindAt: NOW - MIN, urgent: true }).item;
  await tick(rig(), conv as never, NOW);
  T.afterLook(conv, T.waitingReminders(conv), { posted: false, held: true }, NOW + MIN, ZONE);
  assert.equal(rows(conv as never, plain.id)[0]!.state, "sent");
  assert.equal(rows(conv as never, urgent.id)[0]!.state, "sent");
});

test("quiet hours hold a reminder until they end (then it is claimed for the look); an urgent one is claimed at once", async () => {
  const conv = fresh();
  const night = berlin("2026-10-22", "23:30");
  const it = S.addItem(scope(conv.key, NOW), { title: "Late call", remindAt: berlin("2026-10-22", "23:00") }).item;
  const u = S.addItem({ ...scope(conv.key, NOW), origin: "owner" }, { title: "Wake me", remindAt: berlin("2026-10-22", "23:10"), urgent: true }).item;
  const r = rig();
  await tick(r, conv, night, false);
  assert.equal(rows(conv, it.id)[0]!.state, "held");
  assert.deepEqual(r.sent, ["⏰ Wake me"], "urgent, no look: the fallback even at night");
  await tick(r, conv, berlin("2026-10-23", "07:05"), true);
  assert.equal(rows(conv, it.id)[0]!.state, "claimed", "quiet is over: the look says it");
  assert.equal(rows(conv, u.id)[0]!.state, "sent");
});

test("the facts a look gets: the reminders due now, with when they were due, and the open items due by tomorrow or overdue", () => {
  const conv = fresh();
  const a = S.addItem(scope(conv.key), { title: "Call Sam", due: "2026-10-22T14:30", assignee: "Mara" }).item;
  const b = S.addItem(scope(conv.key), { title: "Pay rent", due: "2026-10-20" }).item;
  const c = S.addItem(scope(conv.key), { title: "Dentist", due: "2026-10-23" }).item;
  S.addItem(scope(conv.key), { title: "Far away", due: "2026-11-30" });
  const text = R.reminderFacts([{ item: a, fireAt: NOW - 3 * HOUR }], S.activeItems(conv.key), { now: NOW, zone: ZONE, group: true });
  assert.match(text, /^Reminders that came due \(do what you can of the task yourself first and say what is left; for what you cannot do, a plain short reminder in your own words naming who it is for;/);
  assert.match(text, new RegExp(`#${a.id} Call Sam \\(reminder for Thu 22 Oct 09:00; for Mara; due today 14:30\\)`));
  assert.match(text, /Open items due by tomorrow or overdue \(for your awareness/);
  assert.match(text, new RegExp(`#${b.id} Pay rent \\(was due Tue 20 Oct\\)`));
  assert.match(text, new RegExp(`#${c.id} Dentist \\(due tomorrow\\)`));
  assert.doesNotMatch(text, /Far away/);
  assert.equal(R.reminderFacts([], [], { now: NOW, zone: ZONE, group: false }), "");
});

test("the look: a due reminder makes it run now; its prompt carries the reminder as a fact; it is journaled only because the look posted", async () => {
  const { createHeartbeatLook } = await import("../src/heartbeat/look.ts");
  const { owner } = await import("../src/conversation/conversation.ts");
  const { LOGIN } = await import("../src/tenants/payer.ts");
  const { lookState } = await import("../src/conversation/ledger.ts");
  const { scratchLog } = await import("./scratch.ts");
  const c = { ...owner(), logFile: scratchLog(`rem-look-${Math.random().toString(36).slice(2)}.jsonl`) };
  const it = S.addItem(scope(c.key, NOW - HOUR), { title: "Ring the vet", remindAt: NOW - MIN }).item;
  await T.fireReminders(rig().pipeline, c as never, new Date(NOW), { looks: true });
  const prompts: string[] = [];
  const posted: string[] = [];
  const pipeline = { enqueue: <X>(_c: unknown, job: () => Promise<X>) => job(), record: () => {}, busy: () => false, sendWhile: async (_c: unknown, r: () => Promise<unknown>) => r(), runTurn: async (_c: unknown, turn: { run: () => Promise<{ text: string }> }) => (posted.push((await turn.run()).text), { spoke: true }) };
  const hb = createHeartbeatLook({
    pipeline: pipeline as never,
    run: (async (_c: unknown, _p: unknown, build: (s?: string) => { prompt: string }, extra: { facts?: { status: string[]; blocks: string[] } }) => (prompts.push(told(build, extra)), { text: "", structured: { message: "Hey, you wanted a nudge to ring the vet now.", nextCheckMinutes: 30 } })) as never,
    may: () => LOGIN,
    why: () => "x",
    notesChangedAt: () => 0,
  });
  const st = { ...lookState([]), wake: { looked: new Date(NOW).toISOString(), next: new Date(NOW + HOUR).toISOString() } } as never; // (not due by its clock: only the reminder makes it due)
  const outcome = await hb.look(c, st, new Date(NOW));
  assert.equal(outcome, "posted");
  assert.match(prompts[0] ?? "", /Reminders that came due[\s\S]*Ring the vet/);
  assert.match(prompts[0] ?? "", /Triggered: your task 'Ring the vet' has its reminder at/, "the trigger line carries the reason");
  assert.doesNotMatch(prompts[0] ?? "", /⏰/, "a fact for the model, not the code's line");
  assert.equal(ledgerEntries(convPaths(c.convId).messages).filter((e) => e.kind === "journal" && e.text.startsWith(`Reminded about task #${it.id} 'Ring the vet'`)).length, 1);
});

test("a repeating reminder is claimed, moves to its next time and stays ONE item; a snooze that ran out wakes the item; a due day that is over rolls", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - 24 * HOUR), { title: "Stretch", remindAt: NOW - MIN, repeat: "every day" }).item;
  const nap = S.addItem(scope(conv.key, NOW - 5 * HOUR), { title: "Nap" }).item;
  S.snoozeItem(scope(conv.key, NOW - 4 * HOUR), nap.id, NOW - 2 * MIN);
  const trash = S.addItem(scope(conv.key, NOW - 24 * HOUR), { title: "Trash", due: "2026-10-21", repeat: "every day" }).item;
  await tick(rig(), conv, NOW);
  assert.equal(S.getItem(conv.key, it.id)!.remindAt, berlin("2026-10-23", "11:59"), "tomorrow at the same clock time");
  assert.equal(S.getItem(conv.key, nap.id)!.status, "open");
  assert.deepEqual(T.waitingReminders(conv).map((w) => w.item.title).sort(), ["Nap", "Stretch"]);
  assert.equal(S.getItem(conv.key, trash.id)!.due, "2026-10-23");
  assert.equal(S.listItems(conv.key, { status: ["open", "snoozed", "done", "dropped"] }).length, 3);
});

test("a task with only a due date is never pinged by code (the brief and the look tell it); an own reminder is one row; two days late is only marked; a conversation without a database is left alone", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: "Pay rent", due: "2026-10-22", remindAt: berlin("2026-10-22", "07:05") }).item;
  await tick(rig(), conv, berlin("2026-10-22", "07:10"));
  await tick(rig(), conv, berlin("2026-10-22", "08:35"));
  assert.deepEqual(rows(conv, it.id).map((x) => x.key), [`at:${berlin("2026-10-22", "07:05")}`], "no second one at 08:30: a due date alone sends nothing");
  const old = S.addItem(scope(conv.key, NOW - 72 * HOUR), { title: "Ancient", remindAt: NOW - 50 * HOUR }).item;
  await tick(rig(), conv, NOW);
  assert.deepEqual(rows(conv, old.id).map((x) => x.state), ["folded"]);
  const empty = group("rem-never-opened");
  assert.equal(await tick(rig(), empty, NOW), 0);
  assert.equal(peekConvDb(empty.convId), undefined, "no database was made");
});

test("stale held rows are pruned when the item is done or moved on", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - HOUR), { title: "Water plants", remindAt: berlin("2026-10-22", "23:00") }).item;
  const r = rig();
  await tick(r, conv, berlin("2026-10-22", "23:30"));
  assert.equal(rows(conv, it.id)[0]!.state, "held");
  S.completeItem(scope(conv.key, berlin("2026-10-22", "23:40")), it.id);
  await tick(r, conv, berlin("2026-10-23", "07:30"));
  assert.deepEqual(rows(conv, it.id), []);
});

test("planner: an item's own reminder, a snooze that ran out", () => {
  const conv = fresh();
  const a = S.addItem(scope(conv.key, NOW - 5 * HOUR), { title: "Call Sam", remindAt: NOW - MIN }).item;
  const b = S.addItem(scope(conv.key, NOW - 5 * HOUR), { title: "Later one", remindAt: NOW + HOUR }).item;
  const c = S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: "Pay rent", due: "2026-10-22" }).item;
  const d = S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: "Next week", due: "2026-10-29" }).item;
  const e = S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: "Nap" }).item;
  S.snoozeItem(scope(conv.key, NOW - 3 * HOUR), e.id, NOW - HOUR);
  const o = { zone: ZONE };
  const plan = R.dueReminders(S.activeItems(conv.key), NOW, o);
  assert.deepEqual(plan.map((p) => [p.item.id, p.kind, p.key]), [
    [e.id, "snooze", `snooze:${NOW - HOUR}`],
    [a.id, "at", `at:${NOW - MIN}`],
  ]);
  assert.ok(![b.id, c.id, d.id].some((id) => plan.some((p) => p.item.id === id)), "nothing in the future, and a due date alone plans nothing");
  const done = new Set([`${a.id}|at:${NOW - MIN}`]);
  assert.equal(R.dueReminders(S.activeItems(conv.key), NOW, { ...o, done }).some((p) => p.item.id === a.id), false, "a claimed reminder is not planned again");
});

test("planner: the default ping is at the default time, or the due time when that is earlier; DST days are right; an item touched after that morning gets none", () => {

  const conv = fresh();
  const daily = S.addItem(scope(conv.key), { title: "Stretch", remindAt: berlin("2026-10-22", "11:00"), repeat: "every day" }).item;
  assert.equal(R.remindAtAfter(daily, NOW, ZONE), berlin("2026-10-23", "11:00"), "the same clock time tomorrow");
  const weekly = S.addItem(scope(conv.key), { title: "Trash", due: "2026-10-22", remindAt: berlin("2026-10-21", "18:00"), repeat: "every thursday" }).item;
  assert.equal(R.remindAtAfter(weekly, NOW, ZONE), berlin("2026-10-28", "18:00"), "the reminder keeps its distance from the due (the day before)");
  const once = S.addItem(scope(conv.key), { title: "Once", remindAt: NOW - MIN }).item;
  assert.equal(R.remindAtAfter(once, NOW, ZONE), null);
  const rule = S.addItem(scope(conv.key), { title: "Rent", due: "2026-10-20", repeat: "every month on the 20th" }).item;
  assert.deepEqual(R.rolledDue(rule, NOW, ZONE), { due: "2026-11-20" });
  assert.equal(R.rolledDue({ ...rule, due: "2026-10-22" }, NOW, ZONE), undefined, "the due day is not over");
  assert.equal(R.rolledDue({ ...rule, repeat: undefined }, NOW, ZONE), undefined, "a one-off stays overdue (the brief lists it)");
});

test("a background look cannot make an item urgent", () => {
  const conv = fresh();
  const it = S.addItem({ ...scope(conv.key), unattended: true, by: "assistant (look)" }, { title: "Suggested", urgent: true }).item;
  assert.equal(it.urgent, undefined);
});

test("/status says when the next reminder goes", () => {
  const conv = fresh();
  assert.equal(R.nextReminderText(conv.key, conv.convId, NOW, ZONE), undefined, "no database");
  const it = S.addItem(scope(conv.key), { title: "Call Sam", remindAt: berlin("2026-10-23", "09:00") }).item;
  assert.equal(R.nextReminderText(conv.key, conv.convId, NOW, ZONE), `Fri 23 Oct 09:00 (#${it.id} Call Sam)`);
  const base = { spentUsd: 0, limitUsd: 5, approvals: 0, down: [] };
  assert.match(statusText({ ...base, nextReminder: "Fri 23 Oct 09:00 (#1 Call Sam)" }), /Next reminder: Fri 23 Oct 09:00 \(#1 Call Sam\)\./);
  assert.match(statusText({ ...base, nextReminder: "" }), /Next reminder: none\./);
});

test("only the person whose chat it is can make an item urgent: not a group member, not a background look", () => {
  const conv = fresh();
  const member = { ...scope(conv.key), origin: "member" as const, by: "Mia" };
  assert.equal(S.addItem(member, { title: "m", urgent: true }).item.urgent, undefined);
  const mine = S.addItem(scope(conv.key), { title: "o", urgent: true }).item;
  assert.equal(mine.urgent, true);
  assert.equal(S.addItem({ ...scope(conv.key), origin: "friend" as const }, { title: "f", urgent: true }).item.urgent, true);
  const other = S.addItem(scope(conv.key), { title: "plain" }).item;
  assert.equal(S.editItem(member, other.id, { urgent: true, details: "x" }).item.urgent, undefined, "a member's edit ignores it");
  assert.equal(S.editItem(scope(conv.key), other.id, { urgent: true }).item.urgent, true);
});

test("the task tool says urgent was ignored in a group", async () => {
  const { createTasksServer } = await import("../src/modules/tasks/tasktools.ts");
  const conv = fresh();
  const tools = (createTasksServer({ key: conv.key, source: "group", unattended: false, zone: () => ZONE, now: () => NOW }) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }> } }).instance._registeredTools;
  const r = await tools.add_task!.handler({ title: "Book ferry", urgent: true });
  assert.match(r.content[0]!.text, /urgent was ignored/);
  assert.equal(S.listItems(conv.key, {})[0]!.urgent, undefined);
});

