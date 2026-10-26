import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ONE schedule mechanism (tasks/routines.ts): skills declare `schedule:` in SKILL.md, a person's routine is a `routine-` note with a `when:` line; the planner is pure and tested with fixed instants in
// named zones; the record is the conversation's assistant.db in a temp data root.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "routines-"));
process.env.TZ = "Europe/Berlin";
const S = await import("../src/tasks/routines.ts");
const { readRecord } = S;
const { parseRepeat } = await import("../src/tasks/repeat.ts");
const { useConvDbAgentMode } = await import("../src/core/convdb.ts");
useConvDbAgentMode(true);
const { settings, loadSettings } = await import("../src/core/settings.ts");
const { ownerSkills, privateSkills, skillsFor, scheduledSkills, PLUGIN } = await import("../src/modules/skills.ts");
const { expertSetup } = await import("../src/run/delegation.ts");
const { lookInstruction } = await import("../src/heartbeat/look.ts");
const { lookerOf } = await import("../src/run/scope.ts");
const { owner, group } = await import("../src/conversation/conversation.ts");
const { statusText } = await import("../src/conversation/ownercommands.ts");
const { capabilitiesOf } = await import("../src/policy/capabilities.ts");
const { scheduledIn, scheduleLines, routineNoteReply } = await import("../src/modules/tasks/routinelist.ts");
const F = await import("../src/heartbeat/facts.ts");
const { chatSystem, groupSystem, tenantSystem } = await import("../src/run/persona.ts");
const { GROUP_CAPABILITIES } = await import("../src/policy/capabilities.ts");

const BERLIN = "Europe/Berlin";
const z = (iso: string) => new Date(iso);
const rule = (text: string) => {
  const p = parseRepeat(text);
  assert.ok(p.ok, text);
  return p.rule;
};
const skill = (name: string, skillName: string, text: string): import("../src/tasks/routines.ts").Routine => ({ name, skill: skillName, rule: rule(text) });
const brief = skill("daily-brief", "daily-brief", "every day at 07:30");
const evening = skill("evening-wrap", "evening-wrap", "every weekday at 18:30");
const weekly = skill("weekly-review", "weekly-review", "every fri at 16:30");
const all = [brief, evening, weekly];
const opts = { catchUpHours: 4, who: "Ben", agentOf: (k: string) => `expert-${k}` };
const anchor = "2026-10-01";

test("skills declare their schedule in SKILL.md frontmatter, in the repeat grammar, and every one parses with a time", () => {
  const skills = readdirSync(join(settings.pluginDir, "skills")).map((d) => `${PLUGIN}:${d}`);
  const found = scheduledSkills(skills);
  assert.deepEqual(found, [["daily-brief", "every day at 07:30"], ["evening-wrap", "every weekday at 18:30"], ["weekly-review", "every fri at 16:30"]]);
  for (const [name, text] of found) {
    const p = parseRepeat(text);
    assert.ok(p.ok && p.rule.time, `${name}: ${text}`);
    assert.ok(expertSetup(skills, "").agents[`expert-${name}`], `${name}: a scheduled skill has an expert to delegate to`);
  }
});

test("slots: a weekday rule skips the weekend, a weekly one finds its day, and the slot is wall time across both clock changes", () => {
  const w = S.slotsAround(evening, z("2026-10-24T09:00:00Z"), BERLIN, anchor); // Saturday
  assert.deepEqual([w.last?.date, w.next?.date], ["2026-10-23", "2026-10-26"], "Friday's slot behind, Monday's ahead");
  const f = S.slotsAround(weekly, z("2026-10-22T10:00:00Z"), BERLIN, anchor); // Thursday
  assert.deepEqual([f.last?.date, f.next?.date], ["2026-10-16", "2026-10-23"]);
  assert.equal(S.slotsAround(brief, z("2026-10-25T06:29:00Z"), BERLIN, anchor).next?.at.toISOString(), "2026-10-25T06:30:00.000Z", "07:30 on the day the clocks go back is 06:30Z");
  assert.equal(S.slotsAround(evening, z("2026-10-24T20:00:00Z"), BERLIN, anchor).last?.at.toISOString(), "2026-10-23T16:30:00.000Z", "summer time, +2");
  assert.equal(S.slotsAround(brief, z("2026-10-26T12:00:00Z"), BERLIN, anchor).last?.at.toISOString(), "2026-10-26T06:30:00.000Z", "winter time, +1");
  assert.equal(S.slotsAround(evening, z("2026-03-30T12:00:00Z"), BERLIN, anchor).last?.at.toISOString(), "2026-03-27T17:30:00.000Z", "before the clocks went forward");
  assert.equal(S.slotsAround(brief, z("2026-03-30T12:00:00Z"), BERLIN, anchor).last?.at.toISOString(), "2026-03-30T05:30:00.000Z", "after: 07:30 is still 07:30 on the wall, +2");
  assert.equal(S.slotsAround(evening, z("2026-10-22T23:00:00Z"), "America/New_York", anchor).last?.at.toISOString(), "2026-10-22T22:30:00.000Z", "another zone");
});

