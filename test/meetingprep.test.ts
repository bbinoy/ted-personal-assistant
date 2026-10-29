import { test } from "node:test";
import assert from "node:assert/strict";
import { told } from "./told.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Meeting prep before meetings (src/tasks/meetings.ts, heartbeat/preptick.ts, modules/meetings): the look records the upcoming meetings, the tick CLAIMS each one PREP_MINUTES before it (at most once), the conversation's look
// is made due and handed it as a fact, and the meeting is sent only when the look told it. Scheduling, at most once, reschedule, the skip rules, the night rule, the give-back, the recording tool.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "meetingprep-test-"));
process.env.TZ = "Europe/Berlin";

const M = await import("../src/tasks/meetings.ts");
const PT = await import("../src/heartbeat/preptick.ts");
const { noteMeetings, createMeetingsServer } = await import("../src/modules/meetings/meetingtools.ts");
const { owner, group, tenant } = await import("../src/conversation/conversation.ts");
const T = await import("../src/tenants/tenants.ts");
const { settings } = await import("../src/core/settings.ts");
const { heldPosts, resetHeld } = await import("../src/heartbeat/notices.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { createWakeups } = await import("../src/heartbeat/wake.ts");
const { convDb } =await import("../src/core/convdb.ts");
const { clearQuiet, setQuiet } = await import("../src/conversation/quiet.ts");
const { LOGIN } = await import("../src/tenants/payer.ts");
const { lookOptions } = await import("../src/run/agent.ts");
const { buildOptions } = await import("../src/run/agentrun.ts");
const { lookerOf } = await import("../src/run/scope.ts");
const { chatSystem } = await import("../src/run/persona.ts");
const { runFor } = await import("../src/run/runoptions.ts");
const { convDbRule } = await import("../src/heartbeat/convretention.ts");

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
s.maxUnpromptedPerDay = 2;
s.prepMinutes = 15;

const berlin = (date: string, time: string): number => Date.parse(`${date}T${time}:00+02:00`); // (CEST until 25 Oct)
const NOW = berlin("2026-10-22", "12:00");
const MIN = 60_000;
const conv = owner();
const db = () => convDb(conv.convId);
const rowsOf = () => M.allMeetings(db());
const iso = (ms: number) => new Date(ms).toISOString();

type Raw = import("../src/tasks/meetings.ts").RawMeeting;
const ME = { name: "Alex", email: "alex@example.com", self: true };
const ANNA = { name: "Anna", email: "anna@client.org" };
const raw = (id: string, startMs: number, o: Partial<Raw> = {}): Raw => ({ eventId: id, start: iso(startMs), title: `Meeting ${id}`, attendees: [ME, ANNA], ...o });
const record = (list: Raw[], at = NOW) => noteMeetings({ key: "owner", source: "background", now: () => at }, list);

function reset(): void {
  db().run("DELETE FROM meetings");
  db().run("DELETE FROM meeting_calls");
  resetHeld(conv);
  clearQuiet(conv);
  s.prepMinutes = 15;
  s.maxUnpromptedPerDay = 2;
}

// ---- recording: validation ----

test("recording: a time without its UTC offset, a past or far-off start, a missing id or title are refused with a reason; everything else is kept", () => {
  reset();
  const r = record([
    raw("ok", NOW + 40 * MIN),
    raw("naive", NOW + 40 * MIN, { start: "2026-10-22T12:40:00" }),
    raw("past", NOW - MIN),
    raw("far", NOW + 40 * 3_600_000),
    raw("", NOW + 40 * MIN),
    raw("notitle", NOW + 40 * MIN, { title: "  " }),
    raw("badend", NOW + 40 * MIN, { end: iso(NOW) }),
  ]);
  assert.match(r.text, /Recorded 1 upcoming/);
  assert.match(r.text, /WITH its UTC offset/);
  assert.match(r.text, /already started/);
  assert.match(r.text, /more than 36 hours/);
  assert.match(r.text, /needs its calendar id/);
  assert.match(r.text, /needs a title/);
  assert.match(r.text, /end must be/);
  assert.deepEqual(rowsOf().map((m) => m.eventId), ["ok"]);
});

test("recording: fields are cleaned and bounded: control characters out, titles and attendee lists cut, only https links, bad addresses dropped, the owner's own entry flagged", () => {
  reset();
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `P${i}`, email: `p${i}@x.org` }));
  record([raw("a", NOW + 30 * MIN, { title: "Budget\u0000 review\n" + "x".repeat(400), attendees: [ME, { name: "Anna", email: "not an address" }, { email: "BOB@Client.ORG" }, {}, ...many], link: "javascript:alert(1)" }), raw("b", NOW + 31 * MIN, { link: "https://meet.example.com/abc" })]);
  const [a, b] = rowsOf();
  assert.equal(a!.title.length, 200);
  assert.ok(!a!.title.includes("\u0000") && !a!.title.includes("\n"));
  assert.equal(a!.attendees.length, M.MAX_ATTENDEES - 1, "the invite is bounded (30 taken, the empty entry dropped)");
  assert.deepEqual(a!.attendees.slice(0, 3), [{ name: "Alex", email: "alex@example.com", self: true }, { name: "Anna" }, { email: "bob@client.org" }]);
  assert.equal(a!.link, undefined, "a link that is not https is dropped, the meeting stays");
  assert.equal(b!.link, "https://meet.example.com/abc");
});

