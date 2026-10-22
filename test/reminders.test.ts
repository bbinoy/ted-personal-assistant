import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reminders on time (src/tasks/remind.ts, remindanswer.ts): the planner, the words, the tick (at most once, quiet hours, urgent, not counted toward the cap, groups, catch-up, repeats, snooze) and
// answering a reminder in code (a quoted "done" / "snooze 1h", a ✅ reaction), also after a restart.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "reminders-test-"));
process.env.TZ = "Europe/Berlin";

const R = await import("../src/tasks/remind.ts");
const A = await import("../src/tasks/remindanswer.ts");
const T = await import("../src/heartbeat/remindtick.ts");
const { zoneOf } = await import("../src/tenants/tenants.ts");
const S = await import("../src/tasks/store.ts");
const { group } = await import("../src/conversation/conversationmodel.ts");
const { settings } = await import("../src/core/settings.ts");
const { heldPosts, submitPost } = await import("../src/heartbeat/notices.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { peekConvDb } = await import("../src/core/convdb.ts");
const { setQuiet } = await import("../src/conversation/quiet.ts");
const { statusText } = await import("../src/conversation/ownercommands.ts");

type Conv = ReturnType<typeof group>;
type Item = import("../src/tasks/store.ts").Item;
const ZONE = "Europe/Berlin";
const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
s.maxUnpromptedPerDay = 3;
s.taskDefaultRemind = "08:30";
const berlin = (date: string, time: string): number => Date.parse(`${date}T${time}:00${date < "2026-10-25" && date > "2026-03-29" ? "+02:00" : "+01:00"}`);
const NOW = berlin("2026-10-22", "12:00"); // Thu, CEST
const MIN = 60_000;
const HOUR = 3_600_000;
let n = 0;
const fresh = (): Conv => group(`rem-conv-${++n}`);
const scope = (key: string, now = NOW): import("../src/tasks/store.ts").Scope => ({ key, zone: ZONE, by: "owner", origin: "owner", source: "chat", now });
let tsClock = 1_000_000;
function rig(o: { failFirst?: number } = {}) {
  const sent: string[] = [];
  let fail = o.failFirst ?? 0;
  const pipeline = {
    enqueue: <T,>(_c: unknown, job: () => Promise<T>) => job(),
    runTurn: async (c: { logFile: string }, t: { run: () => Promise<{ text: string }> }) => {
      const text = (await t.run()).text;
      if (fail-- > 0) return { spoke: false, error: new Error("messenger down") };
      sent.push(text);
      recordMessage("notice", ++tsClock, text, new Date(NOW), c.logFile);
      return { spoke: true };
    },
  } as never;
  return { sent, pipeline };
}
const tick = (r: ReturnType<typeof rig>, conv: Conv, at: number) => T.fireReminders(r.pipeline, conv, new Date(at));
const rows = (conv: Conv, id: number) => peekConvDb(conv.convId)!.all<{ key: string; state: string; ts: number | null; late: number }>("SELECT key, state, ts, late FROM reminders WHERE item_id = ? ORDER BY seq", id);

test("planner: an item's own reminder, a snooze that ran out, and the default morning ping", () => {
  const conv = fresh();
  const a = S.addItem(scope(conv.key, NOW - 5 * HOUR), { title: "Call Sam", remindAt: NOW - MIN }).item;
  const b = S.addItem(scope(conv.key, NOW - 5 * HOUR), { title: "Later one", remindAt: NOW + HOUR }).item;
  const c = S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: "Pay rent", due: "2026-10-22" }).item;
  const d = S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: "Next week", due: "2026-10-29" }).item;
  const e = S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: "Nap" }).item;
  S.snoozeItem(scope(conv.key, NOW - 3 * HOUR), e.id, NOW - HOUR);
  const o = { zone: ZONE, defaultTime: "08:30" };
  const plan = R.dueReminders(S.activeItems(conv.key), NOW, o);
  assert.deepEqual(plan.map((p) => [p.item.id, p.kind, p.key]), [
    [c.id, "default", "due:2026-10-22"],
    [e.id, "snooze", `snooze:${NOW - HOUR}`],
    [a.id, "at", `at:${NOW - MIN}`],
  ]);
  assert.equal(plan[0]!.fireAt, berlin("2026-10-22", "08:30"));
  assert.ok(![b.id, d.id].some((id) => plan.some((p) => p.item.id === id)), "nothing in the future");
  const done = new Set([`${a.id}|at:${NOW - MIN}`]);
  assert.equal(R.dueReminders(S.activeItems(conv.key), NOW, { ...o, done }).some((p) => p.item.id === a.id), false, "a claimed reminder is not planned again");
  assert.deepEqual(R.dueReminders(S.activeItems(conv.key), NOW, { ...o, defaultTime: "off" }).map((p) => p.item.id), [e.id, a.id], "default pings can be switched off");
});

