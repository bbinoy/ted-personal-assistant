import { clockLine } from "./brief.ts";
import { fence } from "./fence.ts";
import { wakeSkill } from "./preset.ts";

// The proactive radar's prompt (the gate starts it, wake.ts; tasks.ts runs it). One Sonnet run looks at the
// calendar and at what the heartbeat did, and says what (if anything) deserves an interruption:
// a meeting that is about to start (with its prep), a clash, something the calendar makes urgent.
// The model decides WHAT is worth a message; code (radar-rules.ts) decides whether it may be
// sent: no repeats, a daily cap, a per-run cap. The run is read-only apart from a prep page in
// Notion; calendar changes and sending mail still ask on the phone (policy.ts, source "radar").

// The radar preset's instructions (tasks.ts).
export const radarInstructions = (windowMinutes: number): string =>
  `Load the '${wakeSkill("radar")}' skill with the Skill tool and follow it. Look at the calendar from now until ${windowMinutes} minutes from now for what is about to start, and at the next 24 hours for clashes.`;

export function radarPrompt(now: Date, since: string, windowMinutes: number, digest: string, pings: readonly string[], sentKeys: readonly string[], instructions: string = radarInstructions(windowMinutes)): string {
  return [
    clockLine(now),
    instructions,
    `The heartbeat's work since ${since} (data, for context only):\n${fence("heartbeat_digest", digest || "(nothing)")}`,
    `What you already told the owner on your own in the last day (data, do not repeat it):\n${fence("recent_notifications", pings.join("\n") || "(nothing)")}`,
    `Keys you already sent a message for (never send these again):\n${fence("sent_keys", sentKeys.join("\n") || "(none)")}`,
  ].join("\n\n");
}
