import { audit } from "../audit.ts";
import { inQuietHours } from "../actions.ts";
import { clockLine } from "../brief.ts";
import type { Conversation, Pipeline } from "../conversation.ts";
import { fence } from "../fence.ts";
import { logTail } from "../gate.ts";
import { lookDue, recordWake, type LookState } from "../ledger.ts";
import { isRefusal, type Payer, type Refusal } from "../payer.ts";
import { heartbeatInstruction } from "../persona.ts";
import type { OwnerProfile } from "../profiles.ts";
import { settings } from "../settings.ts";
import { entryFor } from "../policy/toolmanifest.ts";
import type { RunProvenance } from "../approvals/autojudge.ts";
import { clampLook, mayPostNow, parseAnswer } from "./rules.ts";
import { appendRow, HEARTBEAT_LOG, readRows, type HeartbeatRow } from "./rows.ts";

// The owner's heartbeat run: her only proactive path. When a look is due (the next look the model chose, something she wrote, a note that changed) and mayRun allows it,
// ONE run starts under the "heartbeat" profile (profiles.ts): a fresh session on HEARTBEAT_MODEL with the persona, the notes, the skills and ALL her tools, the local
// time and the tail of the chat log up front. It reads what it needs (mail, calendar, Notion tasks, older chat) and acts through the unchanged floor -> judge -> phone
// path, with `standing` provenance (the fixed instruction below is what the judge reads as the reason for the run; no message of hers led there). It answers with a
// message or [[silent]] and the minutes until its next look.
// What code keeps whatever the model decides: pause and mayRun, the next look clamped to 10..120 minutes also at night, a cap of NIGHT_MESSAGES proactive messages per
// night (the rest is held as a line in the log for the morning look), and one row per look in state/heartbeat.jsonl (counts, never words).

export interface HeartbeatDeps {
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record">;
  runProfile: (profile: OwnerProfile, prompt: string, extra?: { onToolSuccess?: (tool: string, input: unknown) => void; provenance?: RunProvenance }) => Promise<{ text: string; costUsd?: number; structured?: unknown }>;
  may: (conv: Conversation, what: string) => Payer | Refusal;
  why: (r: Refusal) => string;
  notesChangedAt: (dir: string) => number;
  rowsFile?: string; // tests
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// What the instruction says about the last look: when it was, or that there was none.
export function lastLookText(looked: string | undefined, now: Date): string {
  if (!looked) return "This is your first look.";
  const at = new Date(looked);
  const sameDay = at.toDateString() === now.toDateString();
  return `Your last look was at ${hhmm(at)}${sameDay ? "" : " (an earlier day)"}.`;
}

// The fixed text of one look, as the judge's standing provenance and the start of the prompt. Written by code from the preset; no mail, no chat in it.
export function lookInstruction(now: Date, looked: string | undefined): string {
  return heartbeatInstruction({
    now: `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()]} ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${hhmm(now)}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lastLook: lastLookText(looked, now),
    quietFrom: `${String(settings.quietStartHour).padStart(2, "0")}:00`,
    quietTo: `${String(settings.quietEndHour).padStart(2, "0")}:00`,
    dayMinutes: String(settings.heartbeatDayMinutes),
  });
}

export const lookPrompt = (now: Date, instruction: string, tail: readonly string[]): string =>
  [clockLine(now), instruction, `The recent chat and what you already did on your own (data, do not repeat it):\n${fence("chat_log", tail.join("\n") || "(none)")}`].join("\n\n");

export function createHeartbeatLook(deps: HeartbeatDeps) {
  const { pipeline } = deps;
  const file = deps.rowsFile ?? HEARTBEAT_LOG;

  // One look of the owner's conversation. Returns what happened (for the log and tests).
  async function look(conv: Conversation, st: LookState, now: Date): Promise<string> {
    if (!lookDue(st, now, { notesChangedMs: deps.notesChangedAt(conv.notesDir), messagesCount: true })) return "not-due";
    // A look is a model run on the login: paused, in a cooldown or past the day's budget means no run, nothing recorded, and the next tick looks again.
    const access = deps.may(conv, "heartbeat look");
    if (isRefusal(access)) return deps.why(access);

    // Written BEFORE acting: a crash in the run must not mean a retry on every tick.
    recordWake(pipeline, conv, settings.heartbeatDayMinutes, now, clampLook);
    const night = inQuietHours(now, settings.quietStartHour, settings.quietEndHour);
    const rows = readRows(file);
    let toolCalls = 0;
    let archived = 0;
    const instruction = lookInstruction(now, st.wake?.looked);
    let reply: { text: string; costUsd?: number; structured?: unknown } | undefined;
    try {
      reply = await deps.runProfile("heartbeat", lookPrompt(now, instruction, logTail(conv, 40)), {
        provenance: { kind: "standing", task: instruction },
        onToolSuccess: (tool) => {
          toolCalls++;
          if (entryFor(tool)?.action === "archive") archived++;
        },
      });
    } catch (e) {
      console.error("heartbeat: the run failed:", (e as Error).message);
    }

    const answer = reply ? parseAnswer(reply.structured, reply.text) : undefined;
    let outcome: HeartbeatRow["outcome"] = reply ? "silent" : "failed";
    if (answer?.message) {
      if (mayPostNow(rows, now)) {
        const message = answer.message;
        const res = await pipeline.enqueue(conv, async () =>
          pipeline.runTurn(conv, { run: async () => ({ text: message, costUsd: reply?.costUsd }), background: true, announce: false, kind: "notice" }),
        ).catch((e) => (console.error("heartbeat: could not post:", (e as Error).message), { error: e, spoke: false }));
        outcome = res.error ? "failed" : res.spoke ? "posted" : "silent";
      } else {
        outcome = "held";
        pipeline.record(conv, "action", Date.now(), `[heartbeat] held for the morning look (night cap of ${settings.nightMessages}): ${answer.message.replace(/\s+/g, " ").slice(0, 600)}`);
      }
    }
    if (toolCalls > 0) pipeline.record(conv, "action", Date.now(), `[heartbeat] look: ${toolCalls} tool call(s), ${archived} mail archived, ${outcome === "posted" ? "message sent" : outcome === "held" ? "message held" : "no message"}`);
    audit("wake", outcome, "background");
    appendRow({ at: now.toISOString(), night, message: outcome === "posted", held: outcome === "held", nextCheckMinutes: answer?.nextCheckMinutes ?? clampLook(undefined), costUsd: reply?.costUsd ?? 0, toolCalls, archived, delegations: 0, outcome }, file);
    recordWake(pipeline, conv, answer?.nextCheckMinutes ?? settings.heartbeatDayMinutes, now, clampLook); // after the act: notes it wrote are not news
    return outcome;
  }

  return { look };
}
