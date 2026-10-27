import { scheduleLines } from "../modules/tasks/routinelist.ts";
import { ownerSkills } from "../modules/skills.ts";
import { nextReminderText } from "../tasks/remind.ts";
import { openCount } from "../approvals/approvals.ts";
import { spentToday } from "../core/budget.ts";
import { clearPause, pauseText, setPause } from "../core/pause.ts";
import { parseUntil } from "../core/until.ts";
import { settings } from "../core/settings.ts";
import { instanceDb, ledgerDamage } from "../core/instancedb.ts";
import { systemZone, timeIn } from "../core/timezone.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { todayText } from "../memory/journalread.ts";
import { clearQuiet, quietText, setQuiet } from "./quiet.ts";
import { disconnected, NAMES, readConnectors } from "../modules/connectors.ts";
import { stopRuns } from "../run/ceiling.ts";
import type { Conversation } from "./conversationmodel.ts";
import { allows } from "../policy/capabilities.ts";
import type { Capability } from "../tenants/tenants.ts";
import { tasksText } from "../tasks/render.ts";

// The owner's hands on the machine, handled in code before any model sees the message (like /card, conversation.ts): "/stop" (or "stop!") aborts the conversation's running turn,
// "/pause 2h" / "/pause until 18:00" / "/pause" / "/resume" set and clear the pause switch (core/pause.ts), "/status" answers in a phone-sized summary, "/today" what the assistant did today and why (the journal), "/quiet 2h" / "/quiet until 18:00" /
// "/quiet" / "/unquiet" hold the conversation's unprompted posts for the next look while chat and the heartbeat's work go on (quiet.ts). The message must be EXACTLY the command, so a
// sentence that merely contains the word is a message like any other. "/tasks" the open tasks grouped by when they are due (tasks/render.ts). Each needs a capability of the conversation, not a kind (NEEDS below): /stop "chat", /tasks "tasks", /quiet "wake" (a group has these three too); pause, resume, status and today "admin" (the owner's only).

export type Command =
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "status" }
  | { kind: "today" } // what the assistant did today and why, from the journal (memory/journalread.ts); code only
  | { kind: "tasks" } // the task list (tasks/render.ts), phone-sized; code only
  | { kind: "pause"; until: string; text: string } // until: the stored "until" value (core/until.ts: "" = until /resume, or an ISO time); text: how it is said back
  | { kind: "pause-usage" }
  | { kind: "quiet"; until: string; text: string } // until: "" = until /unquiet, else an ISO time
  | { kind: "unquiet" }
  | { kind: "quiet-usage" };

// Pure: the message as a command, or undefined (it is just a message). `now` and `zone` matter for "until 18:00". /pause and /quiet are the same shape (core/until.ts): bare, "2h", "until 18:00".
const SWITCHES = {
  pause: (when: string) => (when === "" ? "Paused until you say /resume." : `Paused until ${when}. /resume to undo.`),
  quiet: (when: string) =>
    `${when === "" ? "Quiet until you say /unquiet." : `Quiet until ${when}.`} I'll hold what I'd post unprompted and tell you what still matters then; urgent things still come through.${when === "" ? "" : " /unquiet to undo."}`,
} as const;
export function parseCommand(text: string, now: Date = new Date(), zone: string = systemZone()): Command | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "/stop" || t === "stop!") return { kind: "stop" };
  if (t === "/resume") return { kind: "resume" };
  if (t === "/unquiet") return { kind: "unquiet" };
  if (t === "/status") return { kind: "status" };
  if (t === "/today") return { kind: "today" };
  if (t === "/tasks") return { kind: "tasks" };
  for (const kind of ["pause", "quiet"] as const) {
    if (t !== `/${kind}` && !t.startsWith(`/${kind} `)) continue;
    const r = parseUntil(t === `/${kind}` ? undefined : t.slice(kind.length + 2), now, zone);
    return r === "usage" ? { kind: `${kind}-usage` } : { kind, until: r.until, text: SWITCHES[kind](r.when) };
  }
  return undefined;
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
  setPause,
  clearPause,
  setQuiet,
  clearQuiet,
  facts: (conv, now) => {
    return {
      pause: pauseText(now, zoneOf(conv)),
      quiet: quietText(conv, now, zoneOf(conv)),
      spentUsd: spentToday(),
      limitUsd: settings.dailyBudgetUsd,
      approvals: openCount(conv.key), // (the questions open in the chat)
      lastLook: lastOwnerLook(),
      nextReminder: nextReminderText(conv.key, conv.convId, now.getTime(), zoneOf(conv)) ?? "",
      routines: scheduleLines(conv.convId, { skills: ownerSkills(), notesDir: conv.notesDir, zone: zoneOf(conv), now }),
      ...(ledgerDamage() ? { damaged: true } : {}),
      down: disconnected(readConnectors()).map((k) => NAMES[k]),
    };
  },
};

// The reply to a command in this conversation, or undefined when the message is no command for it (so it goes on to the model as always).
// What each command needs: a capability of the conversation (policy/capabilities.ts), never its kind. The owner has them all; a friend all but "admin"; a group (nothing of the owner's) has "chat", "wake" and "tasks".
const NEEDS: Record<Command["kind"], Capability> = { stop: "chat", tasks: "tasks", quiet: "wake", unquiet: "wake", "quiet-usage": "wake", resume: "admin", status: "admin", today: "admin", pause: "admin", "pause-usage": "admin" };

export function commandReply(conv: QuietConv, text: string, deps: Partial<CommandDeps> = {}): string | undefined {
  const d = { ...real, ...deps };
  const now = d.now();
  const cmd = parseCommand(text, now, conv.kind === "tenant" ? zoneOf(conv) : undefined);
  if (!cmd || !allows(conv, NEEDS[cmd.kind])) return undefined;
  switch (cmd.kind) {
    case "stop":
      return d.stop(conv.convId) + d.dropQueued() > 0 ? "Stopped." : "Nothing is running right now.";
    case "tasks":
      return d.tasks(conv, now);
    case "quiet":
      return d.setQuiet(conv, cmd.until), cmd.text;
    case "unquiet":
      return d.clearQuiet(conv), "Back to normal. What I held, I will look at again and tell you what still matters.";
    case "quiet-usage":
      return QUIET_USAGE;
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