test("recording replaces the pending meetings of the window: a cancelled one disappears, a moved one is a new row, one already claimed or sent is not touched", () => {
  reset();
  record([raw("keep", NOW + 20 * MIN), raw("gone", NOW + 30 * MIN), raw("moved", NOW + 40 * MIN)]);
  M.claimMeeting(db(), { eventId: "keep", startMs: NOW + 20 * MIN }, NOW);
  M.settleMeeting(db(), { eventId: "keep", startMs: NOW + 20 * MIN }, "sent", NOW);
  const r = record([raw("keep", NOW + 20 * MIN, { title: "Renamed" }), raw("moved", NOW + 90 * MIN)], NOW + MIN);
  assert.match(r.text, /replacing 2 earlier/);
  assert.deepEqual(rowsOf().map((m) => [m.eventId, m.startMs, m.state, m.title]), [
    ["keep", NOW + 20 * MIN, "sent", "Renamed"],
    ["moved", NOW + 90 * MIN, "pending", "Meeting moved"],
  ]);
  record([], NOW + 2 * MIN);
  assert.deepEqual(states().map((x) => x[0]), ["keep"], "an empty list means nothing is coming: pending rows go, the prepared one is history");
  assert.ok(M.lastNoted(db()) !== undefined, "an empty report still shows the calendar is being read");
});

test("recording: off while PREP_MINUTES is 0, and the tool is the conversation's own: a friend's call and the owner's write different databases", async () => {
  reset();
  s.prepMinutes = 0;
  assert.match(record([raw("x", NOW + 30 * MIN)]).text, /switched off/);
  assert.equal(rowsOf().length, 0);
  s.prepMinutes = 15;
  const ana = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000f1", name: "Ana" })!;
  const key = `tenant:${ana.id}`;
  noteMeetings({ key, source: "group", now: () => NOW }, [raw("friend-1", NOW + 30 * MIN)]);
  record([raw("owner-1", NOW + 30 * MIN)]);
  assert.deepEqual(rowsOf().map((m) => m.eventId), ["owner-1"], "the owner's table holds only the owner's meetings");
  assert.deepEqual(M.allMeetings(convDb(tenant(ana.id).convId)).map((m) => m.eventId), ["friend-1"]);
  const server = createMeetingsServer({ key, source: "group", now: () => NOW }) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: { meetings: Raw[] }) => Promise<{ content: { text: string }[] }> }> } };
  assert.match((await server.instance._registeredTools.note_upcoming_meetings!.handler({ meetings: [raw("friend-2", NOW + 50 * MIN)] })).content[0]!.text, /Recorded 1/);
  assert.deepEqual(M.allMeetings(convDb(tenant(ana.id).convId)).map((m) => m.eventId), ["friend-2"], "a call replaces the pending meetings of its window, in her own table");
  assert.deepEqual(rowsOf().map((m) => m.eventId), ["owner-1"], "still only the owner's");
});

// ---- the pure rules ----

const meet = (o: Partial<import("../src/tasks/meetings.ts").Meeting> = {}): import("../src/tasks/meetings.ts").Meeting => ({ eventId: "e", startMs: NOW + 20 * MIN, title: "T", attendees: [ME, ANNA], allDay: false, private: false, ...o });

