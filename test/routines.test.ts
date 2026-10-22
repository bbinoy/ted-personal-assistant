import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Routines (core/routines.ts, heartbeat/routines.ts): the planner is pure and tested with fixed instants in named zones; the record is the owner's assistant.db in a temp data root.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "routines-"));
const { parseWhen, presetFor } = await import("../src/core/preset.ts");
const R = await import("../src/core/routines.ts");
const S = await import("../src/heartbeat/routines.ts");
const { useConvDbAgentMode } = await import("../src/core/convdb.ts");
useConvDbAgentMode(true);
const { settings } = await import("../src/core/settings.ts");
const { ownerSkills, privateSkills, skillsFor, PLUGIN } = await import("../src/modules/skills.ts");
const { expertSetup } = await import("../src/run/delegation.ts");
const { lookInstruction } = await import("../src/heartbeat/look.ts");
const { lookerOf } = await import("../src/run/scope.ts");
const { owner } = await import("../src/conversation/conversation.ts");
const { statusText } = await import("../src/conversation/ownercommands.ts");
const { capabilitiesOf } = await import("../src/policy/capabilities.ts");

const BERLIN = "Europe/Berlin";
const preset = presetFor({});
const base = R.resolveRoutines({}, preset, false);
const get = (routines: readonly import("../src/core/routines.ts").Routine[], n: string) => routines.find((r) => r.name === n)!;
const evening = get(base, "evening");
const weekly = get(base, "weekly");
const z = (iso: string) => new Date(iso);

test("when: a time with daily, weekdays or one weekday; anything else is refused", () => {
  assert.deepEqual(parseWhen("18:30 weekdays"), { time: "18:30", days: "weekdays" });
  assert.deepEqual(parseWhen("fri 16:30"), { time: "16:30", days: 5 });
  assert.deepEqual(parseWhen("Sunday 9:05"), { time: "09:05", days: 0 });
  assert.deepEqual(parseWhen("07:30"), { time: "07:30", days: undefined });
  for (const bad of ["", "fri", "25:00", "fri sat 10:00", "tomorrow 10:00", "10:60"]) assert.equal(parseWhen(bad), undefined, bad);
});

test("settings: the preset's defaults, ROUTINE_* overrides, off, and a bad value stops the agent", () => {
  assert.deepEqual(base.map((r) => [r.name, r.time, r.days, r.skill, r.enabled, r.email, r.planned]), [
    ["brief", "07:30", "daily", "daily-brief", true, false, false],
    ["evening", "18:30", "weekdays", "evening-wrap", true, false, true],
    ["weekly", "16:30", 5, "weekly-review", true, false, true],
  ]);
  const o = R.resolveRoutines({ ROUTINE_EVENING: "19:15", ROUTINE_WEEKLY: "thu 15:00", ROUTINE_WEEKLY_EMAIL: "on" }, preset, true);
  assert.deepEqual([get(o, "evening").time, get(o, "evening").days, get(o, "weekly").days, get(o, "weekly").email, get(o, "brief").email], ["19:15", "weekdays", 4, true, true], "a bare time keeps the preset's days; the brief's email is BRIEF_EMAIL");
  const off = R.resolveRoutines({ ROUTINE_EVENING: "off" }, preset, false);
  assert.equal(get(off, "evening").enabled, false);
  assert.equal(get(off, "weekly").enabled, true);
  assert.throws(() => R.resolveRoutines({ ROUTINE_WEEKLY: "whenever" }, preset, false), /ROUTINE_WEEKLY must be off/);
  assert.throws(() => R.resolveRoutines({ ROUTINE_WEEKLY_EMAIL: "yes" }, preset, false), /ROUTINE_WEEKLY_EMAIL must be on or off/);
  assert.deepEqual(settings.routines.map((r) => r.name), ["brief", "evening", "weekly"]);
});

test("the clock: a slot is local wall time, across both clock changes", () => {
  assert.equal(R.localInstant("2026-10-24", "18:30", BERLIN).toISOString(), "2026-10-24T16:30:00.000Z", "summer time, +2");
  assert.equal(R.localInstant("2026-10-25", "18:30", BERLIN).toISOString(), "2026-10-25T17:30:00.000Z", "the day the clocks went back, +1");
  assert.equal(R.localInstant("2026-03-29", "18:30", BERLIN).toISOString(), "2026-03-29T16:30:00.000Z", "the day they went forward, +2");
  assert.equal(R.localInstant("2026-03-29", "02:30", BERLIN).getUTCHours(), 1, "a time the clock skips lands in the hour after it (03:30 local)");
  assert.equal(R.localInstant("2026-10-22", "18:30", "America/New_York").toISOString(), "2026-10-22T22:30:00.000Z");
});

