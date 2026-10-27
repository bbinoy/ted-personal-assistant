import { readText } from "./state.ts";
import { instancePaths } from "./convpaths.ts";
import { dayIn, localTime } from "./timezone.ts";

// One pause switch for everything (heartbeat, triage actions, daily brief).
// `touch instance/paused` = paused until the file is removed; a date inside (YYYY-MM-DD)
// = paused until that local day, resuming on it. Handy for holidays. A full ISO time inside (2026-10-21T18:00:00.000Z, what the chat's "/pause 2h" writes, conversation/ownercommands.ts)
// = paused until that moment.
export function isPaused(now = new Date()): boolean {
  const until = readText(instancePaths().paused)?.trim();
  if (until === undefined) return false;
  if (until === "") return true;
  if (until.includes("T")) return !(Date.parse(until) <= now.getTime()); // (a time nobody can read stays paused: fail safe)
  return dayIn(now) < until;
}

// What the pause file says, for "/status": undefined when not paused.
export function pauseText(now = new Date()): string | undefined {
  if (!isPaused(now)) return undefined;
  const until = readText(instancePaths().paused)?.trim() ?? "";
  if (until === "") return "paused until you /resume";
  return `paused until ${until.includes("T") ? localTime(until) : until}`;
}
