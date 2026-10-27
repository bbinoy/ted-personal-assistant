import { addDays, daysBetween, daysInMonth, epochDay, fromEpochDay, localOf, mod, parseDate, parseLocal, weekdayOf, weekIndex, wallToUtc } from "./when.ts";
import { pad } from "../core/timezone.ts";

// Repeat rules: "every monday 09:00", "every weekday", "every 2 weeks", "monthly on 1st" as a small closed grammar, parsed to a Rule and back to ONE canonical text (so what is stored reads the same
// however it was written), and the next time a rule fires. Pure: no clock, no zone except where a wall time becomes an instant (wallToUtc, DST-safe), so the reminders that fire later (T2) and the
// completion of a repeating task use exactly this and nothing else.
//
// Grammar (case and extra spaces do not matter; a trailing "at 9", "at 09:00", "at 9pm" or "9:30" is the time of day):
//   every day | daily | every N days | every other day
//   every weekday | every weekend | every monday | every mon, wed and fri | weekly | every week [on monday] | every N weeks [on monday, thursday] | every other week | fortnightly
//   every month | monthly | every N months, each with  on the 1st | on the 15th | on the last day | on the first monday | on the last friday     (also: every first monday of the month)
//   every year | yearly | annually | every N years, with  on 14 feb | on feb 14                                                                     (also: every 14 feb)
//   any of them may end with an IANA time zone, "every day at 08:00 Europe/Zurich": the rule then runs on that clock, otherwise on the conversation's
// The interval counts from an ANCHOR date (the task's due date, else the day it was made): "every 2 weeks" from Monday 5 Oct fires on 19 Oct, 2 Nov... A day-of-month beyond the month's end
// (the 31st in April) fires on the month's last day; 29 Feb fires on 28 Feb in a year without one.

export interface Rule {
  unit: "day" | "week" | "month" | "year";
  interval: number;
  weekdays?: number[]; // week: which days (0 = Sunday), sorted; absent: the anchor's weekday
  monthDay?: number | "last"; // month: the day of the month; absent (and no nth): the anchor's
  nth?: { n: 1 | 2 | 3 | 4 | -1; weekday: number }; // month: the first, second... or last <weekday> of the month
  month?: number; // year: with day; absent: the anchor's
  day?: number;
  time?: string; // "HH:MM", local; absent: the caller's default (the task's own time, else the reminder default)
  zone?: string; // IANA zone the rule runs in ("Europe/Zurich"); absent: the conversation's
}

export type Parsed = { ok: true; rule: Rule; text: string } | { ok: false; error: string };

const MAX_INTERVAL = { day: 365, week: 52, month: 24, year: 10 } as const;
const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const WD: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6, ...Object.fromEntries(WEEKDAY_NAMES.map((n, i) => [n, i])) };
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] as const;
const MON: Record<string, number> = { ...Object.fromEntries(MONTH_NAMES.map((n, i) => [n, i + 1])), ...Object.fromEntries(MONTH_NAMES.map((n, i) => [n.slice(0, 3), i + 1])), sept: 9 };
const ORD: Record<string, 1 | 2 | 3 | 4 | -1> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, last: -1 };
const ORD_NAME: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };
export const USAGE = "a repeat rule like: every day, every weekday, every monday, every mon and thu, every 2 weeks, every month on the 1st, every month on the last friday, every year on 14 feb (add 'at 09:00' for a time)";

const bad = (text: string): Parsed => ({ ok: false, error: `Cannot read the repeat rule "${text.slice(0, 80)}". Use ${USAGE}.` });
// A zone as people write it ("europe/zurich"), as Intl names it ("Europe/Zurich"); undefined when Intl does not know it.
const zoneName = (z: string): string | undefined => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
const wdKey = (w: string): number | undefined => WD[w] ?? WD[w.replace(/s$/, "")];