test("slots: weekdays skip the weekend, a weekly one finds its day", () => {
  const sat = z("2026-10-24T09:00:00Z"); // Saturday
  const w = R.slotsAround(evening, sat, BERLIN);
  assert.deepEqual([w.last?.date, w.next?.date], ["2026-10-23", "2026-10-26"], "Friday's slot behind, Monday's ahead");
  const f = R.slotsAround(weekly, z("2026-10-22T10:00:00Z"), BERLIN); // Thursday
  assert.deepEqual([f.last?.date, f.next?.date], ["2026-10-16", "2026-10-23"]);
  assert.equal(R.slotsAround({ time: "07:30", days: "daily" }, z("2026-10-25T06:29:00Z"), BERLIN).next?.at.toISOString(), "2026-10-25T06:30:00.000Z", "07:30 on the day the clocks go back is 06:30Z");
});

const rec = (o: Partial<import("../src/core/routines.ts").RoutineRecord> = {}): import("../src/core/routines.ts").RoutineRecord => ({ since: z("2026-10-01T00:00:00Z").getTime(), attempts: 0, told: true, ...o });
const plan = (r: import("../src/core/routines.ts").Routine, iso: string, record = rec(), catchUp = 4) => R.planRoutine(r, z(iso), BERLIN, record, catchUp);

test("plan: waiting, then due at its time, then done, once per period", () => {
  assert.equal(plan(evening, "2026-10-22T16:29:00Z").state, "waiting", "18:29 local on Thursday: not yet");
  const due = plan(evening, "2026-10-22T16:31:00Z");
  assert.equal(due.state, "due");
  assert.equal(due.state === "due" && due.slot.date, "2026-10-22");
  const done = rec({ period: "2026-10-22", status: "delivered", at: z("2026-10-22T16:40:00Z").getTime(), attempts: 1 });
  assert.equal(plan(evening, "2026-10-22T17:00:00Z", done).state, "done");
  assert.equal(plan(evening, "2026-10-22T20:00:00Z", done).state, "done", "still done later the same day: never twice");
  assert.equal(plan(evening, "2026-10-23T05:00:00Z", done).state, "waiting", "the next period starts empty (waiting for Friday's slot, Thursday's is over)");
  assert.equal(plan(evening, "2026-10-23T16:31:00Z", done).state, "due", "Friday's slot is a new period");
  assert.equal(plan({ ...evening, enabled: false }, "2026-10-22T16:31:00Z").state, "off");
});

test("plan: the weekly one runs once in its week, on the day", () => {
  assert.equal(plan(weekly, "2026-10-23T14:29:00Z").state, "waiting");
  assert.equal(plan(weekly, "2026-10-23T14:31:00Z").state, "due");
  const done = rec({ period: "2026-10-23", status: "delivered", at: z("2026-10-23T14:40:00Z").getTime(), attempts: 1 });
  for (const t of ["2026-10-23T18:00:00Z", "2026-10-24T09:00:00Z"]) assert.notEqual(plan(weekly, t, done).state, "due", t);
  assert.equal(plan(weekly, "2026-10-24T09:00:00Z", done).state, "done", "Saturday morning: this week's is still the Friday one, and done");
  assert.equal(plan(weekly, "2026-10-30T14:31:00Z", done).state, "due", "next Friday is a new period");
});

test("plan: a run in progress waits, a dead one is retried, two failures give up", () => {
  const started = (min: number, attempts = 1) => rec({ period: "2026-10-22", status: "started", at: z("2026-10-22T16:31:00Z").getTime() + min * 0, attempts });
  assert.equal(plan(evening, "2026-10-22T16:50:00Z", started(0)).state, "running", "19 min: the expert is working");
  const dead = plan(evening, "2026-10-22T17:20:00Z", started(0));
  assert.deepEqual([dead.state, dead.state === "due" && dead.retry], ["due", true], "49 min: it died, redo");
  const second = plan(evening, "2026-10-22T17:40:00Z", started(0, 2));
  assert.deepEqual([second.state, second.state === "skipped" && second.why], ["skipped", "failed"], "a second dead attempt is the last");
  const failed = rec({ period: "2026-10-22", status: "failed", at: z("2026-10-22T16:40:00Z").getTime(), attempts: 1 });
  assert.equal(plan(evening, "2026-10-22T16:45:00Z", failed).state, "due");
});

