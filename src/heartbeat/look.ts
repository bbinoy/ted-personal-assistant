import { audit } from "../core/audit.ts";
import { clockLine } from "../core/brief.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { owner } from "../conversation/conversationmodel.ts";
import { onLogin } from "../core/ownerkey.ts";
import { fence } from "../core/fence.ts";
import { logTail } from "../conversation/gate.ts";
import { lookDue, recordWake, type LookState } from "../conversation/ledger.ts";
import { isRefusal, type Payer, type Refusal } from "../tenants/payer.ts";
import { heartbeatInstruction } from "../run/persona.ts";
import { delegatedText, expertSetup } from "../run/delegation.ts";
import { mailSlot } from "../modules/index.ts";
import { preset } from "../core/preset.ts";
import { settings } from "../core/settings.ts";
import { dayAt, inQuietHours, systemZone, timeIn } from "../core/timezone.ts";
import { entryFor } from "../policy/toolmanifest.ts";
import type { RunProvenance } from "../approvals/autojudge.ts";
import { clampLook, parseAnswer } from "../run/rules.ts";
import { createSeenMail, seenFileOf, type SeenMail } from "../modules/seenmail/seenmail.ts";
import { hasSomethingToLookAt, lookerOf, type Looker } from "../run/scope.ts";
import { appendRow, HEARTBEAT_LOG, type HeartbeatRow } from "./rows.ts";
import { countPosts, observeLook, postNotice, submitPost } from "./notices.ts";

// A conversation's heartbeat run: the ONLY way anything acts on its own, for the owner, every group and every friend alike. When a look is due (the next look the model
// chose, something was said, a note that changed), there is something to look at (scope.ts) and mayRun allows it (payer.ts: pause, cooldown, the day's budget, a friend's
// key and her own budget), ONE run starts under the "heartbeat" profile: a fresh session on HEARTBEAT_MODEL with the conversation's own persona, notes, skills and tools
// (the owner's connectors; a friend's or a group's are what its capability set holds), the time in its zone and the tail of its chat log up front. It reads what it needs
// (mail, calendar, Notion tasks, older chat) and acts through the unchanged floor -> judge -> phone path, with `standing` provenance (the fixed instruction below is what the
// judge reads as the reason for the run; no message of anyone's led there) and the conversation's own approver (a question is asked in the chat that triggered it).
// It answers with a message or [[silent]] and the minutes until its next look.
// What code keeps whatever the model decides: pause and mayRun, the next look clamped to 10..120 minutes also at night, and one row per look in state/heartbeat.jsonl (counts, never words).

export interface RunExtra {
  onToolSuccess?: (tool: string, input: unknown) => void;
  provenance?: RunProvenance;
  onDelegate?: (agent: string) => void;
  seenMail?: SeenMail; // this look's tracker of the inbox mail already worked through
}