test("planner: the default ping is at the default time, or the due time when that is earlier; DST days are right; an item touched after that morning gets none", () => {
  const mk = (due: string, created: number): Item => S.addItem(scope(fresh().key, created), { title: "x", due }).item;
  const o = { zone: ZONE, defaultTime: "08:30" };
  assert.equal(R.defaultFireAt(mk("2026-10-24", NOW), o), Date.parse("2026-10-24T06:30:00Z"), "CEST");
  assert.equal(R.defaultFireAt(mk("2026-10-24T07:15", NOW), o), Date.parse("2026-10-24T05:15:00Z"), "a due before 08:30 pings at the due time");
  assert.equal(R.defaultFireAt(mk("2026-10-25", NOW), o), Date.parse("2026-10-25T07:30:00Z"), "the day the clocks go back: 08:30 is CET");
  assert.equal(R.defaultFireAt(mk("2026-03-29", NOW), o), Date.parse("2026-03-29T06:30:00Z"), "the day they go forward: 08:30 is CEST");
  assert.equal(R.defaultFireAt(S.addItem(scope(fresh().key), { title: "r", due: "2026-10-24", remindAt: NOW + HOUR }).item, o), undefined, "an own reminder replaces the default");
  const late = S.addItem(scope(fresh().key, berlin("2026-10-22", "10:00")), { title: "made today", due: "2026-10-22" }).item;
  assert.deepEqual(R.dueReminders([late], NOW, o), [], "made after 08:30 that day: no 'missed' ping for something just written");
});

test("judgeLate: on time, missed while off, folded into the digest, dropped; quiet hours excuse the delay", () => {
  const f = 1_000_000_000_000;
  assert.equal(R.judgeLate(f, f + 4 * MIN, false, 10 * MIN), "ok");
  assert.equal(R.judgeLate(f, f + 3 * HOUR, false, 10 * MIN), "missed");
  assert.equal(R.judgeLate(f, f + 8 * HOUR, true, 10 * MIN), "ok");
  assert.equal(R.judgeLate(f, f + 13 * HOUR, true, 10 * MIN), "fold");
  assert.equal(R.judgeLate(f, f + 49 * HOUR, false, 10 * MIN), "drop");
});

test("the words: one short line, the due in the conversation's clock, the assignee in a group", () => {
  const it = (p: Partial<Item>): Item => ({ id: 1, kind: "task", title: "Call Sam", status: "open", origin: "owner", sourceKind: "message", createdAt: 0, updatedAt: 0, ...p });
  const o = { now: NOW, zone: ZONE, group: false };
  assert.equal(R.reminderText(it({ due: "2026-10-22" }), o), "⏰ Call Sam (due today)");
  assert.equal(R.reminderText(it({ due: "2026-10-23T14:30" }), o), "⏰ Call Sam (due tomorrow 14:30)");
  assert.equal(R.reminderText(it({ due: "2026-10-30" }), o), "⏰ Call Sam (due Fri 30 Oct)");
  assert.equal(R.reminderText(it({ due: "2026-10-20" }), o), "⏰ Call Sam (was due Tue 20 Oct)");
  assert.equal(R.reminderText(it({}), o), "⏰ Call Sam");
  assert.equal(R.reminderText(it({ title: "ferry tickets", assignee: "Anna", due: "2026-10-22" }), { ...o, group: true }), "⏰ @Anna: ferry tickets (due today)");
  assert.equal(R.reminderText(it({ assignee: "Anna" }), o), "⏰ Call Sam", "a private chat does not name an assignee");
  assert.equal(R.reminderText(it({}), { ...o, missed: true }), "⏰ Call Sam (missed while I was off)");
});

