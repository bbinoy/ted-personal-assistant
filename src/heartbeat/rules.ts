import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { inQuietHours } from "../actions.ts";
import { settings } from "../settings.ts";
import type { HeartbeatRow } from "./rows.ts";

// The heartbeat run's pure rules: what its answer looks like, how its next look is clamped, and the night cap. Code keeps these whatever the model decides.

export const MIN_LOOK_MINUTES = 10;
export const MAX_LOOK_MINUTES = 120;
export const SILENT = "[[silent]]";

export const HEARTBEAT_SCHEMA: Options["outputFormat"] = {
  type: "json_schema",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["message", "nextCheckMinutes"],
    properties: {
      message: { type: "string" }, // the message to the owner, or [[silent]]
      nextCheckMinutes: { type: "integer", minimum: MIN_LOOK_MINUTES, maximum: MAX_LOOK_MINUTES },
    },
  },
};

// The next look, in minutes, whatever the model said: a number from 10 to 120, the day default when it gave nothing usable. Also at night.
export const clampLook = (minutes: unknown, fallback: number = settings.heartbeatDayMinutes): number => {
  const n = typeof minutes === "number" || (typeof minutes === "string" && minutes.trim() !== "") ? Number(minutes) : NaN;
  const use = Number.isFinite(n) ? n : fallback;
  return Math.max(MIN_LOOK_MINUTES, Math.min(MAX_LOOK_MINUTES, Math.round(use)));
};

export interface Answer {
  message: string | undefined; // undefined: silent
  nextCheckMinutes: number;
}

// Pure: the run's answer. The constrained JSON is read first, a JSON text second; anything else is silent (a run that did not follow the format must never post its reasoning).
export function parseAnswer(structured: unknown, text: string): Answer {
  let raw: unknown = structured;
  if (!raw || typeof raw !== "object") {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
  }
  const v = (raw && typeof raw === "object" ? raw : {}) as { message?: unknown; nextCheckMinutes?: unknown };
  const message = typeof v.message === "string" ? v.message.trim() : "";
  const silent = !message || message.toLowerCase().includes(SILENT.toLowerCase());
  return { message: silent ? undefined : message, nextCheckMinutes: clampLook(v.nextCheckMinutes) };
}

// The start of the quiet window `now` is in (22:00 yesterday or today, for a 22-07 window).
export function nightStart(now: Date, from: number, to: number): Date {
  const d = new Date(now);
  d.setHours(from, 0, 0, 0);
  if (from > to && now.getHours() < to) d.setDate(d.getDate() - 1); // the window wraps midnight and it is the small hours: it began yesterday
  return d;
}

// Pure: how many proactive messages went out in the night window that `now` is in (0 in the day).
export function nightCount(rows: readonly HeartbeatRow[], now: Date, from: number = settings.quietStartHour, to: number = settings.quietEndHour): number {
  if (!inQuietHours(now, from, to)) return 0;
  const start = nightStart(now, from, to).getTime();
  return rows.filter((r) => r.message && Date.parse(r.at) >= start).length;
}

// Pure: may another proactive message go out now? In the day always; inside the night window up to the cap, then it is held for the morning look.
export const mayPostNow = (rows: readonly HeartbeatRow[], now: Date, cap: number = settings.nightMessages, from: number = settings.quietStartHour, to: number = settings.quietEndHour): boolean =>
  !inQuietHours(now, from, to) || nightCount(rows, now, from, to) < cap;
