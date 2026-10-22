import { test } from "node:test";
import assert from "node:assert/strict";

// Repeat rules and local-time arithmetic for tasks (src/tasks/repeat.ts, when.ts): the grammar, the canonical text, the next firing, and the clock-change days.

const { formatRepeat, nextDate, nextDue, nextInstant, occursOn, parseRepeat } = await import("../src/tasks/repeat.ts");
const W = await import("../src/tasks/when.ts");

const ok = (text: string) => {
  const p = parseRepeat(text);
  assert.ok(p.ok, `"${text}" should parse: ${p.ok ? "" : p.error}`);
  return p as Extract<typeof p, { ok: true }>;
};

test("the grammar: many ways to write a rule, one canonical text", () => {
  const cases: [string, string][] = [
    ["every day", "every day"],
    ["Daily", "every day"],
    ["every  DAY at 9", "every day at 09:00"],
    ["every weekday", "every weekday"],
    ["weekdays at 8:30", "every weekday at 08:30"],
    ["every weekend", "every weekend"],
    ["every monday 09:00", "every monday at 09:00"],
    ["every Monday at 9am", "every monday at 09:00"],
    ["every mon, wed and fri", "every monday, wednesday, friday"],
    ["every fri & mon", "every monday, friday"],
    ["mondays", "every monday"],
    ["every week", "every week"],
    ["weekly", "every week"],
    ["weekly on tuesday", "every tuesday"],
    ["every 2 weeks", "every 2 weeks"],
    ["every other week", "every 2 weeks"],
    ["fortnightly", "every 2 weeks"],
    ["biweekly on thursday", "every 2 weeks on thursday"],
    ["every 3 days", "every 3 days"],
    ["every other day", "every 2 days"],
    ["monthly on 1st", "every month on the 1st"],
    ["monthly on the 15th at 6pm", "every month on the 15th at 18:00"],
    ["every month on the 22nd", "every month on the 22nd"],
    ["every month on the 3rd", "every month on the 3rd"],
    ["every month on the 11th", "every month on the 11th"],
    ["every month on the last day", "every month on the last day"],
    ["monthly on last", "every month on the last day"],
    ["every 3 months on the 1st", "every 3 months on the 1st"],
    ["every first monday of the month", "every month on the first monday"],
    ["monthly on the last friday", "every month on the last friday"],
    ["every month", "every month"],
    ["yearly", "every year"],
    ["annually on feb 14", "every year on 14 feb"],
    ["every year on 14 february", "every year on 14 feb"],
    ["every 14th of march", "every year on 14 mar"],
    ["every 2 years", "every 2 years"],
    ["every day at noon", "every day at 12:00"],
    ["every day at 12am", "every day at 00:00"],
    ["every day at 12pm", "every day at 12:00"],
    ["every sun, mon, tue, wed, thu, fri, sat", "every day"],
  ];
  for (const [input, canonical] of cases) assert.equal(ok(input).text, canonical, input);
});

test("the canonical text parses back to the same rule", () => {
  for (const input of ["every weekday at 07:15", "every 2 weeks on monday, thursday", "every month on the last day", "every month on the second tuesday at 10:00", "every year on 29 feb", "every 5 days", "every 3 months on the 31st", "every weekend"]) {
    const p = ok(input);
    const again = ok(p.text);
    assert.deepEqual(again.rule, p.rule, input);
    assert.equal(again.text, p.text);
  }
});

test("a rule that is not in the grammar is refused with the forms to use", () => {
  for (const input of ["", "   ", "whenever", "every", "every blursday", "every 0 days", "every 400 days", "every 60 weeks", "every 25 months", "every 11 years", "every day on monday", "every month on the 32nd", "every year on 30 feb", "every day at 25:00", "every day at 9:75", "every day at 9 at 10", "every 13th", "every month on the zeroth monday", "x".repeat(200)]) {
    const p = parseRepeat(input);
    assert.equal(p.ok, false, `"${input.slice(0, 30)}" should be refused`);
    if (!p.ok) assert.match(p.error, /repeat|skip/i);
  }
});

test("which dates a rule fires on: days, weeks, months, years from an anchor", () => {
  const every2w = ok("every 2 weeks").rule;
  assert.equal(occursOn(every2w, "2026-10-05", "2026-10-05"), true);
  assert.equal(occursOn(every2w, "2026-10-12", "2026-10-05"), false);
  assert.equal(occursOn(every2w, "2026-10-19", "2026-10-05"), true);
  assert.equal(occursOn(every2w, "2026-10-20", "2026-10-05"), false, "the anchor's weekday only");
  assert.equal(occursOn(every2w, "2026-09-21", "2026-10-05"), true, "before the anchor too");
  const wd = ok("every weekday").rule;
  assert.deepEqual([...Array(7)].map((_, i) => occursOn(wd, W.addDays("2026-10-19", i), "2026-10-19")), [true, true, true, true, true, false, false]);
  const e3 = ok("every 3 days").rule;
  assert.deepEqual([0, 1, 2, 3, 6].map((n) => occursOn(e3, W.addDays("2026-10-01", n), "2026-10-01")), [true, false, false, true, true]);
  const mon2 = ok("every 2 weeks on monday, friday").rule;
  assert.equal(occursOn(mon2, "2026-10-09", "2026-10-05"), true, "the same week");
  assert.equal(occursOn(mon2, "2026-10-16", "2026-10-05"), false, "the off week");
  assert.equal(occursOn(mon2, "2026-10-23", "2026-10-05"), true);
});

