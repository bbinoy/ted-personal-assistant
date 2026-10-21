import { readText } from "./state.ts";
import { instancePaths } from "./convpaths.ts";
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
// `touch instance/paused` = paused until the file is removed; a date inside (YYYY-MM-DD)
// = paused until that local day, resuming on it. Handy for holidays. A full ISO time inside (2026-10-21T18:00:00.000Z, what the chat's "/pause 2h" writes, conversation/ownercommands.ts)
// = paused until that moment.
export function isPaused(now = new Date()): boolean {
  const until = readText(instancePaths().paused)?.trim();
  if (until === undefined) return false;
  if (until === "") return true;
  if (until.includes("T")) return !(Date.parse(until) <= now.getTime()); // (a time nobody can read stays paused: fail safe)
  return localDay(now) < until;
}

// What the pause file says, for "/status": undefined when not paused.
export function pauseText(now = new Date()): string | undefined {
  if (!isPaused(now)) return undefined;
  const until = readText(instancePaths().paused)?.trim() ?? "";
  if (until === "") return "paused until you /resume";
  return `paused until ${until.includes("T") ? localTime(until) : until}`;
}