test("skip rules: declined, all-day, private, nobody else (unless there is a video link); outside her domain is a fact, not a rule", () => {
  assert.equal(M.prepSkip(meet()), undefined);
  assert.equal(M.prepSkip(meet({ response: "declined" })), "declined");
  assert.equal(M.prepSkip(meet({ response: "tentative" })), undefined, "tentative is still a meeting");
  assert.equal(M.prepSkip(meet({ allDay: true })), "all-day");
  assert.equal(M.prepSkip(meet({ private: true })), "private");
  assert.equal(M.prepSkip(meet({ attendees: [ME] })), "alone");
  assert.equal(M.prepSkip(meet({ attendees: [] })), "alone");
  assert.equal(M.prepSkip(meet({ attendees: [ME], link: "https://meet.example.com/x" })), undefined, "a video link counts as other people");
  assert.equal(M.prepSkip(meet({ attendees: [ME, { name: "Cy", email: "cy@example.com" }] })), undefined, "colleagues only: the look judges whether it is worth a word");
  assert.match(M.meetingFacts([{ ...meet({ attendees: [ME, { name: "Cy", email: "cy@example.com" }] }), state: "claimed", tries: 0 } as never], { now: NOW, zone: "Europe/Berlin" }), /outside her e-mail domain: no/);
  assert.match(M.meetingFacts([{ ...meet(), state: "claimed", tries: 0 } as never], { now: NOW, zone: "Europe/Berlin" }), /outside her e-mail domain: yes/);
  assert.equal(M.hasExternal(meet({ attendees: [{ name: "Alex", self: true }, { name: "Eve" }] })), true, "owner's address unknown: everyone counts as outside");
});

test("due: from PREP_MINUTES before the start until 3 minutes before it, once open; never for a closed row or when prep is off", () => {
  const m = { state: "pending" as const, startMs: NOW + 15 * MIN };
  assert.equal(M.prepDue(m, NOW - MIN, 15), false);
  assert.equal(M.prepDue(m, NOW, 15), true);
  assert.equal(M.prepDue(m, NOW + 12 * MIN, 15), true);
  assert.equal(M.prepDue(m, NOW + 13 * MIN, 15), false, "less than 3 minutes left: too late to be of use");
  assert.equal(M.prepDue({ ...m, state: "sent" }, NOW, 15), false);
  assert.equal(M.prepDue({ ...m, state: "retry" }, NOW, 15), true);
  assert.equal(M.prepDue(m, NOW, 0), false);
  assert.equal(M.prepDue(m, NOW, 30), true, "PREP_MINUTES is the lead");
});

test("the doctor: no calendar data only when prep is on, the database is more than a day old and the look has reported nothing for a day", () => {
  const day = 86_400_000;
  assert.equal(M.noCalendarData({ enabled: true, dbAgeMs: 2 * day, now: NOW }), true);
  assert.equal(M.noCalendarData({ enabled: true, lastNoted: NOW - 2 * day, dbAgeMs: 9 * day, now: NOW }), true);
  assert.equal(M.noCalendarData({ enabled: true, lastNoted: NOW - 3_600_000, dbAgeMs: 9 * day, now: NOW }), false);
  assert.equal(M.noCalendarData({ enabled: true, dbAgeMs: 3_600_000, now: NOW }), false, "a new install is not blamed");
  assert.equal(M.noCalendarData({ enabled: false, dbAgeMs: 2 * day, now: NOW }), false);
});

// ---- the tick ----

const tick = (at: number, c: typeof conv = conv): number => PT.claimPreps(c, new Date(at));
const states = () => rowsOf().map((m) => [m.eventId, m.state, m.why]);
const lookSays = (at: number, said = true): string[] => { // (what a look does: it is handed the claimed meetings, then tells them or not)
  const handed = PT.waitingMeetings(conv);
  PT.afterPrep(conv, handed, said, at);
  return handed.map((m) => m.eventId);
};

