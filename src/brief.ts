import { localDay } from "./pause.ts";

// The clock line every unattended prompt starts with. (The daily brief has no code of its own any more: it is a skill the heartbeat run delegates to its expert,
// plugin/skills/daily-brief, with its state in the status-brief note.)

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Exact weekday + date lines, so the model never computes a weekday itself.
export function clockLine(now: Date): string {
  const at = (offset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    return `${DAYS[d.getDay()]} ${localDay(d)}`;
  };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return `CURRENT TIME: it is now ${DAYS[now.getDay()]} ${localDay(now)} ${hhmm} (${tz}). Yesterday was ${at(-1)}. Tomorrow is ${at(1)}. The day after is ${at(2)}. Use these exact weekday+date pairs everywhere; never infer or compute a weekday yourself, and cross-check against the datetimes returned by calendar tools.`;
}
