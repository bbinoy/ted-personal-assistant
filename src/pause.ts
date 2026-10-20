import { readText } from "./state.ts";
import { dayIn } from "./timezone.ts";

// The day as YYYY-MM-DD: the Mac's by default, a conversation's own with its zone (timezone.ts).
export const localDay = (d: Date, zone?: string) =>
  zone ? dayIn(d, zone) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Local wall time (MM-DD HH:MM), like the agent's own log.
export const localTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// One pause switch for everything (heartbeat, triage actions, daily brief).
// `touch state/paused` = paused until the file is removed; a date inside (YYYY-MM-DD)
// = paused until that local day, resuming on it. Handy for holidays.
export function isPaused(now = new Date()): boolean {
  const until = readText("state/paused")?.trim();
  if (until === undefined) return false;
  return until === "" || localDay(now) < until;
}