const rec = (o: Partial<import("../src/tasks/routines.ts").RoutineRecord> = {}): import("../src/tasks/routines.ts").RoutineRecord => ({ since: z("2026-10-01T00:00:00Z").getTime(), attempts: 0, told: true, ...o });
const before = (date: string) => rec({ period: date, status: "delivered", at: 1, attempts: 1 }); // the previous period's slot was served
const plan = (r: import("../src/tasks/routines.ts").Routine, iso: string, record = rec(), catchUp = 4) => S.planRoutine(r, z(iso), BERLIN, record, catchUp);

test("plan: waiting, then due at its time, then done, once per period", () => {
  assert.equal(plan(evening, "2026-10-22T16:29:00Z", before("2026-10-21")).state, "done", "18:29 local on Thursday: not yet; the last slot (Wednesday) was served, so nothing is due");
  const due = plan(evening, "2026-10-22T16:31:00Z");
  assert.equal(due.state, "due");
  assert.equal(due.state === "due" && due.slot.date, "2026-10-22");
  const done = rec({ period: "2026-10-22", status: "delivered", at: z("2026-10-22T16:40:00Z").getTime(), attempts: 1 });
  assert.equal(plan(evening, "2026-10-22T17:00:00Z", done).state, "done");
  assert.equal(plan(evening, "2026-10-22T20:00:00Z", done).state, "done", "still done later the same day: never twice");
  assert.equal(plan(evening, "2026-10-23T05:00:00Z", done).state, "done", "Friday morning: Thursday's was the last slot, and it was served");
  assert.equal(plan(evening, "2026-10-23T16:31:00Z", done).state, "due", "Friday's slot is a new period");
});

test("plan: the brief is due at 07:30 and caught up on waking", () => {
  assert.equal(plan(brief, "2026-10-22T05:29:00Z", before("2026-10-21")).state, "done", "07:29 local: not yet");
  assert.equal(plan(brief, "2026-10-22T05:31:00Z").state, "due");
  assert.equal(plan(brief, "2026-10-22T09:00:00Z").state, "due", "11:00 local, 3.5 h late: still within the window");
  assert.equal(plan(brief, "2026-10-22T10:00:00Z").state, "skipped", "12:00 local, 4.5 h late");
});

test("plan: the weekly one runs once in its week, on the day", () => {
  assert.equal(plan(weekly, "2026-10-23T14:29:00Z", before("2026-10-16")).state, "done");
  assert.equal(plan(weekly, "2026-10-23T14:31:00Z").state, "due");
  const done = rec({ period: "2026-10-23", status: "delivered", at: z("2026-10-23T14:40:00Z").getTime(), attempts: 1 });
  assert.equal(plan(weekly, "2026-10-24T09:00:00Z", done).state, "done", "Saturday morning: this week's is still the Friday one, and done");
  assert.equal(plan(weekly, "2026-10-30T15:31:00Z", done).state, "due", "next Friday is a new period");
});

test("plan: a run in progress waits, a dead one is retried once, two failures give up", () => {
  const started = (attempts = 1) => rec({ period: "2026-10-22", status: "started", at: z("2026-10-22T16:31:00Z").getTime(), attempts });
  assert.equal(plan(evening, "2026-10-22T16:50:00Z", started()).state, "running", "19 min: the expert is working");
  const dead = plan(evening, "2026-10-22T17:20:00Z", started());
  assert.deepEqual([dead.state, dead.state === "due" && dead.retry], ["due", true], "49 min: it died, redo");
  const second = plan(evening, "2026-10-22T17:40:00Z", started(2));
  assert.deepEqual([second.state, second.state === "skipped" && second.why], ["skipped", "failed"], "a second dead attempt is the last");
  const failed = rec({ period: "2026-10-22", status: "failed", at: z("2026-10-22T16:40:00Z").getTime(), attempts: 1 });
  assert.equal(plan(evening, "2026-10-22T16:45:00Z", failed).state, "due");
});

