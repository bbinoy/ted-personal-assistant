import { routineLines } from "../tasks/routines.ts";
import { lastStatusText } from "../modules/status/statusnote.ts";
import { ownerSkills } from "../modules/skills.ts";
import { PLUGIN } from "../core/preset.ts";
import { nextReminderText } from "../tasks/remind.ts";
import { rmSync } from "node:fs";
import { openCount } from "../approvals/approvals.ts";
import { spentToday } from "../core/budget.ts";
import { pauseText } from "../core/pause.ts";
import { settings } from "../core/settings.ts";
import { dataPath, writeText } from "../core/state.ts";
import { instanceDb, ledgerDamage } from "../core/instancedb.ts";
import { instancePaths } from "../core/convpaths.ts";
import { clockIn, systemZone, timeIn } from "../core/timezone.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { todayText } from "../memory/journalread.ts";
import { clearQuiet, quietText, setQuiet } from "./quiet.ts";
import { disconnected, NAMES, readConnectors } from "../modules/connectors.ts";
import { stopRuns } from "../run/ceiling.ts";
import type { Conversation } from "./conversationmodel.ts";
import { allows } from "../policy/capabilities.ts";
import { tasksText } from "../tasks/render.ts";

// The owner's hands on the machine, handled in code before any model sees the message (like /card, conversation.ts): "/stop" (or "stop!") aborts the conversation's running turn,
// "/pause 2h" / "/pause until 18:00" / "/pause" / "/resume" write and remove the pause switch (core/pause.ts), "/status" answers in a phone-sized summary, "/today" what the assistant did today and why (the journal), "/quiet 2h" / "/quiet until 18:00" /
// "/quiet" / "/unquiet" hold the conversation's unprompted posts for the next look while chat and the heartbeat's work go on (quiet.ts). The message must be EXACTLY the command, so a
// sentence that merely contains the word is a message like any other. "/tasks" the open tasks grouped by when they are due (tasks/render.ts). /stop, /quiet and /tasks work in the owner's chat and a friend's own chat; pause, status and today are the owner's only.

export type Command =
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "status" }
  | { kind: "today" } // what the assistant did today and why, from the journal (memory/journalread.ts); code only
  | { kind: "tasks" } // the task list (tasks/render.ts), phone-sized; code only
  | { kind: "pause"; until: string; text: string } // until: what goes into the pause file ("" = until /resume; an ISO time; a YYYY-MM-DD day); text: how it is said back
  | { kind: "pause-usage" }
  | { kind: "quiet"; until: string; text: string } // until: "" = until /unquiet, else an ISO time
  | { kind: "unquiet" }
  | { kind: "quiet-usage" };

const MAX_PAUSE_MS = 365 * 86_400_000;
const UNITS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