test("repeats: the reminder moves to the next occurrence, one item, nothing piles up; a day that is over rolls the due", () => {
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

test("the tick: a reminder goes out once, however many ticks or restarts (at most once), and the item's reminder is cleared", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - HOUR), { title: "Call Sam", remindAt: NOW - 2 * MIN, due: "2026-10-22" }).item;
  const r = rig();
  assert.equal(await tick(r, conv, NOW), 1);
  assert.deepEqual(r.sent, ["⏰ Call Sam (due today)"]);
  assert.equal(await tick(r, conv, NOW + MIN), 0);
  assert.equal(await tick(rig(), conv, NOW + 2 * MIN), 0, "a restart (a new process, the same file) does not send it again");
  assert.equal(S.getItem(conv.key, it.id)!.remindAt, undefined);
  assert.deepEqual(rows(conv, it.id).map((x) => [x.state, x.late]), [["sent", 0]]);
  assert.ok(rows(conv, it.id)[0]!.ts, "the message's timestamp is kept for a quote to find");
  assert.ok(S.eventsOf(conv.key, it.id).some((e) => e.action === "reminded"), "the history says it");
  assert.equal(S.getItem(conv.key, it.id)!.status, "open", "an ignored reminder stays open: no loop");
});

test("the tick: a send that fails outright is given back and tried again, three times at most", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - HOUR), { title: "Call Sam", remindAt: NOW - 2 * MIN }).item;
  const r = rig({ failFirst: 1 });
  assert.equal(await tick(r, conv, NOW), 0);
  assert.equal(S.getItem(conv.key, it.id)!.remindAt, NOW - 2 * MIN, "given back");
  assert.equal(await tick(r, conv, NOW + 5 * MIN), 1);
  assert.deepEqual(r.sent, ["⏰ Call Sam"], "a retry after a failed send is not 'missed'");
  const bad = rig({ failFirst: 99 });
  const it2 = S.addItem(scope(conv.key, NOW - HOUR), { title: "Never", remindAt: NOW - 2 * MIN }).item;
  for (let i = 0; i < 6; i++) await tick(bad, conv, NOW + i * 5 * MIN);
  assert.equal(rows(conv, it2.id).length, 1);
  assert.equal(bad.sent.length, 0);
  assert.equal(peekConvDb(conv.convId)!.num("SELECT tries FROM reminders WHERE item_id = ?", it2.id), 3, "given up after three tries");
});

test("quiet hours hold a reminder (plain when it goes), urgent ones bypass; none counts toward the day's cap or enters the digest", async () => {
  const conv = fresh();
  const night = berlin("2026-10-22", "23:15");
  const morning = berlin("2026-10-23", "07:05");
  const a = S.addItem(scope(conv.key, NOW), { title: "Water plants", remindAt: berlin("2026-10-22", "23:00") }).item;
  const u = S.addItem(scope(conv.key, NOW), { title: "Take pills", remindAt: berlin("2026-10-22", "23:10"), urgent: true }).item;
  assert.equal(u.urgent, true);
  const r = rig();
  assert.equal(await tick(r, conv, night), 1);
  assert.deepEqual(r.sent, ["⏰ Take pills"], "urgent goes at night, the other waits");
  assert.equal(rows(conv, a.id)[0]!.state, "held");
  assert.equal(await tick(r, conv, morning), 1);
  assert.deepEqual(r.sent, ["⏰ Take pills", "⏰ Water plants"], "plain after the quiet window: the delay was the quiet hours, not 'missed'");
  assert.deepEqual(heldPosts(conv), [], "never merged into the digest");
  const day = berlin("2026-10-24", "10:00");
  for (const t of ["p1", "p2", "p3"]) submitPost(conv, t, false, new Date(day));
  assert.equal(submitPost(conv, "p4", false, new Date(day)), "held", "the cap is spent");
  S.addItem(scope(conv.key, day - HOUR), { title: "Still goes", remindAt: day - MIN });
  const held = heldPosts(conv).length;
  assert.equal(await tick(r, conv, day), 1);
  assert.equal(r.sent.at(-1), "⏰ Still goes");
  assert.equal(heldPosts(conv).length, held);
  assert.equal(peekConvDb(conv.convId)!.num("SELECT posted FROM hold WHERE id = 1"), 3, "a reminder is not counted as an unprompted post");
});

test("a background look cannot make an item urgent", () => {
  const conv = fresh();
  const it = S.addItem({ ...scope(conv.key), origin: "inferred", by: "assistant (inferred)" }, { title: "Suggested", urgent: true }).item;
  assert.equal(it.urgent, undefined);
});

test("/quiet holds a reminder too, until it is lifted", async () => {
  const conv = fresh();
  S.addItem(scope(conv.key, NOW - HOUR), { title: "Call Sam", remindAt: NOW - MIN });
  setQuiet(conv, new Date(NOW + 2 * HOUR).toISOString());
  const r = rig();
  assert.equal(await tick(r, conv, NOW), 0);
  assert.equal(await tick(r, conv, NOW + 3 * HOUR), 1);
  assert.deepEqual(r.sent, ["⏰ Call Sam"]);
});