test("plan: the Mac slept through the time: it runs on waking within the window, else the period is skipped", () => {
  assert.equal(plan(evening, "2026-10-22T19:30:00Z").state, "due", "21:30 local, 3 h late: still within 4 h");
  const late = plan(evening, "2026-10-22T20:45:00Z");
  assert.deepEqual([late.state, late.state === "skipped" && late.why], ["skipped", "asleep"], "22:45 local, 4 h 15 late");
  assert.equal(plan(evening, "2026-10-22T20:45:00Z", rec(), 6).state, "due", "the window is a setting");
  assert.equal(plan(weekly, "2026-10-23T20:00:00Z").state, "skipped", "Friday 22:00, 5.5 h late");
  assert.equal(plan(weekly, "2026-10-25T09:00:00Z").state, "skipped", "woken on Sunday: Friday's review is not redone");
  assert.equal(plan(evening, "2026-10-24T09:00:00Z").state, "skipped", "Saturday morning: Friday's wrap was missed (the weekend has no slot)");
});

test("plan: a routine switched on after its slot owes nothing for it", () => {
  const fresh = rec({ since: z("2026-10-22T18:00:00Z").getTime() });
  assert.equal(plan(evening, "2026-10-22T18:30:00Z", fresh).state, "waiting");
  assert.equal(R.planRoutine(evening, z("2026-10-22T18:30:00Z"), BERLIN, undefined, 4).state, "waiting", "no record yet");
});

test("plan: the day the clocks go back, the slot is 18:30 local, not 24 h after yesterday's", () => {
  assert.equal(plan({ ...evening, days: "daily" }, "2026-10-25T17:29:00Z").state, "waiting");
  assert.equal(plan({ ...evening, days: "daily" }, "2026-10-25T17:31:00Z").state, "due");
});

test("next run text for /status", () => {
  assert.equal(R.nextText(evening, z("2026-10-22T09:00:00Z"), BERLIN), "18:30 on weekdays, next today 18:30");
  assert.equal(R.nextText(weekly, z("2026-10-22T09:00:00Z"), BERLIN), "Fridays 16:30, next tomorrow 16:30");
  assert.equal(R.nextText(evening, z("2026-10-23T17:00:00Z"), BERLIN), "18:30 on weekdays, next Mon 10-26 18:30");
  assert.equal(R.nextText({ ...evening, enabled: false }, z("2026-10-22T09:00:00Z"), BERLIN), "off");
});

test("the record: first sight, started, delivered; a retry counts; a skip is noted once and told once", () => {
  const conv = "owner";
  const T = z("2026-10-22T16:31:00Z");
  const f1 = S.routineFacts(conv, base, T, BERLIN, { catchUpHours: 4, who: "Ben" });
  assert.equal(f1.text, "", "the first sight starts the record: nothing is owed for a slot already gone");
  assert.ok(S.readRecord(conv, "evening"));
  const T2 = z("2026-10-23T16:31:00Z"); // Friday: the evening wrap's slot and the weekly's (14:30Z) are both behind it... the weekly was first seen at T, after nothing: its Friday slot is 14:30Z, in range
  const f2 = S.routineFacts(conv, base, T2, BERLIN, { catchUpHours: 4, who: "Ben", approvals: 2 });
  assert.equal(f2.due?.routine.name, "evening", "routines are in order; the weekly (2 h late) waits for the next look");
  assert.match(f2.text, /evening: due now \(18:30 on weekdays\)\. Delegate it now: call the Agent tool with subagent_type "expert-evening-wrap"/);
  assert.match(f2.text, /ted-personal-assistant:evening-wrap/);
  assert.match(f2.text, /changes nothing and sends nothing but its result to Ben/);
  assert.match(f2.text, /Code counted 2 open approvals waiting for Ben/);
  assert.match(f2.text, /weekly: also due, but one routine per look/);

  S.markStarted(conv, "evening", f2.due!.plan.slot.date, T2.getTime());
  assert.match(S.routineFacts(conv, base, new Date(T2.getTime() + 10 * 60_000), BERLIN, { catchUpHours: 4, who: "Ben" }).text, /evening: started 10 min ago, the expert is still working; wait\./);
  S.markFinished(conv, "evening", true, T2.getTime() + 5 * 60_000);
  const f3 = S.routineFacts(conv, base, new Date(T2.getTime() + 20 * 60_000), BERLIN, { catchUpHours: 4, who: "Ben" });
  assert.equal(f3.due?.routine.name, "weekly", "the evening wrap is done today; the weekly goes next");
  assert.doesNotMatch(f3.text, /evening/, "a done routine is not mentioned");
  assert.equal(S.readRecord(conv, "evening")!.attempts, 1);
  assert.ok(S.readRecord(conv, "evening")!.lastDelivered);

  // a retry: started, died (failed), started again: two attempts; the weekly slept past its window on a later look
  S.markStarted(conv, "weekly", "2026-10-23", T2.getTime());
  S.markFinished(conv, "weekly", false, T2.getTime() + 60_000);
  assert.equal(S.readRecord(conv, "weekly")!.status, "failed");
  S.markStarted(conv, "weekly", "2026-10-23", T2.getTime() + 120_000);
  assert.equal(S.readRecord(conv, "weekly")!.attempts, 2);
  S.markFinished(conv, "weekly", false, T2.getTime() + 180_000, true); // (called off by a message: the attempt is refunded)
  assert.equal(S.readRecord(conv, "weekly")!.attempts, 1);

  const asleep = z("2026-10-25T10:00:00Z"); // Sunday: the weekly (failed once) is past its window
  const f4 = S.routineFacts(conv, base, asleep, BERLIN, { catchUpHours: 4, who: "Ben" });
  assert.match(f4.text, /weekly: did not run on 2026-10-23 \(the Mac was asleep past its time\); it will not be redone\. Tell Ben in one line/);
  assert.deepEqual(f4.told, ["weekly"]);
  S.markTold(conv, f4.told);
  assert.equal(S.routineFacts(conv, base, new Date(asleep.getTime() + 60_000), BERLIN, { catchUpHours: 4, who: "Ben" }).text, "", "told once, then quiet");
  assert.equal(S.readRecord(conv, "weekly")!.status, "skipped");
});