test("scheduling: nothing before PREP_MINUTES; at the time the meeting is claimed, the look is due and handed it as a fact, and it is sent only when the look told it", () => {
  reset();
  record([raw("m1", NOW + 15 * MIN)]);
  assert.equal(tick(NOW - MIN), 0, "16 minutes before: not yet");
  assert.equal(PT.meetingsWaiting(conv), false);
  assert.equal(tick(NOW), 1);
  assert.equal(PT.meetingsWaiting(conv), true, "the look is due at once");
  assert.deepEqual(states(), [["m1", "claimed", undefined]]);
  const facts = M.meetingFacts(PT.waitingMeetings(conv), { now: NOW, zone: "Europe/Berlin", skill: "ted-personal-assistant:meeting-prep" });
  assert.match(facts, /Meeting m1/);
  assert.match(facts, /in 15 min/);
  assert.match(facts, /Anna <anna@client\.org>/);
  assert.match(facts, /<meetings_to_prepare>/, "the calendar's words are fenced data");
  assert.match(facts, /ted-personal-assistant:meeting-prep/);
  assert.match(facts, /urgent: true/);
  assert.doesNotMatch(M.meetingFacts(PT.waitingMeetings(conv), { now: NOW, zone: "Europe/Berlin" }), /meeting-prep/, "a friend's look has no such skill: the format is in the fact");
  assert.deepEqual(lookSays(NOW + MIN), ["m1"]);
  assert.deepEqual(states(), [["m1", "sent", undefined]]);
  assert.equal(PT.meetingsWaiting(conv), false);
});

test("at most once: a second tick, a restart and the look recording the event again claim it only once", () => {
  reset();
  record([raw("m1", NOW + 15 * MIN)]);
  assert.equal(tick(NOW) + tick(NOW), 1, "the second tick found it claimed");
  lookSays(NOW + MIN);
  assert.equal(tick(NOW + 2 * MIN), 0);
  record([raw("m1", NOW + 15 * MIN, { title: "Same meeting, seen again" })], NOW + 2 * MIN);
  assert.equal(tick(NOW + 3 * MIN), 0, "the look recording an event again does not make a second prep");
});

test("a rescheduled event gets a new prep (same id, new start), a cancelled one none", () => {
  reset();
  record([raw("m1", NOW + 15 * MIN), raw("m2", NOW + 20 * MIN)]);
  assert.equal(tick(NOW), 1, "m1 only: m2 is 20 minutes away");
  lookSays(NOW);
  record([raw("m1", NOW + 120 * MIN)], NOW + MIN); // m1 moved to 14:00, m2 cancelled
  assert.deepEqual(states().filter((x) => x[0] === "m2"), [], "the cancelled meeting is forgotten");
  assert.equal(tick(NOW + 5 * MIN), 0);
  assert.equal(tick(NOW + 105 * MIN), 1, "the new time has its own prep");
  lookSays(NOW + 106 * MIN);
  assert.deepEqual(rowsOf().map((m) => [m.eventId, m.startMs, m.state]), [["m1", NOW + 15 * MIN, "sent"], ["m1", NOW + 120 * MIN, "sent"]]);
});

test("skipped meetings are never claimed and are marked with the rule: declined, all-day, private, alone", () => {
  reset();
  record([
    raw("dec", NOW + 15 * MIN, { response: "declined" }),
    raw("all", NOW + 15 * MIN, { allDay: true }),
    raw("priv", NOW + 15 * MIN, { private: true }),
    raw("solo", NOW + 15 * MIN, { attendees: [ME] }),
    raw("real", NOW + 15 * MIN),
  ]);
  assert.equal(tick(NOW), 1);
  assert.deepEqual(Object.fromEntries(states().map((x) => [x[0], `${x[1]}:${x[2]}`])), { dec: "skipped:declined", all: "skipped:all-day", priv: "skipped:private", solo: "skipped:alone", real: "claimed:undefined" });
});

test("not for a group, not while PREP_MINUTES is 0, not for a conversation without a calendar", () => {
  reset();
  record([raw("m1", NOW + 15 * MIN)]);
  s.prepMinutes = 0;
  assert.equal(tick(NOW), 0);
  s.prepMinutes = 15;
  assert.equal(PT.prepEnabled(group("meetingprep-group-1")), false);
  assert.equal(tick(NOW, group("meetingprep-group-1") as never), 0);
  const nocal = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000f2", name: "Nocal" })!;
  assert.equal(PT.prepEnabled(tenant(nocal.id)), false, "a friend without Google calendar has no prep");
  assert.equal(PT.meetingsWaiting(conv), false);
});

