import { inQuietHours } from "./actions.ts";

// The times of day a conversation's notes name ("post a fun fact at 9:40", "ab 18 Uhr", "5pm", "noon"). One extraction
// serves two readers: the idle fingerprint (gate.ts: a quiet look is repeated only when a named time has passed or
// something real changed) and the quiet-hours rule for groups (wake.ts: at night a group is only looked at when its
// notes name a time inside the quiet window). Pure, never throws. It reads loosely on purpose: a time found that was
// not one only costs an extra look, a time missed would cost a missed schedule.

export interface NamedTime {
  at: number; // minutes since midnight, as written
  alt?: number; // a bare hour ("at 5") may also mean the afternoon: that reading
}

// Any hint of a time of day, also when no time could be pulled out of it ("o'clock" alone). The safety net: the notes
// then count as time-sensitive and the fingerprint keeps changing every minute.
export const TIME_HINT = /\d{1,2}[:.]\d{2}|\b\d{1,2}\s?(am|pm|h|uhr)\b|\b(at|um|ab|from|until|by|before|after)\s+\d{1,2}\b|o'clock|noon|midnight|mittag/i;

const ok = (h: number, m: number) => h >= 0 && h < 24 && m >= 0 && m < 60;

export function namedTimes(text: string): NamedTime[] {
  const out = new Map<string, NamedTime>();
  const add = (t: NamedTime) => void out.set(`${t.at}/${t.alt ?? ""}`, t);
  const withSuffix = (h: number, m: number, suffix: string | undefined): number | undefined => {
    const s = suffix?.toLowerCase();
    if (s === "pm" && h >= 1 && h <= 11) h += 12;
    else if (s === "am" && h === 12) h = 0;
    return ok(h, m) ? h * 60 + m : undefined;
  };
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)\s?(am|pm)?/gi)) {
    const at = withSuffix(Number(m[1]), Number(m[2]), m[3]);
    if (at !== undefined) add({ at });
  }
  for (const m of text.matchAll(/(?<![\d:.])(\d{1,2})\s?(am|pm)\b/gi)) {
    const at = withSuffix(Number(m[1]), 0, m[2]);
    if (at !== undefined) add({ at });
  }
  const bare = (h: number) => {
    if (!ok(h, 0)) return;
    add(h >= 1 && h <= 11 ? { at: h * 60, alt: (h + 12) * 60 } : { at: h * 60 });
  };
  for (const m of text.matchAll(/(?<![\d:.])(?<!\b(?:every|alle|jede[nr]?)\s)(\d{1,2})\s?(?:h|uhr)\b/gi)) bare(Number(m[1]));
  for (const m of text.matchAll(/\b(?:at|um|ab|from|until|by|before|after)\s+(\d{1,2})\b(?![:.]\d)(?!\s?(?:am|pm)\b)/gi)) bare(Number(m[1]));
  for (const m of text.matchAll(/\b(\d{1,2})\s?o'clock/gi)) bare(Number(m[1]));
  if (/\b(noon|mittag)/i.test(text)) add({ at: 12 * 60 });
  if (/\bmidnight\b/i.test(text)) add({ at: 0 });
  return [...out.values()].sort((a, b) => a.at - b.at);
}

// Which of the named times have passed at `now` (every reading counts): changes exactly when a named time is crossed.
export function passedTimes(times: readonly NamedTime[], now: Date): string {
  const cur = now.getHours() * 60 + now.getMinutes();
  return times.flatMap((t) => [t.at, ...(t.alt === undefined ? [] : [t.alt])]).map((m) => (cur >= m ? "1" : "0")).join("");
}

// A coarse part of the day, so "every morning" is looked at again when the morning begins, not every hour.
export function dayPart(now: Date): string {
  const h = now.getHours();
  return h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "late";
}

// Does the text name a time inside the quiet window? (As written: a bare "at 5" counts as 5:00.)
export const namesTimeInQuietHours = (text: string, startHour: number, endHour: number): boolean =>
  namedTimes(text).some((t) => inQuietHours(new Date(2000, 0, 1, Math.floor(t.at / 60), t.at % 60), startHour, endHour));