test("in a group the reminder names the assignee", async () => {
  const conv = fresh();
  S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: "ferry tickets", due: "2026-10-22", assignee: "Anna" });
  const r = rig();
  await tick(r, conv, berlin("2026-10-22", "08:35"));
  assert.deepEqual(r.sent, ["⏰ @Anna: ferry tickets (due today)"]);
  await tick(r, conv, berlin("2026-10-22", "09:35"));
  assert.equal(r.sent.length, 1, "once per item per due date");
});

test("catch-up: a little late is plain, hours late says it was missed, up to 48 hours becomes a digest line, older is only marked", async () => {
  const conv = fresh();
  const mk = (title: string, ago: number) => S.addItem(scope(conv.key, NOW - 100 * HOUR), { title, remindAt: NOW - ago }).item;
  const plain = mk("plain", 4 * MIN);
  const missed = mk("missed", 5 * HOUR);
  const folded = mk("folded", 20 * HOUR);
  const old = mk("old", 60 * HOUR);
  const r = rig();
  assert.equal(await tick(r, conv, NOW), 2);
  assert.deepEqual([...r.sent].sort(), ["⏰ missed (missed while I was off)", "⏰ plain"]);
  assert.deepEqual(rows(conv, missed.id).map((x) => x.late), [1]);
  assert.deepEqual(rows(conv, plain.id).map((x) => x.late), [0]);
  assert.deepEqual(heldPosts(conv).map((h) => h.text.startsWith("⏰ folded")), [true], "folded into the next digest");
  assert.equal(rows(conv, old.id)[0]!.state, "folded");
  assert.equal(S.getItem(conv.key, old.id)!.remindAt, undefined);
  assert.equal(S.getItem(conv.key, folded.id)!.status, "open", "still on the list for the brief");
});

test("a repeating reminder fires, moves to its next time and stays ONE item", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - 24 * HOUR), { title: "Stretch", remindAt: NOW - MIN, repeat: "every day" }).item;
  const r = rig();
  await tick(r, conv, NOW);
  assert.equal(r.sent.length, 1);
  assert.equal(S.getItem(conv.key, it.id)!.remindAt, berlin("2026-10-23", "11:59"), "tomorrow at the same clock time");
  assert.equal(S.listItems(conv.key, { status: ["open", "snoozed", "done", "dropped"] }).length, 1);
  await tick(r, conv, NOW + 2 * MIN);
  assert.equal(r.sent.length, 1);
});

test("a repeating item whose due day is over rolls to the next due, no copies", async () => {
  const conv = fresh();
  const it = S.addItem(scope(conv.key, NOW - 24 * HOUR), { title: "Trash", due: "2026-10-21", repeat: "every day" }).item;
  await tick(rig(), conv, NOW);
  assert.equal(S.getItem(conv.key, it.id)!.due, "2026-10-23");
  assert.equal(S.listItems(conv.key, {}).length, 1);
});

test("a snooze that ran out wakes the item and reminds; one still running does not", async () => {
  const conv = fresh();
  const a = S.addItem(scope(conv.key, NOW - 5 * HOUR), { title: "Nap" }).item;
  const b = S.addItem(scope(conv.key, NOW - 5 * HOUR), { title: "Sleep on" }).item;
  S.snoozeItem(scope(conv.key, NOW - 4 * HOUR), a.id, NOW - 2 * MIN);
  S.snoozeItem(scope(conv.key, NOW - 4 * HOUR), b.id, NOW + HOUR);
  const r = rig();
  await tick(r, conv, NOW);
  assert.deepEqual(r.sent, ["⏰ Nap"]);
  assert.equal(S.getItem(conv.key, a.id)!.status, "open");
  assert.equal(S.getItem(conv.key, b.id)!.status, "snoozed");
});

test("several default pings in one tick are one message; a conversation without a database is left alone", async () => {
  const conv = fresh();
  for (const t of ["a", "b", "c", "d"]) S.addItem(scope(conv.key, NOW - 48 * HOUR), { title: t, due: "2026-10-22" });
  const r = rig();
  await tick(r, conv, berlin("2026-10-22", "08:35"));
  assert.deepEqual(r.sent, ["⏰ Due today: a; b; c; d"]);
  const empty = group("rem-never-opened");
  assert.equal(await tick(r, empty, NOW), 0);
  assert.equal(peekConvDb(empty.convId), undefined, "no database was made");
});

