// A conversation's own clock. The Mac's time zone is the owner's and the default for everybody (a group's included); a friend can have her own (tenant.json "timeZone",
// set with `npm run tenants -- timezone <id> <zone>`). Everything that says what time or day it is for a conversation (the heartbeat run's clock line and last-look time,
// the day a note's `expires:` is compared with, the quiet-hours flag in the heartbeat's rows) reads the time here, in that zone, with Intl: no Date getter of the Mac.
// Pure and without imports, so the low-level files can use it. Without a zone the process's own is used, which is what the getters would have said.

export const systemZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Is this a time zone the runtime knows ("Europe/Lisbon")? Never throws.
export function isZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone.trim() || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface Clock {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const formats = new Map<string, Intl.DateTimeFormat>();
const formatFor = (zone: string): Intl.DateTimeFormat => {
  let f = formats.get(zone);
  if (!f) formats.set(zone, (f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })));
  return f;
};

// The wall clock at `now` in `zone` (default: the process's).
export function clockIn(now: Date, zone: string = systemZone()): Clock {
  const p: Record<string, number> = {};
  for (const part of formatFor(zone).formatToParts(now)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, weekday: new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay() };
}

export const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
const ymd = (d: { year: number; month: number; day: number }): string => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

export const dayIn = (now: Date, zone?: string): string => ymd(clockIn(now, zone));
export const timeIn = (now: Date, zone?: string): string => {
  const c = clockIn(now, zone);
  return `${pad(c.hour)}:${pad(c.minute)}`;
};

// "MM-DD HH:MM" of an ISO time in the zone (default: the process's), like the agent's own log.
export const localTime = (iso: string, zone?: string): string => {
  const c = clockIn(new Date(iso), zone);
  return `${pad(c.month)}-${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)}`;
};

// A time as part of a file name (2026-10-27T09-00-00-000Z): the stamp of a backup, a set-aside file, a snapshot.
export const fileStamp = (d: Date = new Date()): string => d.toISOString().replace(/[:.]/g, "-");

// The calendar day `offset` days from now's, in the zone: its weekday and date, by calendar arithmetic (a day is not 24 hours across a clock change).
export function dayAt(now: Date, offset: number, zone?: string): { weekday: number; date: string } {
  const c = clockIn(now, zone);
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + offset));
  return { weekday: d.getUTCDay(), date: ymd({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }) };
}

// Quiet hours may wrap midnight (22 -> 7).
export function inQuietHours(now: Date, startHour: number, endHour: number, zone?: string): boolean {
  const h = clockIn(now, zone).hour;
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

// "20 s ago", "14 min ago", "1.5 h ago": how long ago, for the approval judges.
export const agoText = (ms: number): string => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : `${(ms / 3_600_000).toFixed(1)} h ago`);