test("months: the day, the last day, the 31st clamped, the nth weekday; years: 29 February", () => {
  const first = ok("monthly on 1st").rule;
  assert.equal(nextDate(first, "2026-10-02", "2026-10-01"), "2026-11-01");
  const day31 = ok("every month on the 31st").rule;
  assert.deepEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"].map((d) => occursOn(day31, d, "2026-01-31")), [true, true, true, true, true]);
  assert.equal(occursOn(day31, "2026-04-29", "2026-01-31"), false);
  assert.equal(nextDate(day31, "2026-02-01", "2026-01-31"), "2026-02-28");
  assert.equal(nextDate(day31, "2028-02-01", "2026-01-31"), "2028-02-29", "a leap February's last day");
  const last = ok("every month on the last day").rule;
  assert.equal(nextDate(last, "2026-11-01", "2026-10-01"), "2026-11-30");
  const mondayFirst = ok("every month on the first monday").rule;
  assert.equal(nextDate(mondayFirst, "2026-10-01", "2026-10-01"), "2026-10-05");
  assert.equal(nextDate(mondayFirst, "2026-10-06", "2026-10-01"), "2026-11-02");
  const lastFri = ok("every month on the last friday").rule;
  assert.equal(nextDate(lastFri, "2026-10-01", "2026-10-01"), "2026-10-30");
  assert.equal(nextDate(lastFri, "2026-10-31", "2026-10-01"), "2026-11-27");
  const q = ok("every 3 months on the 1st").rule;
  assert.equal(nextDate(q, "2026-10-02", "2026-10-01"), "2027-01-01");
  const leap = ok("every year on 29 feb").rule;
  assert.equal(nextDate(leap, "2026-01-01", "2024-02-29"), "2026-02-28", "28 Feb in a year without a 29th");
  assert.equal(nextDate(leap, "2028-01-01", "2024-02-29"), "2028-02-29");
  const yearly = ok("every 2 years on 14 feb").rule;
  assert.equal(nextDate(yearly, "2026-03-01", "2026-02-14"), "2028-02-14");
});

test("completing a repeating task: the next due after both its due date and today, in the same form", () => {
  const weekly = ok("every monday").rule;
  assert.equal(nextDue(weekly, "2026-10-19", "2026-10-19"), "2026-10-26", "done on its day");
  assert.equal(nextDue(weekly, "2026-10-19", "2026-10-21"), "2026-10-26", "done late: the missed ones do not pile up");
  assert.equal(nextDue(weekly, "2026-10-19", "2026-11-12"), "2026-11-16", "done very late");
  assert.equal(nextDue(weekly, "2026-10-26", "2026-10-22"), "2026-11-02", "done early: the one after its due date");
  assert.equal(nextDue(ok("every day at 08:00").rule, "2026-10-19", "2026-10-19"), "2026-10-20T08:00", "the rule's time joins a date");
  assert.equal(nextDue(ok("every day").rule, "2026-10-19T14:30", "2026-10-19"), "2026-10-20T14:30", "the task's own time stays");
  assert.equal(nextDue(ok("every 2 weeks").rule, "2026-10-05", "2026-10-09"), "2026-10-19", "the interval stays counted from the due date");
  assert.equal(nextDue(ok("every weekday").rule, "2026-10-23", "2026-10-23"), "2026-10-26", "Friday to Monday");
});