test("the night rule: no claim between 23:00 and 06:00, nor under /quiet; it stays open, never held; the configured quiet window (22-07) does not stop a prep for a meeting that is on", () => {
  reset();
  const late = berlin("2026-10-22", "23:30");
  record([raw("night", late + 15 * MIN)], late - 3 * 60 * MIN);
  assert.equal(tick(late), 0);
  assert.deepEqual(states(), [["night", "pending", undefined]], "left open, not settled: the sweep drops it once too late");
  assert.deepEqual(heldPosts(conv), [], "never held for a digest: a prep after its meeting is worth nothing");

  reset();
  const early = berlin("2026-10-23", "06:45");
  record([raw("early", early + 15 * MIN)], early - 60 * MIN);
  assert.equal(tick(early), 1, "a 07:00 meeting is prepared at 06:45 though 22-07 is the quiet window");

  reset();
  const dusk = berlin("2026-10-22", "22:30");
  record([raw("dusk", dusk + 15 * MIN)], dusk - 60 * MIN);
  assert.equal(tick(dusk), 1, "22:30 is quiet-window time but not deep night");

  reset();
  setQuiet(conv, "");
  record([raw("dnd", NOW + 15 * MIN)]);
  assert.equal(tick(NOW), 0);
  assert.deepEqual(states(), [["dnd", "pending", undefined]]);
});

test("a night or /quiet that ends before the meeting does not lose the prep: a 06:10 meeting due at 05:55 is claimed at 06:00; a /quiet that ends in time too; otherwise the sweep drops it", () => {
  reset();
  const m = berlin("2026-10-23", "06:10");
  record([raw("early", m)], m - 3 * 3_600_000);
  assert.equal(tick(m - 15 * MIN), 0); // 05:55: night
  assert.equal(rowsOf()[0]!.state, "pending");
  assert.equal(tick(berlin("2026-10-23", "06:00")), 1);

  reset();
  record([raw("dnd", NOW + 30 * MIN)]);
  setQuiet(conv, iso(NOW + 20 * MIN)); // /quiet until 12:20
  assert.equal(tick(NOW + 15 * MIN), 0);
  assert.equal(tick(NOW + 21 * MIN), 1, "it ended in time");

  reset();
  record([raw("late", NOW + 30 * MIN)]);
  setQuiet(conv, "");
  tick(NOW + 15 * MIN);
  tick(NOW + 28 * MIN);
  assert.deepEqual(states(), [["late", "skipped", "too late"]], "never in time: the sweep drops it");
});

test("a look that did not tell it gives the meeting back once while there is time, then fails it; the sweep drops a claimed one that is too close to the start", () => {
  reset();
  record([raw("m1", NOW + 15 * MIN)]);
  assert.equal(tick(NOW), 1);
  assert.deepEqual(lookSays(NOW + MIN, false), ["m1"]);
  assert.equal(rowsOf()[0]!.state, "retry");
  assert.equal(tick(NOW + 2 * MIN), 1, "claimed again");
  lookSays(NOW + 3 * MIN, false);
  assert.equal(rowsOf()[0]!.state, "failed", "the second miss is the last");
  assert.equal(tick(NOW + 4 * MIN), 0);

  reset();
  record([raw("m3", NOW + 15 * MIN)]);
  assert.equal(tick(NOW + 13 * MIN), 0, "the tick was late: 2 minutes before the start there is no point");
  assert.deepEqual(states(), [["m3", "skipped", "too late"]]);

  reset();
  record([raw("m4", NOW + 15 * MIN)]);
  tick(NOW); // claimed, but no look came in time (paused, over budget, failing)
  tick(NOW + 13 * MIN);
  assert.deepEqual(states(), [["m4", "skipped", "too late"]]);
  assert.equal(PT.meetingsWaiting(conv), false, "nothing is left for a look to say after the meeting");
});

// ---- the look's side: who records, what the instruction says ----

test("the prompt tells a check to record meetings only where prep exists: the owner with PREP_MINUTES on; not when it is 0, not a group", () => {
  assert.equal(lookerOf(conv).meetings, true);
  assert.match(chatSystem(undefined, lookerOf(conv)), /note_upcoming_meetings/);
  s.prepMinutes = 0;
  assert.equal(lookerOf(conv).meetings, false);
  assert.doesNotMatch(chatSystem(undefined, lookerOf(conv)), /note_upcoming_meetings/);
  s.prepMinutes = 15;
  assert.equal(lookerOf(group("meetingprep-group-2")).meetings, false);
});

