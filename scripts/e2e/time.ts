// The frozen clock of an end-to-end case, in the case's zone.
import { instantOf, isoIn } from "./fakeserver.ts";
import type { Time } from "./case.ts";

const DAY = 86_400_000;

export function makeTime(now: Date, zone: string): Time {
  const dateOf = (ms: number): string => isoIn(ms, zone).slice(0, 10);
  const today = dateOf(now.getTime());
  const plus = (date: string, days: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
  return {
    now,
    zone,
    today,
    day: (offset) => plus(today, offset),
    nextWeekday: (weekday, includeToday = false) => {
      for (let i = includeToday ? 0 : 1; i < 8; i++) if (new Date(`${plus(today, i)}T12:00:00Z`).getUTCDay() === weekday) return plus(today, i);
      throw new Error("no such weekday");
    },
    local: (date, hhmm) => `${date}T${hhmm}:00`,
    at: (date, hhmm) => instantOf(`${date}T${hhmm}:00`, zone),
    hhmm: (ms) => isoIn(ms, zone).slice(11, 16),
    dateOf,
  };
}