// Pure: "2h", "30m", "1d" or "until 18:00" as the moment it names and how to say it ("16:30", "18:00 tomorrow"); "usage" for a malformed one; undefined for something else (pause also takes a day).
export function untilTime(arg: string, now: Date, zone: string): { at: Date; when: string } | "usage" | undefined {
  const span = /^(\d{1,4})\s?(m|min|h|d)$/.exec(arg);
  if (span) {
    const ms = Number(span[1]) * UNITS[span[2]!]!;
    if (ms <= 0 || ms > MAX_PAUSE_MS) return "usage";
    const at = new Date(now.getTime() + ms);
    return { at, when: `${timeIn(at, zone)}${ms >= 86_400_000 ? ` on ${at.toISOString().slice(0, 10)}` : ""}` };
  }
  const clock = /^until (\d{1,2})(?::(\d{2}))?$/.exec(arg);
  if (!clock) return undefined;
  const h = Number(clock[1]);
  const m = Number(clock[2] ?? 0);
  if (h > 23 || m > 59) return "usage";
  const c = clockIn(now, zone);
  const nowMin = c.hour * 60 + c.minute;
  const tomorrow = h * 60 + m <= nowMin; // the next time it is h:m is tomorrow's when it has passed
  const ahead = (h * 60 + m - nowMin + 1440) % 1440 || 1440;
  return { at: new Date(Math.floor(now.getTime() / 60_000) * 60_000 + ahead * 60_000), when: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${tomorrow ? " tomorrow" : ""}` };
}

// Pure: "/quiet" (until /unquiet), "/quiet 2h", "/quiet until 18:00", "/unquiet"; undefined when the message is none of them.
export function parseQuiet(t: string, now: Date, zone: string): Command | undefined {
  if (t === "/unquiet") return { kind: "unquiet" };
  if (t === "/quiet") return { kind: "quiet", until: "", text: "Quiet until you say /unquiet. I'll hold what I'd post unprompted and tell you what still matters then; urgent things still come through." };
  if (!t.startsWith("/quiet ")) return undefined;
  const r = untilTime(t.slice("/quiet ".length), now, zone);
  if (!r || r === "usage") return { kind: "quiet-usage" };
  return { kind: "quiet", until: r.at.toISOString(), text: `Quiet until ${r.when}. I'll hold what I'd post unprompted and tell you what still matters then; urgent things still come through. /unquiet to undo.` };
}

// Pure: the message as a command, or undefined (it is just a message). `now` and `zone` matter for "until 18:00".
export function parseCommand(text: string, now: Date = new Date(), zone: string = systemZone()): Command | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "/stop" || t === "stop!") return { kind: "stop" };
  if (t === "/resume") return { kind: "resume" };
  if (t === "/status") return { kind: "status" };
  if (t === "/today") return { kind: "today" };
  if (t === "/tasks") return { kind: "tasks" };
  const quiet = parseQuiet(t, now, zone);
  if (quiet) return quiet;
  if (t === "/pause") return { kind: "pause", until: "", text: "Paused until you say /resume." };
  if (!t.startsWith("/pause ")) return undefined;
  const arg = t.slice("/pause ".length);
  const r = untilTime(arg, now, zone);
  if (r === "usage") return { kind: "pause-usage" };
  if (r) return { kind: "pause", until: r.at.toISOString(), text: `Paused until ${r.when}. /resume to undo.` };
  const day = /^until (\d{4}-\d{2}-\d{2})$/.exec(arg);
  if (day && !Number.isNaN(Date.parse(day[1]!))) return { kind: "pause", until: day[1]!, text: `Paused until ${day[1]}. /resume to undo.` };
  return { kind: "pause-usage" };
}

// The owner's last look, from the heartbeat's own rows (the `looks` table of instance.db; core/looks.ts writes it, the conversation folder reads it through the database).
export function lastOwnerLook(): { at: Date; outcome: string } | undefined {
  let r: { at: string; outcome: string } | undefined;
  try {
    r = instanceDb().get<{ at: string; outcome: string }>("SELECT at, outcome FROM looks WHERE kind = 'owner' ORDER BY id DESC LIMIT 1");
  } catch {
    return undefined; // (a damaged or busy database: /status says so separately)
  }
  return r && Number.isFinite(Date.parse(r.at)) ? { at: new Date(r.at), outcome: r.outcome } : undefined;
}

export interface StatusFacts {
  pause?: string; // pauseText()
  quiet?: string; // quietText(): this conversation's /quiet, when on
  spentUsd: number;
  limitUsd: number;
  lastLook?: { at: Date; outcome: string };
  approvals: number;
  down: readonly string[]; // connectors down in the last run
  zone?: string;
  nextReminder?: string; // when the next task reminder goes (tasks/remind.ts nextReminderText); none: no reminder is scheduled
  routines?: readonly string[]; // one line per routine: its schedule, next and last run (tasks/routines.ts routineLines); absent: no routines
  damaged?: boolean; // the ledger database is damaged: the agent runs degraded (core/instancedb.ts)
}

// Pure: the "/status" answer, a few short lines.
export function statusText(f: StatusFacts): string {
  return [
    f.pause ? `Paused: ${f.pause}.` : "Running (not paused).",
    ...(f.quiet ? [`Quiet: ${f.quiet} (held items are looked at again when it ends).`] : []),
    f.damaged ? "Ledger damaged (instance/instance.db): background work and payments are off, chat works. See `npm run doctor`." : `Budget today: $${f.spentUsd.toFixed(2)} of $${f.limitUsd}${f.spentUsd >= f.limitUsd ? " (reached, background work is paused)" : ""}.`,
    f.lastLook ? `Last look: ${timeIn(f.lastLook.at, f.zone)} (${f.lastLook.outcome}).` : "Last look: none yet.",
    `Open approvals: ${f.approvals}.`,
    ...(f.nextReminder !== undefined ? [`Next reminder: ${f.nextReminder || "none"}.`] : []),
    ...(f.routines?.length ? [`Routines: ${f.routines.join(" | ")}.`] : []),
    f.down.length ? `Connectors down: ${f.down.join(", ")}. See \`npm run doctor\`.` : "Connectors: none down.",
  ].join("\n");
}