// The time of day in a rule's text: "at 9", "at 09:00", "at 9pm", "9:30", "at noon". At most one; the text without it.
function takeTime(s: string): { rest: string; time?: string } | { error: string } {
  const re = /\bat\s+(noon|midnight)\b|\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?(?!\w)|\bat\s+(\d{1,2})\s*(am|pm)?(?!\w)|\b(\d{1,2})\s*(am|pm)(?!\w)/g;
  const found = [...s.matchAll(re)];
  if (!found.length) return { rest: s };
  if (found.length > 1) return { error: "more than one time of day" };
  const m = found[0]!;
  let h: number, min: number;
  if (m[1]) [h, min] = [m[1] === "noon" ? 12 : 0, 0];
  else {
    const hour = Number(m[2] ?? m[5] ?? m[7]);
    const ap = m[4] ?? m[6] ?? m[8];
    min = Number(m[3] ?? 0);
    if (ap) {
      if (hour < 1 || hour > 12) return { error: "that time of day" };
      h = (hour % 12) + (ap === "pm" ? 12 : 0);
    } else h = hour;
  }
  if (h > 23 || min > 59) return { error: "that time of day" };
  return { rest: `${s.slice(0, m.index)} ${s.slice(m.index! + m[0].length)}`.replace(/\s+/g, " ").trim(), time: `${pad(h)}:${pad(min)}` };
}

const SYNONYMS: [RegExp, string][] = [
  [/^daily\b/, "every day"],
  [/^weekly\b/, "every week"],
  [/^monthly\b/, "every month"],
  [/^(yearly|annually)\b/, "every year"],
  [/^(fortnightly|biweekly)\b/, "every 2 weeks"],
  [/^weekdays\b/, "every weekday"],
  [/^weekends\b/, "every weekend"],
  [/^each\b/, "every"],
];