test("plan: the Mac slept through the time: it runs on waking within the window, else the period is skipped", () => {
  assert.equal(plan(evening, "2026-10-22T19:30:00Z").state, "due", "21:30 local, 3 h late: still within 4 h");
  const late = plan(evening, "2026-10-22T20:45:00Z");
  assert.deepEqual([late.state, late.state === "skipped" && late.why], ["skipped", "asleep"], "22:45 local, 4 h 15 late");
  assert.equal(plan(evening, "2026-10-22T20:45:00Z", rec(), 6).state, "due", "the window is a setting");
  assert.equal(plan(weekly, "2026-10-25T09:00:00Z").state, "skipped", "woken on Sunday: Friday's review is not redone");
});

test("plan: a routine first seen after its slot owes nothing for it; the day the clocks go back the slot is 18:30 local", () => {
  assert.equal(plan(evening, "2026-10-22T18:30:00Z", rec({ since: z("2026-10-22T18:00:00Z").getTime() })).state, "waiting");
  assert.equal(S.planRoutine(evening, z("2026-10-22T18:30:00Z"), BERLIN, undefined, 4).state, "waiting", "no record yet");
  assert.equal(plan(skill("d", "d", "every day at 18:30"), "2026-10-25T17:29:00Z", before("2026-10-24")).state, "done");
  assert.equal(plan(skill("d", "d", "every day at 18:30"), "2026-10-25T17:31:00Z").state, "due");
});

test("an interval counts from the day the routine was first seen; editing the rule moves the next occurrence, and what ran today does not run again", () => {
  const every2 = { name: "routine-x", rule: rule("every 2 weeks on monday at 09:00"), instruction: "x" };
  const first = rec({ since: z("2026-10-19T06:00:00Z").getTime() }); // seen on a Monday
  assert.equal(S.nextText(every2, z("2026-10-20T06:00:00Z"), BERLIN, first), "every 2 weeks on monday at 09:00, next Mon 2 Nov 09:00");
  const at9 = { name: "routine-x", rule: rule("every day at 09:00"), instruction: "x" };
  const at10 = { name: "routine-x", rule: rule("every day at 10:00"), instruction: "x" };
  const ranToday = rec({ period: "2026-10-22", status: "delivered", at: z("2026-10-22T07:05:00Z").getTime(), attempts: 1 });
  assert.match(S.nextText(at9, z("2026-10-22T07:30:00Z"), BERLIN, ranToday), /next tomorrow 09:00/);
  assert.match(S.nextText(at10, z("2026-10-22T07:30:00Z"), BERLIN, ranToday), /next today 10:00/, "the edit moved the next occurrence to 10:00 today");
  assert.equal(S.planRoutine(at10, z("2026-10-22T08:30:00Z"), BERLIN, ranToday, 4).state, "done", "10:30 local: the 10:00 slot is today's, which was served at 09:05; the edit starts at the next occurrence");
  assert.equal(S.planRoutine(at10, z("2026-10-23T08:30:00Z"), BERLIN, ranToday, 4).state, "due", "the next day it runs at the new time");
});