test("answers in code: a quoted done, snooze, later; a reaction; nothing else; after a restart", async () => {
  const conv = fresh();
  const make = (title: string, extra: Record<string, unknown> = {}) => S.addItem(scope(conv.key, NOW - HOUR), { title, remindAt: NOW - MIN, ...extra }).item;
  const a = make("Call Sam");
  const b = make("Pay rent");
  const c = make("Water plants");
  const d = make("Trash", { repeat: "every day" });
  await tick(rig(), conv, NOW);
  const ts = (id: number) => rows(conv, id)[0]!.ts!;
  const said: string[] = [];
  const mkAnswers = () => A.createReminderAnswers({ zone: zoneOf, out: { reply: async (t) => (said.push(t), 1) }, now: () => NOW });
  const msg = (text: string, quote: number) => ({ text, from: "x", quote: { timestamp: quote, author: "x", text: "" } }) as never;
  let answers = mkAnswers(); // (a new instance: the mapping is in the database, not in memory)
  assert.equal(await answers.message(conv, msg("Done!", ts(a.id))), true);
  assert.equal(S.getItem(conv.key, a.id)!.status, "done");
  assert.equal(await answers.message(conv, msg("snooze 1h", ts(b.id))), true);
  assert.deepEqual([S.getItem(conv.key, b.id)!.status, S.getItem(conv.key, b.id)!.snoozeUntil], ["snoozed", NOW + HOUR]);
  assert.equal(await mkAnswers().message(conv, msg("later", ts(c.id))), true);
  assert.equal(S.getItem(conv.key, c.id)!.snoozeUntil, NOW + HOUR, "later is one hour");
  assert.equal(await answers.reaction(conv, { emoji: "✅", targetTimestamp: ts(d.id), isRemove: false, from: "x" }), true);
  assert.equal(S.getItem(conv.key, d.id)!.status, "open", "a repeating item moves on instead");
  assert.equal(await answers.message(conv, msg("done", ts(a.id))), true, "an item that is already done is said so");
  assert.match(said.at(-1)!, /already done/);
  assert.equal(await answers.message(conv, msg("can you move it to friday?", ts(c.id))), false, "anything else goes to the chat turn");
  assert.equal(await answers.message(conv, msg("snooze whenever", ts(c.id))), false);
  assert.equal(await answers.message(conv, msg("done", 424242)), false, "not a reminder's timestamp");
  assert.equal(await answers.reaction(conv, { emoji: "👎", targetTimestamp: ts(c.id), isRemove: false, from: "x" }), false);
  assert.equal(await answers.reaction(conv, { emoji: "👍", targetTimestamp: ts(c.id), isRemove: true, from: "x" }), false, "a taken-back reaction is nothing");
  answers = mkAnswers();
  assert.equal(await answers.reaction(conv, { emoji: "👍", targetTimestamp: ts(c.id), isRemove: false, from: "x" }), true);
  assert.equal(S.getItem(conv.key, c.id)!.status, "done");
});

test("snooze arguments: hours, minutes, days, a clock time today or tomorrow, tomorrow", () => {
  const z = ZONE;
  assert.equal(A.snoozeUntil("", NOW, z), NOW + HOUR);
  assert.equal(A.snoozeUntil("30 min", NOW, z), NOW + 30 * MIN);
  assert.equal(A.snoozeUntil("2h", NOW, z), NOW + 2 * HOUR);
  assert.equal(A.snoozeUntil("2 days", NOW, z), NOW + 48 * HOUR);
  assert.equal(A.snoozeUntil("until 18:00", NOW, z), berlin("2026-10-22", "18:00"));
  assert.equal(A.snoozeUntil("until 9:00", NOW, z), berlin("2026-10-23", "09:00"), "already past today: tomorrow");
  assert.equal(A.snoozeUntil("until 6pm", NOW, z), berlin("2026-10-22", "18:00"));
  assert.equal(A.snoozeUntil("tomorrow", NOW, z), berlin("2026-10-23", "08:30"));
  assert.equal(A.snoozeUntil("0h", NOW, z), undefined);
  assert.equal(A.snoozeUntil("400 days", NOW, z), undefined);
  assert.deepEqual(A.parseAnswer("✅", NOW, z), { kind: "done" });
  assert.deepEqual(A.parseAnswer("Erledigt.", NOW, z), { kind: "done" });
  assert.equal(A.parseAnswer("done with the first part, not the second", NOW, z), undefined);
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