export interface HeartbeatDeps {
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record" | "sendWhile" | "busy">;
  run: (conv: Conversation, payer: Payer, prompt: string, extra: RunExtra) => Promise<{ text: string; costUsd?: number; structured?: unknown }>; // agent.ts runHeartbeat
  may: (conv: Conversation, what: string) => Payer | Refusal;
  why: (r: Refusal) => string;
  notesChangedAt: (dir: string) => number;
  rowsFile?: string; // tests
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// What the instruction says about the last look: when it was, or that there was none. Times are the conversation's own (`zone`, timezone.ts).
export function lastLookText(looked: string | undefined, now: Date, zone: string = systemZone()): string {
  if (!looked) return "This is your first look.";
  const at = new Date(looked);
  const sameDay = dayAt(at, 0, zone).date === dayAt(now, 0, zone).date;
  return `Your last look was at ${timeIn(at, zone)}${sameDay ? "" : " (an earlier day)"}.`;
}

// How the daily brief reaches the owner, for the instruction: the mail provider's own words, or the chat alone when there is no mail.
const briefHow = (): string => (settings.mail ? mailSlot()!.brief.how() : "There is no email in this setup: your final answer is the whole brief itself, in the skill's format.");

// The fixed text of one look, as the judge's standing provenance and the start of the prompt. Written by code from the preset and the conversation's capabilities; no mail, no chat in it.
export function lookInstruction(now: Date, looked: string | undefined, looker: Looker = lookerOf(owner())): string {
  const today = dayAt(now, 0, looker.zone);
  return heartbeatInstruction({
    now: `${WEEKDAYS[today.weekday]} ${today.date} ${timeIn(now, looker.zone)}`,
    timeZone: looker.zone,
    lastLook: lastLookText(looked, now, looker.zone),
    quietFrom: `${String(settings.quietStartHour).padStart(2, "0")}:00`,
    quietTo: `${String(settings.quietEndHour).padStart(2, "0")}:00`,
    dayMinutes: String(settings.heartbeatDayMinutes),
    delegated: looker.experts ? delegatedText(expertSetup(looker.skills, "")) : "",
    briefTime: preset().rhythm.heartbeat.briefTime,
    briefOverdueHour: `${String(preset().rhythm.heartbeat.briefOverdueHour).padStart(2, "0")}:00`,
    briefHow: looker.brief ? briefHow() : "",
    who: looker.who,
    own: looker.own,
    reads: looker.reads,
    mail: looker.mail,
    experts: looker.experts,
    brief: looker.brief,
    sources: looker.sources,
  });
}

export const lookPrompt = (now: Date, instruction: string, tail: readonly string[], zone?: string): string =>
  [clockLine(now, zone), instruction, `The recent chat and what you already did on your own (data, do not repeat it):\n${fence("chat_log", tail.join("\n") || "(none)")}`].join("\n\n");

export function createHeartbeatLook(deps: HeartbeatDeps) {
  const { pipeline } = deps;
  const file = deps.rowsFile ?? HEARTBEAT_LOG;

  // One look of one conversation. Returns what happened (for the log and tests).
  async function look(conv: Conversation, st: LookState, now: Date): Promise<string> {
    const tagged = conv.kind === "group" && settings.groupParticipation === "tagged"; // there only a tag counts as news
    if (!lookDue(st, now, { notesChangedMs: deps.notesChangedAt(conv.notesDir), messagesCount: !tagged })) return "not-due";
    if (!hasSomethingToLookAt(conv, now)) return "nothing-to-look-at"; // no mail, calendar or tasks to read and no note: a model call for nothing
    // One run at a time per conversation: while a turn of it is settling, queued or running (the owner has just written and is being answered), the look waits. Nothing is
    // recorded and nothing is dropped: it is still due, and the next tick (a few minutes) looks again.
    if (pipeline.busy(conv)) return "busy";
    // A look is a model run on someone's account (a friend's: the instance key, billed to her): paused, in a cooldown or past the day's budget means no run, nothing recorded, and the next tick looks again.
    const access = deps.may(conv, "heartbeat look");
    if (isRefusal(access)) return deps.why(access);

    // Written BEFORE acting: a crash in the run must not mean a retry on every tick.
    recordWake(pipeline, conv, settings.heartbeatDayMinutes, now, clampLook);
    const looker = lookerOf(conv);
    const night = inQuietHours(now, settings.quietStartHour, settings.quietEndHour, looker.zone);
    let toolCalls = 0;
    let archived = 0;
    let delegations = 0;
    const seenMail = createSeenMail(seenFileOf(conv)); // the ids the run is told are new count as seen only if this look ends well
    let sent = 0; // pieces the run (or its expert) sent with the send tool while it worked
    const instruction = lookInstruction(now, st.wake?.looked, looker);
    let reply: { text: string; costUsd?: number; structured?: unknown } | undefined;
    let failure: unknown; // what the run threw (notices.ts names the cause when looks keep failing)
    try {
      reply = await pipeline.sendWhile(
        conv,
        () =>
          deps.run(conv, access, lookPrompt(now, instruction, logTail(conv, 40), looker.zone), {
            provenance: { kind: "standing", task: instruction },
            seenMail,
            onDelegate: () => void delegations++,
            onToolSuccess: (tool) => {
              toolCalls++;
              if (entryFor(tool)?.action === "archive") archived++;
            },
          }),
        () => void sent++,
      );
    } catch (e) {
      failure = e;
      console.error(`heartbeat: the ${conv.kind} run failed:`, (e as Error).message);
    }

    const answer = reply ? parseAnswer(reply.structured, reply.text) : undefined;
    let outcome: HeartbeatRow["outcome"] = reply ? "silent" : "failed";
    countPosts(conv, sent, now); // (what the run sent while it worked counts toward the day's cap)
    if (answer?.message) {
      const message = answer.message;
      // Quiet hours and the day's cap are kept here, in code (notices.ts): an unprompted post inside them is held for one combined message later, unless the run marked it urgent.
      if (submitPost(conv, message, answer.urgent, now) === "held") pipeline.record(conv, "action", Date.now(), `[heartbeat] held for later (quiet hours or the day's limit): ${message.slice(0, 300)}`);
      else {
        const res = await postNotice(pipeline, conv, message, reply?.costUsd);
        if (res.error) console.error("heartbeat: could not post:", (res.error as Error).message);
        outcome = res.error ? "failed" : res.spoke ? "posted" : "silent";
      }
    }
    observeLook(conv, outcome, failure, now);
    if (outcome === "failed") seenMail.discard();
    else seenMail.commit();
    if (sent > 0 && outcome === "silent") outcome = "posted"; // it spoke while it worked, and its final answer had nothing to add
    if (toolCalls > 0) pipeline.record(conv, "action", Date.now(), `[heartbeat] look: ${toolCalls} tool call(s), ${archived} mail archived${delegations > 0 ? `, ${delegations} delegated` : ""}, ${outcome === "posted" ? "message sent" : "no message"}`);
    audit("wake", outcome, onLogin(conv) ? "background" : "group"); // (a friend's rows carry no words: permissions.ts)
    appendRow({ at: now.toISOString(), kind: conv.kind, night, message: outcome === "posted", sent, nextCheckMinutes: answer?.nextCheckMinutes ?? clampLook(undefined), costUsd: reply?.costUsd ?? 0, toolCalls, archived, delegations, outcome }, file);
    recordWake(pipeline, conv, answer?.nextCheckMinutes ?? settings.heartbeatDayMinutes, now, clampLook); // after the act: notes it wrote are not news
    return outcome;
  }

  return { look };
}