test("the record: first sight, started, delivered; a retry counts; a skip is noted once and told once", () => {
  const conv = "owner";
  const T = z("2026-10-22T16:31:00Z");
  const f1 = S.routineFacts(conv, all, T, BERLIN, opts);
  assert.equal(f1.text, "", "the first sight starts the record: nothing is owed for a slot already gone");
  assert.ok(S.readRecord(conv, "evening-wrap"));
  const T2 = z("2026-10-23T16:31:00Z"); // Friday: the evening wrap's slot and the weekly's (14:30Z) are both behind it; the brief's (05:30Z) is 11 h gone
  assert.match(S.routineFacts(conv, all, T2, BERLIN, opts).text, /daily-brief: did not run on 2026-10-23 \(the Mac was asleep past its time\)/, "the brief is past its window: skipped, told once");
  const f2c = S.routineFacts(conv, [evening, weekly], T2, BERLIN, { ...opts, approvals: 2 });
  assert.equal(f2c.due?.routine.name, "evening-wrap", "routines are in order; the weekly (2 h late) waits for the next look");
  assert.match(f2c.text, /evening-wrap: due now \(every weekday at 18:30\)\. Delegate it now: call the Agent tool with subagent_type "expert-evening-wrap"/);
  assert.match(f2c.text, /ted-personal-assistant:evening-wrap/);
  assert.match(f2c.text, /every time it writes is exactly as the clock line gives it/);
  assert.match(f2c.text, /Code counted 2 open approvals waiting for Ben/);
  assert.match(f2c.text, /weekly-review: also due, but one routine per look/);

  S.markStarted(conv, "evening-wrap", f2c.due!.plan.slot.date, T2.getTime());
  assert.match(S.routineFacts(conv, [evening, weekly], new Date(T2.getTime() + 10 * 60_000), BERLIN, opts).text, /evening-wrap: started 10 min ago, the expert is still working; wait\./);
  S.markFinished(conv, "evening-wrap", true, T2.getTime() + 5 * 60_000);
  const f3 = S.routineFacts(conv, [evening, weekly], new Date(T2.getTime() + 20 * 60_000), BERLIN, opts);
  assert.equal(f3.due?.routine.name, "weekly-review", "the evening wrap is done today; the weekly goes next");
  assert.doesNotMatch(f3.text, /evening-wrap/, "a done routine is not mentioned");
  assert.ok(S.readRecord(conv, "evening-wrap")!.lastDelivered);

  // a retry: started, died (failed), started again: two attempts; a message calling the look off gives one back
  S.markStarted(conv, "weekly-review", "2026-10-23", T2.getTime());
  S.markFinished(conv, "weekly-review", false, T2.getTime() + 60_000);
  assert.equal(S.readRecord(conv, "weekly-review")!.status, "failed");
  S.markStarted(conv, "weekly-review", "2026-10-23", T2.getTime() + 120_000);
  assert.equal(S.readRecord(conv, "weekly-review")!.attempts, 2);
  S.markFinished(conv, "weekly-review", false, T2.getTime() + 180_000, true);
  assert.equal(S.readRecord(conv, "weekly-review")!.attempts, 1);

  const asleep = z("2026-10-25T14:00:00Z"); // Sunday afternoon: the weekly (failed once) is past its window
  const f4 = S.routineFacts(conv, [weekly], asleep, BERLIN, opts);
  assert.match(f4.text, /weekly-review: did not run on 2026-10-23 \(the Mac was asleep past its time\); it will not be redone\. Tell Ben in one line/);
  S.markTold(conv, f4.told);
  assert.equal(S.routineFacts(conv, [weekly], new Date(asleep.getTime() + 60_000), BERLIN, opts).text, "", "told once, then quiet");
  assert.equal(S.readRecord(conv, "weekly-review")!.status, "skipped");
});

test("settling a look: delivered only when it finished; an attempt comes back only when the look was called off and nothing reached the person", () => {
  const conv = "friend-settle000000000";
  const start = () => S.markStarted(conv, "evening-wrap", "2026-11-02", 1_000);
  const none = new Set<string>();
  const readOf = () => S.readRecord(conv, "evening-wrap")!;
  S.routineFacts(conv, [evening], z("2026-11-02T09:00:00Z"), BERLIN, opts); // creates the record
  start();
  S.settleRoutines(conv, new Set(["evening-wrap"]), none, { calledOff: false, sends: 0 }, 2_000);
  assert.deepEqual([readOf().status, readOf().attempts], ["failed", 1]);
  start();
  S.settleRoutines(conv, new Set(["evening-wrap"]), none, { calledOff: true, sends: 0 }, 3_000);
  assert.deepEqual([readOf().status, readOf().attempts], ["failed", 1], "called off before anything left: the attempt is given back");
  start();
  S.settleRoutines(conv, new Set(["evening-wrap"]), none, { calledOff: true, sends: 1 }, 4_000);
  assert.deepEqual([readOf().status, readOf().attempts], ["failed", 2], "called off after a send: not given back");
  start();
  S.settleRoutines(conv, new Set(["evening-wrap"]), new Set(["evening-wrap"]), { calledOff: true, sends: 0 }, 5_000);
  assert.equal(readOf().status, "delivered");
});