test("local dates: real dates only, weekdays, weeks from Monday, showing a date", () => {
  assert.equal(W.parseDate("2026-02-30"), undefined);
  assert.equal(W.parseDate("2026-2-3"), undefined);
  assert.deepEqual(W.parseDate("2028-02-29"), { year: 2028, month: 2, day: 29 });
  assert.equal(W.parseLocal("2026-10-24T14:30")?.time, "14:30");
  assert.equal(W.parseLocal("2026-10-24T24:00"), undefined);
  assert.equal(W.parseLocal("2026-10-24 14:30"), undefined);
  assert.equal(W.parseLocal("2026-10-24T14:30:00Z"), undefined);
  assert.equal(W.weekdayOf("2026-10-22"), 4, "a Thursday");
  assert.equal(W.weekIndex("2026-10-25"), W.weekIndex("2026-10-19"), "Monday to Sunday is one week");
  assert.equal(W.weekIndex("2026-10-26"), W.weekIndex("2026-10-19") + 1);
  assert.equal(W.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(W.showLocal("2026-10-24", "2026-10-22"), "Sat 24 Oct");
  assert.equal(W.showLocal("2027-01-02T09:00", "2026-10-22"), "Sat 2 Jan 2027 09:00");
});

// Europe/Berlin: clocks forward 2026-03-29 02:00 -> 03:00, back 2026-10-25 03:00 -> 02:00. America/New_York: forward 2026-03-08, back 2026-11-01.
test("a wall time becomes an instant: plain days, the skipped hour moves forward, the repeated hour is the first", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  assert.equal(iso(W.wallToUtc("Europe/Berlin", "2026-01-15", "09:00")), "2026-01-15T08:00:00.000Z");
  assert.equal(iso(W.wallToUtc("Europe/Berlin", "2026-07-15", "09:00")), "2026-07-15T07:00:00.000Z");
  assert.equal(iso(W.wallToUtc("Europe/Berlin", "2026-03-29", "02:30")), "2026-03-29T01:30:00.000Z", "02:30 does not exist: 03:30 on the new clock");
  assert.equal(W.localOf(W.wallToUtc("Europe/Berlin", "2026-03-29", "02:30"), "Europe/Berlin").time, "03:30");
  assert.equal(iso(W.wallToUtc("Europe/Berlin", "2026-10-25", "02:30")), "2026-10-25T00:30:00.000Z", "02:30 happens twice: the first");
  assert.equal(iso(W.wallToUtc("Europe/Berlin", "2026-10-25", "03:30")), "2026-10-25T02:30:00.000Z", "after the repeated hour");
  assert.equal(iso(W.wallToUtc("America/New_York", "2026-03-08", "02:30")), "2026-03-08T07:30:00.000Z");
  assert.equal(iso(W.wallToUtc("America/New_York", "2026-11-01", "01:30")), "2026-11-01T05:30:00.000Z", "the first 01:30 (EDT)");
  assert.equal(iso(W.wallToUtc("Asia/Kolkata", "2026-10-22", "09:00")), "2026-10-22T03:30:00.000Z", "a half-hour offset");
  assert.equal(iso(W.wallToUtc("Pacific/Auckland", "2026-09-27", "02:30")), "2026-09-26T14:30:00.000Z", "southern hemisphere: forward in September");
  assert.equal(iso(W.wallToUtc("UTC", "2026-10-22", "23:59")), "2026-10-22T23:59:00.000Z");
});

test("every day at 09:00 is 09:00 on the clock across both clock changes", () => {
  const rule = ok("every day at 09:00").rule;
  for (const zone of ["Europe/Berlin", "America/New_York", "Australia/Sydney", "Asia/Kolkata"]) {
    let at = Date.parse("2026-02-01T00:00:00Z");
    let last = 0;
    for (let i = 0; i < 400; i++) {
      at = nextInstant(rule, at, zone, "2026-01-01");
      assert.ok(at > last, "strictly later each time");
      last = at;
      assert.equal(W.localOf(at, zone).time, "09:00", `${zone} ${new Date(at).toISOString()}`);
    }
  }
});

test("the next firing is strictly after the instant, later today when it is still ahead", () => {
  const rule = ok("every monday at 09:00").rule;
  const zone = "Europe/Berlin";
  const monday8 = W.wallToUtc(zone, "2026-10-19", "08:00");
  const monday9 = W.wallToUtc(zone, "2026-10-19", "09:00");
  assert.equal(nextInstant(rule, monday8, zone, "2026-10-19"), monday9, "today, still ahead");
  assert.equal(nextInstant(rule, monday9, zone, "2026-10-19"), W.wallToUtc(zone, "2026-10-26", "09:00"), "now is not after now");
  assert.equal(nextInstant(rule, monday9 + 1, zone, "2026-10-19"), W.wallToUtc(zone, "2026-10-26", "09:00"));
  // a rule with no time uses the default
  assert.equal(W.localOf(nextInstant(ok("every weekday").rule, monday9, zone, "2026-10-19"), zone).time, "09:00");
  assert.equal(W.localOf(nextInstant(ok("every weekday").rule, monday9, zone, "2026-10-19", "18:30"), zone).time, "18:30", "the caller's default time, today: it is still ahead");
});

test("a daily rule at a time the clocks skip fires at the moved time that day and normally after", () => {
  const rule = ok("every day at 02:30").rule;
  const zone = "Europe/Berlin";
  const day = (d: string) => W.localOf(nextInstant(rule, W.wallToUtc(zone, d, "00:00") - 1, zone, "2026-03-01"), zone);
  assert.deepEqual(day("2026-03-28"), { date: "2026-03-28", time: "02:30" });
  assert.deepEqual(day("2026-03-29"), { date: "2026-03-29", time: "03:30" }, "the skipped time moves forward, the day is not lost");
  assert.deepEqual(day("2026-03-30"), { date: "2026-03-30", time: "02:30" });
});

test("weekly across the end of the year and a leap day", () => {
  const rule = ok("every friday").rule;
  assert.equal(nextDate(rule, "2026-12-29", "2026-10-02"), "2027-01-01");
  assert.equal(nextDate(ok("every day").rule, "2028-02-28", "2028-01-01"), "2028-02-28");
  assert.equal(W.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(W.addDays("2026-02-28", 1), "2026-03-01");
});