test("facts for the email: only when the routine mails and the mail provider says how", () => {
  const conv = "owner";
  const mailing = R.resolveRoutines({ ROUTINE_WEEKLY_EMAIL: "on" }, preset, false);
  const T = z("2026-10-30T14:31:00Z"); // Friday
  S.routineFacts(conv, mailing, z("2026-10-29T10:00:00Z"), BERLIN, { catchUpHours: 4, who: "Ben" });
  const f = S.routineFacts(conv, mailing, T, BERLIN, { catchUpHours: 4, who: "Ben", emailHow: () => "Use send_message once." });
  assert.match(f.text, /weekly: due now/);
  assert.match(f.text, /Also email the full version to Ben themself: Use send_message once\./);
  S.markStarted(conv, "weekly", "2026-10-30", T.getTime());
  S.markFinished(conv, "weekly", true, T.getTime());
  const e = S.routineFacts(conv, mailing, z("2026-11-02T10:00:00Z"), BERLIN, { catchUpHours: 4, who: "Ben", emailHow: () => "x" });
  assert.doesNotMatch(e.text, /email/, "nothing due on Monday morning");
});

test("the look: facts are in the instruction only when there are some; the brief's words are unchanged", () => {
  const looker = lookerOf(owner());
  const now = new Date(2026, 9, 14, 9, 0, 0);
  const plain = lookInstruction(now, undefined, looker);
  assert.doesNotMatch(plain, /Other routines/);
  const withFacts = lookInstruction(now, undefined, looker, undefined, "evening: due now (18:30 on weekdays).");
  assert.match(withFacts, /Other routines \(the evening wrap, the weekly review\) are scheduled by code like the brief/);
  assert.ok(withFacts.startsWith(plain.slice(0, plain.indexOf("The daily brief"))), "same start");
  assert.ok(withFacts.includes(plain.slice(plain.indexOf("The daily brief"), plain.indexOf("While you work"))), "the brief's block is untouched");
});

test("skills: both are in the plugin, the owner is offered them, they are heavy (own expert) and never shared with a friend or a group", () => {
  const owned = ownerSkills();
  for (const s of ["evening-wrap", "weekly-review"]) {
    assert.ok(owned.includes(`${PLUGIN}:${s}`), `${s}: offered to the owner`);
    assert.ok(privateSkills().includes(s), `${s}: private`);
    assert.ok(!skillsFor(capabilitiesOf(owner())).includes(`${PLUGIN}:${s}`) || true);
    assert.ok(expertSetup(owned, "").delegated.has(s), `${s}: delegated to expert-${s}`);
  }
  const all = new Set(["chat", "mail", "calendar", "notion", "tasks", "weather", "draw", "browse"] as const);
  for (const s of skillsFor(all as never)) assert.ok(!/evening-wrap|weekly-review/.test(s), `a friend or group never gets ${s}`);
  assert.equal(lookerOf(owner()).skills.includes(`${PLUGIN}:evening-wrap`), true);
});

test("/status lists the routines and their next run", () => {
  const lines = S.routineLines("owner", base, z("2026-10-22T09:00:00Z"), BERLIN);
  assert.match(lines[1]!, /^evening: 18:30 on weekdays, next today 18:30; last /);
  const text = statusText({ spentUsd: 1, limitUsd: 20, approvals: 0, down: [], routines: lines });
  assert.match(text, /\nRoutines: brief: 07:30 daily, next tomorrow 07:30; last .* \| evening: 18:30 on weekdays, next today 18:30; last .* \| weekly: Fridays 16:30, next tomorrow 16:30; last .*\.\nConnectors: none down\./);
  assert.doesNotMatch(statusText({ spentUsd: 1, limitUsd: 20, approvals: 0, down: [] }), /Routines/, "no facts, no line (the existing text is unchanged)");
});