// ---- routine notes ----
let n = 0;
const groupWith = (when: string | undefined, body = "Post a fun fact for the group.", file = "routine-fun-fact.md") => {
  const conv = group(`routine-group-${++n}-0123456789abcdef`);
  mkdirSync(conv.notesDir, { recursive: true });
  writeFileSync(join(conv.notesDir, file), `---\n${when === undefined ? "" : `when: ${when}\n`}---\n${body}\n`);
  return conv;
};
const ZONE = BERLIN;
const at = (iso: string) => z(iso);

test("a routine note in a group fires once at its time, is done when the look posted, and is due again the next day", () => {
  const conv = groupWith("every day at 08:00");
  const seen = F.factsFor(conv, at("2026-10-22T05:00:00Z"), "look"); // 07:00: first sight
  assert.equal(seen.routines, "");
  seen.done({ ended: true, said: false });
  const look = F.factsFor(conv, at("2026-10-22T06:05:00Z"), "look"); // 08:05
  assert.match(look.routines, /due now: Post a fun fact for the group\. \(routine routine-fun-fact, every day at 08:00\)\. Do it now yourself/);
  assert.equal(readRecord(conv.convId, "routine-fun-fact")?.status, "started");
  assert.equal(F.factsFor(conv, at("2026-10-22T06:06:00Z"), "look").routines, "", "pending in the look that has it: another look is not handed it too");
  look.done({ ended: true, said: true });
  assert.equal(readRecord(conv.convId, "routine-fun-fact")?.status, "delivered");
  assert.equal(F.factsFor(conv, at("2026-10-22T06:40:00Z"), "look").routines, "", "not again today");
  const next = F.factsFor(conv, at("2026-10-23T06:05:00Z"), "look");
  assert.match(next.routines, /due now: Post a fun fact/);
  next.done({ ended: true, said: true });
});

test("a routine note is done when the look ended well, silent or not; a failed or called-off look leaves it for the retry, then it is given up", () => {
  const conv = groupWith("every day at 08:00");
  F.factsFor(conv, at("2026-10-22T05:00:00Z"), "look").done({ ended: true, said: false });
  F.factsFor(conv, at("2026-10-22T06:05:00Z"), "look").done({ ended: true, said: false }); // it decided there was nothing to say
  assert.equal(readRecord(conv.convId, "routine-fun-fact")?.status, "delivered");
  const c = groupWith("every day at 08:00", "Do x", "routine-x.md");
  F.factsFor(c, at("2026-10-22T05:00:00Z"), "look").done({ ended: true, said: false });
  F.factsFor(c, at("2026-10-22T06:05:00Z"), "look").done({ ended: false, said: false });
  assert.equal(readRecord(c.convId, "routine-x")?.status, "failed");
  assert.match(F.factsFor(c, at("2026-10-22T06:20:00Z"), "look").routines, /the earlier attempt died/);
  const d = groupWith("every day at 08:00", "Do y", "routine-y.md");
  F.factsFor(d, at("2026-10-22T05:00:00Z"), "look").done({ ended: true, said: false });
  for (const m of [5, 15]) F.factsFor(d, at(`2026-10-22T06:${String(m).padStart(2, "0")}:00Z`), "look").done({ ended: false, said: false });
  assert.match(F.factsFor(d, at("2026-10-22T06:30:00Z"), "look").status.join("\n"), /routine-y: did not run on 2026-10-22 \(two attempts failed\)/);
});

test("a due routine makes the conversation's look due on the next tick: at its time, until handed over, and not once done", () => {
  const conv = groupWith("every day at 08:00");
  F.factsFor(conv, at("2026-10-22T05:00:00Z"), "look").done({ ended: true, said: false }); // first sight
  assert.equal(F.routinesWaiting(conv, at("2026-10-22T05:59:00Z")), false, "07:59: not yet");
  assert.equal(F.routinesWaiting(conv, at("2026-10-22T06:01:00Z")), true, "08:01: due");
  const look = F.factsFor(conv, at("2026-10-22T06:02:00Z"), "look");
  assert.equal(F.routinesWaiting(conv, at("2026-10-22T06:03:00Z")), false, "started: not due");
  look.done({ ended: true, said: true });
  assert.equal(F.routinesWaiting(conv, at("2026-10-22T06:10:00Z")), false, "done");
  assert.equal(F.routinesWaiting(conv, at("2026-10-22T11:00:00Z")), false);
  assert.equal(F.routinesWaiting(conv, at("2026-10-23T06:01:00Z")), true, "the next day");
});

