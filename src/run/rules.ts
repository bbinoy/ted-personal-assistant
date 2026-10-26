import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { settings } from "../core/settings.ts";

// The heartbeat run's pure rules: what its answer looks like, and how its next look is clamped. Code keeps these whatever the model decides.

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
      urgent: { type: "boolean" }, // truly time-critical: code then posts it also in quiet hours and past the day's cap (heartbeat/notices.ts)
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
  urgent: boolean; // the model marked the message time-critical (only a literal true counts)
}

// Pure: the run's answer. The constrained JSON is read first, a JSON text second; anything else is silent (a run that did not follow the format must never post its reasoning).
export function parseHeartbeatAnswer(structured: unknown, text: string): Answer {
  let raw: unknown = structured;
  if (!raw || typeof raw !== "object") {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
  }
  const v = (raw && typeof raw === "object" ? raw : {}) as { message?: unknown; nextCheckMinutes?: unknown; urgent?: unknown };
  const message = typeof v.message === "string" ? v.message.trim() : "";
  const silent = !message || message.toLowerCase().includes(SILENT.toLowerCase());
  return { message: silent ? undefined : message, nextCheckMinutes: clampLook(v.nextCheckMinutes), urgent: !silent && v.urgent === true };
}