test("the recording tool follows the calendar capability: the owner's look and chat turn have it; not a group, not with PREP_MINUTES 0", () => {
  const look = lookOptions(conv, LOGIN, {}, new Date(NOW));
  const names = (o: Parameters<typeof buildOptions>[1]) => Object.keys(buildOptions(async () => ({ approved: false }), o, undefined).mcpServers as object);
  assert.ok(names(look).includes("meetings"));
  assert.ok(names(runFor(conv, "message", { now: new Date(NOW) })).includes("meetings"), "a chat turn that has the calendar can record too");
  s.prepMinutes = 0;
  assert.ok(!names(look).includes("meetings"), "off: no server");
  s.prepMinutes = 15;
  assert.ok(!names(runFor(group("meetingprep-group-4"), "message", { now: new Date(NOW) })).includes("meetings"), "a group chat has no calendar, so no tool");
  assert.ok(!names(lookOptions(group("meetingprep-group-3"), LOGIN, {}, new Date(NOW))).includes("meetings"), "a group has no calendar, so no tool");
});

test("retention: meeting rows older than 3 days go in the nightly sweep, newer ones stay", () => {
  reset();
  record([raw("soon", NOW + 15 * MIN)]);
  db().run("INSERT INTO meetings (event_id, start_ms, title, attendees, noted, state) VALUES ('old', ?, 'Old', '[]', 0, 'sent')", NOW - 4 * 86_400_000);
  const rule = convDbRule(() => ({ root: process.env.HARNESS_DATA_DIR!, conversations: join(process.env.HARNESS_DATA_DIR!, "conversations"), conv: (c: string) => ({ db: join(process.env.HARNESS_DATA_DIR!, "conversations", c, "assistant.db") }) }) as never);
  const dry = rule.run(new Date(NOW), { dryRun: true } as never) as { removed: number };
  assert.ok(dry.removed >= 1);
  assert.ok(rowsOf().some((m) => m.eventId === "old"), "a dry run removes nothing");
  rule.run(new Date(NOW), { dryRun: false } as never);
  assert.deepEqual(rowsOf().map((m) => m.eventId), ["soon"]);
});


test("the owner's look is handed the claimed meeting as a fact and says it: a post marks it sent; a look that stays silent gives it back", async () => {
  s.wakeups = true;
  let answer: string = "15:10 Budget review with Anna. Last mail on Monday.";
  const prompts: string[] = [];
  let n = 0;
  const pipeline = {
    busy: () => false, sendWhile: async (_c: unknown, run: () => Promise<unknown>) => run(), record: () => {},
    enqueue: <T,>(_c: unknown, job: () => Promise<T>) => job(),
    runTurn: async (c: { logFile: string }, turn: { run: () => Promise<{ text: string }> }) => {
      const text = (await turn.run()).text;
      recordMessage("notice", 9000 + ++n, text, new Date(NOW), c.logFile);
      return { spoke: true };
    },
  };
  const w = createWakeups({
    pipeline: pipeline as never,
    groupChats: false,
    vouch: async () => true,
    run: async (_c: unknown, _p: unknown, build: (s?: string) => { prompt: string }, extra: { facts?: { status: string[]; blocks: string[] } }) => (prompts.push(told(build, extra)), { text: answer, structured: { message: answer, nextCheckMinutes: 60, urgent: true } }),
    notesChangedAt: () => 0,
    now: () => new Date(NOW),
    guards: { paused: () => false, budgetSpent: () => false },
  });
  reset();
  record([raw("m1", NOW + 15 * MIN)]);
  await w.tick(new Date(NOW));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /<meetings_to_prepare>[\s\S]*Meeting m1[\s\S]*urgent: true/);
  assert.deepEqual(states(), [["m1", "sent", undefined]]);

  reset();
  answer = "[[silent]]";
  record([raw("m2", NOW + 15 * MIN)]);
  await w.tick(new Date(NOW + 2 * MIN));
  assert.equal(prompts.length, 2);
  assert.deepEqual(states(), [["m2", "retry", "look did not tell it"]]);
});