test("a chat turn sees a routine note's status and never starts or records it; only the look runs it", () => {
  const conv = groupWith("every day at 08:00");
  F.factsFor(conv, at("2026-10-22T05:00:00Z"), "look").done({ ended: true, said: false });
  const chat = F.factsFor(conv, at("2026-10-22T06:05:00Z"), "chat");
  assert.match(chat.status.join("\n"), /Routines, status only[\s\S]*routine-fun-fact: due now; the next look runs it/);
  assert.equal(chat.routines, "");
  chat.done({ ended: true, said: true });
  assert.equal(readRecord(conv.convId, "routine-fun-fact")?.status, undefined);
  const look = F.factsFor(conv, at("2026-10-22T06:06:00Z"), "look");
  assert.match(look.routines, /due now: Post a fun fact/);
  look.done({ ended: true, said: true });
  assert.match(F.factsFor(conv, at("2026-10-22T06:30:00Z"), "chat").status.join("\n"), /routine-fun-fact: delivered /);
});

test("an unparseable when: is never silent: the status says so, the tool reply says so when the note is written, and the doctor line says it never runs", () => {
  const conv = groupWith("whenever you feel like it");
  const o = { skills: [] as string[], notesDir: conv.notesDir, zone: ZONE, now: at("2026-10-22T06:05:00Z") };
  const s = scheduledIn(o);
  assert.deepEqual(s.routines, []);
  assert.match(s.broken[0]!, /routine-fun-fact\.md has a when: line that cannot be read \(Cannot read the repeat rule "whenever you feel like it"/);
  assert.match(F.factsFor(conv, o.now, "chat").status.join("\n"), /Routine notes that will never run, fix their when: line[\s\S]*routine-fun-fact\.md has a when: line that cannot be read/);
  assert.match(F.factsFor(conv, o.now, "look").status.join("\n"), /will never run/);
  assert.match(scheduleLines(conv.convId, o)[0]!, /never runs/);
  const file = join(conv.notesDir, "routine-fun-fact.md");
  const bad = routineNoteReply("Write", { file_path: file }, conv.notesDir, ZONE, o.now)!;
  assert.match(bad, /This routine will NOT run: routine-fun-fact\.md has a when: line that cannot be read/);
  const none = groupWith(undefined);
  assert.match(routineNoteReply("Write", { file_path: join(none.notesDir, "routine-fun-fact.md") }, none.notesDir, ZONE, o.now)!, /has no `when:` line/);
  assert.match(scheduledIn({ ...o, notesDir: none.notesDir }).broken[0]!, /no `when:` line/);
  writeFileSync(file, "---\nwhen: every mon and thu at 9\n---\nSummarise my week.\n");
  assert.equal(routineNoteReply("Edit", { file_path: file }, conv.notesDir, ZONE, o.now), "Routine saved: every monday, thursday at 09:00, next today 09:00 (Europe/Berlin). Tell the person this schedule and when it runs next, in your own words.");
  assert.equal(routineNoteReply("Write", { file_path: join(conv.notesDir, "people-anna.md") }, conv.notesDir, ZONE, o.now), undefined, "only routine notes");
  assert.equal(routineNoteReply("Read", { file_path: file }, conv.notesDir, ZONE, o.now), undefined, "only writes");
  assert.equal(routineNoteReply("Write", { file_path: "/etc/routine-x.md" }, conv.notesDir, ZONE, o.now), undefined, "only inside the notes folder");
  assert.equal(scheduledIn({ ...o, notesDir: conv.notesDir }).routines[0]!.name, "routine-fun-fact");
});

test("editing a note's when: moves the next occurrence from then on", () => {
  const conv = groupWith("every day at 08:00");
  const o = { skills: [] as string[], notesDir: conv.notesDir, zone: ZONE, now: at("2026-10-22T06:05:00Z") };
  F.factsFor(conv, at("2026-10-22T05:00:00Z"), "look").done({ ended: true, said: false });
  F.factsFor(conv, o.now, "look").done({ ended: true, said: true });
  assert.match(scheduleLines(conv.convId, o)[0]!, /^routine-fun-fact: every day at 08:00, next tomorrow 08:00; last \d\d-\d\d \d\d:\d\d/);
  writeFileSync(join(conv.notesDir, "routine-fun-fact.md"), "---\nwhen: every weekday at 18:30\n---\nPost a fun fact for the group.\n");
  assert.match(scheduleLines(conv.convId, o)[0]!, /every weekday at 18:30, next today 18:30/);
  assert.equal(F.factsFor(conv, at("2026-10-22T06:30:00Z"), "look").routines, "", "nothing is due before the new time");
  assert.equal(F.factsFor(conv, at("2026-10-22T16:35:00Z"), "look").routines, "", "it already ran today (at the old time): the edit starts with the next occurrence");
  const next = F.factsFor(conv, at("2026-10-23T16:35:00Z"), "look");
  assert.match(next.routines, /due now: Post a fun fact[\s\S]*every weekday at 18:30/);
  next.done({ ended: true, said: true });
});

test("a note routine is for a conversation that has a look; skills are for the owner; the cap and an expired or inferred note", () => {
  const conv = groupWith("every day at 08:00");
  assert.equal(lookerOf(conv).skills.some((s) => /daily-brief/.test(s)), false, "a group has no scheduled skill");
  const o = { skills: lookerOf(owner()).skills, notesDir: conv.notesDir, zone: ZONE, now: at("2026-10-22T06:05:00Z") };
  assert.deepEqual(scheduledIn(o).routines.map((r) => r.name), ["daily-brief", "evening-wrap", "weekly-review", "routine-fun-fact"]);
  writeFileSync(join(conv.notesDir, "routine-old.md"), "---\nwhen: every day at 08:00\nexpires: 2026-10-01\n---\nOld.\n");
  assert.ok(!scheduledIn(o).routines.some((r) => r.name === "routine-old"), "past its expires: day");
  for (let i = 0; i < 25; i++) writeFileSync(join(conv.notesDir, `routine-z${String(i).padStart(2, "0")}.md`), "---\nwhen: every day at 08:00\n---\nz\n");
  assert.equal(scheduledIn({ ...o, skills: [] }).routines.length, 20);
});

test("ROUTINES_OFF switches a scheduled skill off; a bad name stops the agent", () => {
  assert.deepEqual(settings.routinesOff, []);
  assert.deepEqual(loadSettings({ ROUTINES_OFF: "evening-wrap, weekly-review" }).routinesOff, ["evening-wrap", "weekly-review"]);
  assert.throws(() => loadSettings({ ROUTINES_OFF: "Evening Wrap" }), /ROUTINES_OFF/);
  const mutable = settings as unknown as { routinesOff: string[] };
  mutable.routinesOff = ["evening-wrap"];
  try {
    assert.deepEqual(scheduledIn({ skills: lookerOf(owner()).skills, notesDir: join(process.env.HARNESS_DATA_DIR!, "none"), zone: ZONE, now: new Date() }).routines.map((r) => r.name), ["daily-brief", "weekly-review"]);
  } finally {
    mutable.routinesOff = [];
  }
});

test("the selfTimed text is gone from every prompt; the promise points at the when: note where the conversation has a look", () => {
  const OLD = /A check reads the notes every hour or so/;
  const withLook = new Set(GROUP_CAPABILITIES);
  const noLook = new Set([...GROUP_CAPABILITIES].filter((c) => c !== "wake" && c !== "heartbeat"));
  for (const [name, text] of [["chat", chatSystem(new Date())], ["group", groupSystem({ caps: withLook as never })], ["tenant", tenantSystem({ name: "Eve", caps: withLook as never, timed: true })]] as const) {
    assert.doesNotMatch(text, OLD, name);
    assert.match(text, /routine-<short-slug>\.md[\s\S]*`when:`/, `${name}: the when: note`);
  }
  assert.doesNotMatch(groupSystem({ caps: noLook as never }), /routine-<short-slug>/, "a group without a look is not promised one");
  assert.match(tenantSystem({ name: "Eve", caps: noLook as never, timed: false }), /You cannot act on your own later or on a schedule/);
  assert.doesNotMatch(lookInstruction(new Date(2026, 9, 14, 9, 0), undefined, lookerOf(owner())), /a note says is due|note asks for it and it is due/);
});

test("the look: facts are in the instruction only when there are some", () => {
  const looker = lookerOf(owner());
  const now = new Date(2026, 9, 14, 9, 0, 0);
  const plain = lookInstruction(now, undefined, looker);
  assert.doesNotMatch(plain, /Routines are things that happen at a set time/);
  const withFacts = lookInstruction(now, undefined, looker, "daily-brief: due now (every day at 07:30).");
  assert.match(withFacts, /Routines are things that happen at a set time[\s\S]*routine notes[\s\S]*daily-brief: due now \(every day at 07:30\)\./);
});

test("skills: all three are in the plugin, the owner is offered them, they are heavy (own expert) and never shared with a friend or a group", () => {
  const owned = ownerSkills();
  for (const s of ["evening-wrap", "weekly-review"]) {
    assert.ok(owned.includes(`${PLUGIN}:${s}`), `${s}: offered to the owner`);
    assert.ok(privateSkills().includes(s), `${s}: private`);
    assert.ok(expertSetup(owned, "").delegated.has(s), `${s}: delegated to expert-${s}`);
  }
  const everything = new Set(["chat", "mail", "calendar", "notion", "tasks", "weather", "draw", "browse"] as const);
  for (const s of skillsFor(everything as never)) assert.ok(!/evening-wrap|weekly-review/.test(s), `a friend or group never gets ${s}`);
  assert.equal(lookerOf(owner()).skills.includes(`${PLUGIN}:evening-wrap`), true);
  assert.ok(capabilitiesOf(owner()).has("heartbeat"));
});

test("/status lists every scheduled item with its next and last run", () => {
  const lines = S.routineLines("owner", all, z("2026-10-22T09:00:00Z"), BERLIN);
  assert.match(lines[1]!, /^evening-wrap: every weekday at 18:30, next today 18:30; last /);
  const text = statusText({ spentUsd: 1, limitUsd: 20, approvals: 0, down: [], routines: lines });
  assert.match(text, /\nRoutines: daily-brief: every day at 07:30, next tomorrow 07:30; last .* \| evening-wrap: every weekday at 18:30, next today 18:30; last .* \| weekly-review: every friday at 16:30, next tomorrow 16:30; last .*\.\nConnectors: none down\./);
  assert.doesNotMatch(statusText({ spentUsd: 1, limitUsd: 20, approvals: 0, down: [] }), /Routines/, "no facts, no line");
});

test("the catch-up window is at least an hour: 0 would make every routine late the moment its time passes", () => {
  assert.throws(() => loadSettings({ ROUTINE_CATCHUP_HOURS: "0" }), /ROUTINE_CATCHUP_HOURS must be a number from 1 to 24/);
  assert.equal(loadSettings({ ROUTINE_CATCHUP_HOURS: "1" }).routineCatchUpHours, 1);
  assert.equal(loadSettings({}).routineCatchUpHours, 4);
});

test("the wrap and the review: their experts have exactly the read tools, the calendar reads, Skill and the chat send; no email, no write_note, status note, task writes or seen_mail", () => {
  const set = expertSetup(ownerSkills(), "");
  for (const s of ["evening-wrap", "weekly-review"]) {
    const tools = set.agents[`expert-${s}`]!.tools;
    assert.ok(tools, `${s}: a tool allowlist, not the run's whole set`);
    assert.deepEqual([...tools].sort(), [
      "Skill", "mcp__claude_ai_Google_Calendar__get_event", "mcp__claude_ai_Google_Calendar__list_calendars", "mcp__claude_ai_Google_Calendar__list_events",
      "mcp__claude_ai_Google_Calendar__search_events", "mcp__notes__journal", "mcp__send__send", "mcp__tasks__list_tasks",
    ]);
    for (const banned of ["mcp__notes__write_note", "mcp__status__write_status_note", "mcp__tasks__add_task", "mcp__tasks__complete_task", "mcp__tasks__update_task", "mcp__meetings__note_upcoming_meetings", "mcp__seenmail__seen_mail", "Bash", "Write", "Edit"]) {
      assert.ok(!tools.includes(banned), `${s}: cannot call ${banned}`);
    }
    assert.deepEqual(set.agents[`expert-${s}`]!.disallowedTools, ["Agent"]);
  }
});