// A list of weekdays: "monday", "mon, wed and fri", "weekdays", "weekend". Undefined when any word is not one.
function weekdayList(s: string): number[] | undefined {
  const words = s.replace(/&/g, " ").split(/[\s,]+/).filter((w) => w && w !== "and");
  if (!words.length) return undefined;
  const out = new Set<number>();
  for (const w of words) {
    if (w === "weekday" || w === "weekdays") [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (w === "weekend" || w === "weekends") [0, 6].forEach((d) => out.add(d));
    else {
      const d = wdKey(w);
      if (d === undefined) return undefined;
      out.add(d);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const dayOfMonth = (s: string): number | undefined => {
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 31 ? Number(m[1]) : undefined;
};

// "14 feb" / "feb 14" / "14th of february": the year rule's date.
function monthDate(s: string): { month: number; day: number } | undefined {
  const m = /^(?:the\s+)?(?:(\d{1,2}(?:st|nd|rd|th)?)\s+(?:of\s+)?([a-z]+)|([a-z]+)\s+(\d{1,2}(?:st|nd|rd|th)?))$/.exec(s);
  if (!m) return undefined;
  const month = MON[(m[2] ?? m[3])!];
  const day = dayOfMonth((m[1] ?? m[4])!);
  return month && day && day <= daysInMonth(2024, month) ? { month, day } : undefined; // (2024 has a 29 Feb)
}

function finish(rule: Rule, time: string | undefined): Parsed {
  const r: Rule = { ...rule, ...(time ? { time } : {}), ...(zoneNow ? { zone: zoneNow } : {}) };
  if (r.interval < 1 || r.interval > MAX_INTERVAL[r.unit]) return { ok: false, error: `A repeat rule can skip at most ${MAX_INTERVAL[r.unit]} ${r.unit}s (every ${r.interval} ${r.unit}s is too many or too few).` };
  if (r.unit === "week" && r.interval === 1 && r.weekdays?.length === 7) return finish({ unit: "day", interval: 1 }, time); // (every day of the week is every day)
  return { ok: true, rule: r, text: formatRepeat(r) };
}

let zoneNow: string | undefined; // (the zone of the rule being parsed: parseRepeat is synchronous, finish reads it)

/** A repeat rule as written by a person or a model, to a Rule and its canonical text; or what was wrong with it. */
export function parseRepeat(input: string): Parsed {
  if (typeof input !== "string" || input.length > 120) return bad(String(input).slice(0, 80));
  let s = input.toLowerCase().replace(/[.;]/g, " ").replace(/\s+/g, " ").trim().replace(/^(repeats?|repeating)\s+/, "");
  if (!s) return bad(input);
  zoneNow = undefined;
  const z = /\s+([a-z_]+(?:\/[a-z0-9_+-]+)+)$/.exec(s);
  if (z) {
    zoneNow = zoneName(z[1]!);
    if (!zoneNow) return { ok: false, error: `The repeat rule "${input.slice(0, 80)}" names a time zone that does not exist ("${z[1]}"). Use an IANA zone like Europe/Zurich.` };
    s = s.slice(0, z.index).trim();
  }
  const t = takeTime(s);
  if ("error" in t) return { ok: false, error: `The repeat rule "${input.slice(0, 80)}" has ${t.error}. Use ${USAGE}.` };
  s = t.rest;
  for (const [re, to] of SYNONYMS) if (re.test(s)) s = s.replace(re, to);
  if (!s.startsWith("every ")) {
    // "monday", "mon and thu": a bare weekday list is every <those days>; anything else is not a rule
    const days = weekdayList(s);
    if (!days) return bad(input);
    s = `every ${s}`;
  }
  let rest = s.slice("every ".length).trim();

  // every first monday of the month / every last friday
  const nthM = /^(first|second|third|fourth|last|1st|2nd|3rd|4th)\s+([a-z]+)(?:\s+of\s+(?:the|each|every)\s+month)?$/.exec(rest);
  if (nthM && wdKey(nthM[2]!) !== undefined) return finish({ unit: "month", interval: 1, nth: { n: ORD[nthM[1]!]!, weekday: wdKey(nthM[2]!)! } }, t.time);
  // every 14 feb / every feb 14
  const yd = monthDate(rest);
  if (yd) return finish({ unit: "year", interval: 1, ...yd }, t.time);

  let unit: Rule["unit"] | undefined;
  let interval = 1;
  let m: RegExpExecArray | null;
  if ((m = /^other\s+(day|week|month|year)s?\b\s*(.*)$/.exec(rest))) [unit, interval, rest] = [m[1] as Rule["unit"], 2, m[2]!];
  else if ((m = /^(\d{1,3})\s*(day|week|month|year)s?\b\s*(.*)$/.exec(rest))) [unit, interval, rest] = [m[2] as Rule["unit"], Number(m[1]), m[3]!];
  else if ((m = /^(day|week|month|year)\b\s*(.*)$/.exec(rest))) [unit, rest] = [m[1] as Rule["unit"], m[2]!];
  if (!unit) {
    // every monday / every mon, wed and fri / every weekday / every weekend
    const days = weekdayList(rest);
    return days ? finish({ unit: "week", interval: 1, weekdays: days }, t.time) : bad(input);
  }
  rest = rest.replace(/^on\s+/, "").replace(/^the\s+/, "").trim();
  switch (unit) {
    case "day":
      return rest ? bad(input) : finish({ unit, interval }, t.time);
    case "week": {
      if (!rest) return finish({ unit, interval }, t.time);
      const days = weekdayList(rest);
      return days ? finish({ unit, interval, weekdays: days }, t.time) : bad(input);
    }
    case "month": {
      if (!rest) return finish({ unit, interval }, t.time);
      if (/^last(\s+day)?(\s+of\s+(the|each|every)\s+month)?$/.test(rest)) return finish({ unit, interval, monthDay: "last" }, t.time);
      const n = /^([a-z0-9]+)\s+([a-z]+)$/.exec(rest);
      if (n && ORD[n[1]!] && wdKey(n[2]!) !== undefined) return finish({ unit, interval, nth: { n: ORD[n[1]!]!, weekday: wdKey(n[2]!)! } }, t.time);
      const d = dayOfMonth(rest.replace(/\s+day$/, ""));
      return d ? finish({ unit, interval, monthDay: d }, t.time) : bad(input);
    }
    default: {
      if (!rest) return finish({ unit, interval }, t.time);
      const d = monthDate(rest);
      return d ? finish({ unit, interval, ...d }, t.time) : bad(input);
    }
  }
}

/** The canonical text of a rule: parseRepeat(formatRepeat(r)) is r. */
export function formatRepeat(r: Rule): string {
  const every = r.interval === 1 ? `every ${r.unit}` : `every ${r.interval} ${r.unit}s`;
  let base = every;
  if (r.unit === "week" && r.weekdays) {
    const key = r.weekdays.join(",");
    const names = r.weekdays.map((d) => WEEKDAY_NAMES[d]!).join(", ");
    base = r.interval === 1 ? (key === "1,2,3,4,5" ? "every weekday" : key === "0,6" ? "every weekend" : `every ${names}`) : `${every} on ${names}`;
  } else if (r.unit === "month") {
    if (r.monthDay === "last") base = `${every} on the last day`;
    else if (r.monthDay) base = `${every} on the ${ordinal(r.monthDay)}`;
    else if (r.nth) base = `${every} on the ${ORD_NAME[r.nth.n]} ${WEEKDAY_NAMES[r.nth.weekday]}`;
  } else if (r.unit === "year" && r.month && r.day) base = `${every} on ${r.day} ${MONTH_NAMES[r.month - 1]!.slice(0, 3)}`;
  return `${r.time ? `${base} at ${r.time}` : base}${r.zone ? ` ${r.zone}` : ""}`;
}

/** Does the rule fire on this date? `anchor`: the date the interval counts from. */
export function occursOn(rule: Rule, date: string, anchor: string): boolean {
  const d = parseDate(date)!;
  const a = parseDate(anchor)!;
  switch (rule.unit) {
    case "day":
      return mod(daysBetween(anchor, date), rule.interval) === 0;
    case "week":
      return (rule.weekdays ?? [weekdayOf(anchor)]).includes(weekdayOf(date)) && mod(weekIndex(date) - weekIndex(anchor), rule.interval) === 0;
    case "month": {
      if (mod((d.year - a.year) * 12 + d.month - a.month, rule.interval) !== 0) return false;
      const last = daysInMonth(d.year, d.month);
      if (rule.nth) {
        if (weekdayOf(date) !== rule.nth.weekday) return false;
        return rule.nth.n === -1 ? d.day + 7 > last : Math.ceil(d.day / 7) === rule.nth.n;
      }
      const want = rule.monthDay === "last" ? last : Math.min(rule.monthDay ?? a.day, last);
      return d.day === want;
    }
    default: {
      if (mod(d.year - a.year, rule.interval) !== 0) return false;
      const month = rule.month ?? a.month;
      return d.month === month && d.day === Math.min(rule.day ?? a.day, daysInMonth(d.year, month));
    }
  }
}

const SCAN_DAYS = 4000; // (ten years of the widest rule, with room)

/** The first date on or after `from` that the rule fires on. */
export function nextDate(rule: Rule, from: string, anchor: string): string {
  const start = epochDay(from);
  for (let i = 0; i < SCAN_DAYS; i++) {
    const d = fromEpochDay(start + i);
    if (occursOn(rule, d, anchor)) return d;
  }
  throw new Error(`repeat: no occurrence of "${formatRepeat(rule)}" within ${SCAN_DAYS} days`);
}

/**
 * The first firing strictly after an instant, as an instant, in the zone's local time (a rule without a time uses `defaultTime`). DST-safe: the wall time is turned into an instant by wallToUtc
 * (a time skipped by the clocks moves forward, a repeated one is the first), so "every day at 09:00" is 09:00 on the clock every day of the year.
 */
export function nextInstant(rule: Rule, afterMs: number, conversationZone: string, anchor: string, defaultTime = "09:00"): number {
  const zone = rule.zone ?? conversationZone; // (the rule's own zone, when it names one)
  const time = rule.time ?? defaultTime;
  let d = nextDate(rule, localOf(afterMs, zone).date, anchor);
  for (let i = 0; i < 4; i++) {
    const at = wallToUtc(zone, d, time);
    if (at > afterMs) return at;
    d = nextDate(rule, addDays(d, 1), anchor);
  }
  throw new Error("repeat: no later occurrence");
}

/**
 * A repeating task is done: its next due, in the same form as the current one (a date, or a date with a time). The next occurrence after the current due date AND after today: finishing a
 * weekly task on its Monday gives next Monday; finishing it late on a Wednesday gives next Monday too (it does not pile up the ones missed); finishing it early gives the one after its due date.
 * The interval stays counted from the current due date.
 */
export function nextDue(rule: Rule, due: string, today: string): string {
  const cur = parseLocal(due)!;
  const after = epochDay(cur.date) > epochDay(today) ? cur.date : today;
  const date = nextDate(rule, addDays(after, 1), cur.date);
  const time = rule.time ?? cur.time;
  return time ? `${date}T${time}` : date;
}