const USAGE = "Say /pause 2h, /pause until 18:00, /pause (until /resume), or /resume.";

const QUIET_USAGE = "Say /quiet 2h, /quiet until 18:00, /quiet (until /unquiet), or /unquiet.";

export interface CommandDeps {
  now: () => Date;
  stop: (scope: string) => number;
  dropQueued: () => number; // the messages of this conversation still settling or queued behind the turn (conversation.ts): they are dropped, not run
  setPause: (content: string) => void;
  clearPause: () => void;
  facts: (conv: Conversation, now: Date) => StatusFacts;
  today: (conv: Conversation, now: Date) => string; // the day so far from the journal: counts by kind, the last few actions with why
  tasks: (conv: QuietConv, now: Date) => string; // the task list of this conversation
  setQuiet: (conv: QuietConv, until: string) => void;
  clearQuiet: (conv: QuietConv) => void;
}
type QuietConv = Pick<Conversation, "kind" | "key" | "convId"> & { readonly tenantId?: string };
const real: CommandDeps = {
  today: (conv, now) => todayText(conv.logFile, { now: now.getTime(), zone: zoneOf(conv) }),
  tasks: (conv, now) => tasksText(conv.key, now.getTime(), zoneOf(conv)),
  now: () => new Date(),
  stop: stopRuns,
  dropQueued: () => 0,
  setPause: (content) => writeText(instancePaths().paused, content),
  clearPause: () => rmSync(dataPath(instancePaths().paused), { force: true }),
  setQuiet,
  clearQuiet,
  facts: (conv, now) => {
    return {
      pause: pauseText(now),
      quiet: quietText(conv, now, zoneOf(conv)),
      spentUsd: spentToday(),
      limitUsd: settings.dailyBudgetUsd,
      approvals: openCount(conv.key), // (the questions open in the chat)
      lastLook: lastOwnerLook(),
      nextReminder: nextReminderText(conv.key, conv.convId, now.getTime(), zoneOf(conv)) ?? "",
      routines: routineLines(conv.convId, settings.routines.filter((r) => ownerSkills().includes(`${PLUGIN}:${r.skill}`)), now, zoneOf(conv), lastStatusText("brief", zoneOf(conv))),
      ...(ledgerDamage() ? { damaged: true } : {}),
      down: disconnected(readConnectors()).map((k) => NAMES[k]),
    };
  },
};

// The reply to a command in this conversation, or undefined when the message is no command for it (so it goes on to the model as always).
// /quiet and /unquiet: the owner's chat and a friend's own chat (her own conversation only); a group has no commands.
function quietReply(conv: QuietConv, cmd: Command, d: CommandDeps): string | undefined {
  if (conv.kind === "group") return undefined;
  if (cmd.kind === "quiet") return d.setQuiet(conv, cmd.until), cmd.text;
  if (cmd.kind === "unquiet") return d.clearQuiet(conv), "Back to normal. What I held, I will look at again and tell you what still matters.";
  return QUIET_USAGE;
}

export function commandReply(conv: QuietConv, text: string, deps: Partial<CommandDeps> = {}): string | undefined {
  const d = { ...real, ...deps };
  const now = d.now();
  const cmd = parseCommand(text, now, conv.kind === "tenant" ? zoneOf(conv) : undefined);
  if (!cmd) return undefined;
  if (cmd.kind === "stop") {
    if (conv.kind === "group") return undefined; // (a group has its own door; a command there is just a message)
    return d.stop(conv.convId) + d.dropQueued() > 0 ? "Stopped." : "Nothing is running right now.";
  }
  if (cmd.kind === "tasks") return conv.kind === "group" || !allows(conv, "tasks") ? undefined : d.tasks(conv, now); // the owner's list in her chat, a friend's in hers; a group has no commands
  if (cmd.kind === "quiet" || cmd.kind === "unquiet" || cmd.kind === "quiet-usage") return quietReply(conv, cmd, d);
  if (conv.kind !== "owner") return undefined; // pause and status are the owner's
  switch (cmd.kind) {
    case "resume":
      d.clearPause();
      return "Resumed.";
    case "status":
      return statusText(d.facts(conv as Conversation, now));
    case "today":
      return d.today(conv as Conversation, now);
    case "pause":
      d.setPause(cmd.until);
      return cmd.text;
    default:
      return USAGE;
  }
}
