import { dayAt, systemZone, timeIn } from "./timezone.ts";

// The clock line every unattended prompt starts with. (The daily brief has no code of its own any more: it is a skill the heartbeat run delegates to its expert,
// plugin/skills/daily-brief, with its state in the status-brief note.)

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Exact weekday + date lines, so the model never computes a weekday itself. `zone`: the conversation's own time zone (timezone.ts zoneOf), default the Mac's.
export function clockLine(now: Date, zone: string = systemZone()): string {
  const at = (offset: number) => {
    const d = dayAt(now, offset, zone);
    return `${DAYS[d.weekday]} ${d.date}`;
  };
  return `CURRENT TIME: it is now ${at(0)} ${timeIn(now, zone)} (${zone}). Yesterday was ${at(-1)}. Tomorrow is ${at(1)}. The day after is ${at(2)}. Use these exact weekday+date pairs everywhere; never infer or compute a weekday yourself, and cross-check against the datetimes returned by calendar tools.`;
}
