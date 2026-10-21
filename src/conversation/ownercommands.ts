import { rmSync } from "node:fs";
import { openCount } from "../approvals/approvals.ts";
import { spentToday } from "../core/budget.ts";
import { pauseText } from "../core/pause.ts";
import { settings } from "../core/settings.ts";
import { dataPath, readText, writeText } from "../core/state.ts";
import { clockIn, systemZone, timeIn } from "../core/timezone.ts";
import { disconnected, NAMES, readConnectors } from "../modules/connectors.ts";
import { stopRuns } from "../run/ceiling.ts";
import type { Conversation } from "./conversationmodel.ts";

// The owner's hands on the machine, handled in code before any model sees the message (like /card, conversation.ts): "/stop" (or "stop!") aborts the conversation's running turn,
// "/pause 2h" / "/pause until 18:00" / "/pause" / "/resume" write and remove the pause switch (core/pause.ts), "/status" answers in a phone-sized summary. The message must be EXACTLY
// the command, so a sentence that merely contains the word is a message like any other. /stop works in the owner's chat and a friend's own chat; pause and status are the owner's only.

export type Command =
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "status" }
  | { kind: "pause"; until: string; text: string } // until: what goes into the pause file ("" = until /resume; an ISO time; a YYYY-MM-DD day); text: how it is said back
  | { kind: "pause-usage" };

const MAX_PAUSE_MS = 365 * 86_400_000;
const UNITS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

// Pure: the message as a command, or undefined (it is just a message). `now` and `zone` matter for "until 18:00".
export function parseCommand(text: string, now: Date = new Date(), zone: string = systemZone()): Command | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "/stop" || t === "stop!") return { kind: "stop" };
  if (t === "/resume") return { kind: "resume" };
  if (t === "/status") return { kind: "status" };
  if (t === "/pause") return { kind: "pause", until: "", text: "Paused until you say /resume." };
  if (!t.startsWith("/pause ")) return undefined;
  const arg = t.slice("/pause ".length);
  const span = /^(\d{1,4})\s?(m|min|h|d)$/.exec(arg);
  if (span) {
    const ms = Number(span[1]) * UNITS[span[2]!]!;
    if (ms <= 0 || ms > MAX_PAUSE_MS) return { kind: "pause-usage" };
    const until = new Date(now.getTime() + ms);
    return { kind: "pause", until: until.toISOString(), text: `Paused until ${timeIn(until, zone)}${ms >= 86_400_000 ? ` on ${until.toISOString().slice(0, 10)}` : ""}. /resume to undo.` };
  }
  const clock = /^until (\d{1,2})(?::(\d{2}))?$/.exec(arg);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2] ?? 0);
    if (h > 23 || m > 59) return { kind: "pause-usage" };
    const c = clockIn(now, zone);
    const nowMin = c.hour * 60 + c.minute;
    const tomorrow = h * 60 + m <= nowMin; // the next time it is h:m is tomorrow's when it has passed
    const ahead = (h * 60 + m - nowMin + 1440) % 1440 || 1440;
    const until = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + ahead * 60_000);
    return { kind: "pause", until: until.toISOString(), text: `Paused until ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${tomorrow ? " tomorrow" : ""}. /resume to undo.` };
  }
  const day = /^until (\d{4}-\d{2}-\d{2})$/.exec(arg);
  if (day && !Number.isNaN(Date.parse(day[1]!))) return { kind: "pause", until: day[1]!, text: `Paused until ${day[1]}. /resume to undo.` };
  return { kind: "pause-usage" };
}

// The owner's last look, from the heartbeat's own rows (heartbeat/rows.ts keeps the file; the conversation folder may not import it, test/ownercommands.test.ts checks the name is the same).
export const ROWS_FILE = "state/heartbeat.jsonl";
export function lastOwnerLook(text: string | undefined): { at: Date; outcome: string } | undefined {
  for (const line of (text ?? "").trimEnd().split("\n").reverse().slice(0, 200)) {
    try {
      const r = JSON.parse(line) as { at?: unknown; kind?: string; outcome?: unknown };
      if (typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) && (r.kind ?? "owner") === "owner") return { at: new Date(r.at), outcome: String(r.outcome) };
    } catch {
      /* a torn line */
    }
  }
  return undefined;
}

export interface StatusFacts {
  pause?: string; // pauseText()
  spentUsd: number;
  limitUsd: number;
  lastLook?: { at: Date; outcome: string };
  approvals: number;
  down: readonly string[]; // connectors down in the last run
  zone?: string;
}

// Pure: the "/status" answer, a few short lines.
export function statusText(f: StatusFacts): string {
  return [
    f.pause ? `Paused: ${f.pause}.` : "Running (not paused).",
    `Budget today: $${f.spentUsd.toFixed(2)} of $${f.limitUsd}${f.spentUsd >= f.limitUsd ? " (reached, background work is paused)" : ""}.`,
    f.lastLook ? `Last look: ${timeIn(f.lastLook.at, f.zone)} (${f.lastLook.outcome}).` : "Last look: none yet.",
    `Open approvals: ${f.approvals}.`,
    f.down.length ? `Connectors down: ${f.down.join(", ")}. See \`npm run doctor\`.` : "Connectors: none down.",
  ].join("\n");
}

const USAGE = "Say /pause 2h, /pause until 18:00, /pause (until /resume), or /resume.";

export interface CommandDeps {
  now: () => Date;
  stop: (scope: string) => number;
  dropQueued: () => number; // the messages of this conversation still settling or queued behind the turn (conversation.ts): they are dropped, not run
  setPause: (content: string) => void;
  clearPause: () => void;
  facts: (conv: Conversation, now: Date) => StatusFacts;
}
const real: CommandDeps = {
  now: () => new Date(),
  stop: stopRuns,
  dropQueued: () => 0,
  setPause: (content) => writeText("state/paused", content),
  clearPause: () => rmSync(dataPath("state/paused"), { force: true }),
  facts: (conv, now) => {
    return {
      pause: pauseText(now),
      spentUsd: spentToday(),
      limitUsd: settings.dailyBudgetUsd,
      lastLook: lastOwnerLook(readText(ROWS_FILE)),
      approvals: openCount(conv.key),
      down: disconnected(readConnectors()).map((k) => NAMES[k]),
    };
  },
};

// The reply to a command in this conversation, or undefined when the message is no command for it (so it goes on to the model as always).
export function commandReply(conv: Pick<Conversation, "kind" | "key" | "sessionFile">, text: string, deps: Partial<CommandDeps> = {}): string | undefined {
  const d = { ...real, ...deps };
  const now = d.now();
  const cmd = parseCommand(text, now);
  if (!cmd) return undefined;
  if (cmd.kind === "stop") {
    if (conv.kind === "group") return undefined; // (a group has its own door; a command there is just a message)
    return d.stop(conv.sessionFile) + d.dropQueued() > 0 ? "Stopped." : "Nothing is running right now.";
  }
  if (conv.kind !== "owner") return undefined; // pause and status are the owner's
  switch (cmd.kind) {
    case "resume":
      d.clearPause();
      return "Resumed.";
    case "status":
      return statusText(d.facts(conv as Conversation, now));
    case "pause":
      d.setPause(cmd.until);
      return cmd.text;
    default:
      return USAGE;
  }
}
