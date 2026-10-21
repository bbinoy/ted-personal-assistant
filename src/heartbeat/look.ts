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
import { isReadTool } from "../policy/policy.ts";
import { entryFor } from "../policy/toolmanifest.ts";
import type { RunProvenance } from "../approvals/autojudge.ts";
import { clampLook, parseHeartbeatAnswer } from "../run/rules.ts";
import { createSeenMail, type SeenMail } from "../modules/seenmail/seenmail.ts";
import { hasSomethingToLookAt, lookerOf, type Looker } from "../run/scope.ts";
import { RunStopped } from "../run/ceiling.ts";
import { hasOpen } from "../approvals/approvals.ts";
import { flushPending } from "../approvals/pendingflow.ts";
import { appendRow, type HeartbeatRow } from "./rows.ts";
import { observeLook, postNotice, submitPost } from "./notices.ts";
import { gateSink } from "../modules/send/send.ts";

// A conversation's heartbeat run: the ONLY way anything acts on its own, for the owner, every group and every friend alike. When a look is due (the next look the model
// chose, something was said, a note that changed), there is something to look at (scope.ts) and mayRun allows it (payer.ts: pause, cooldown, the day's budget, a friend's
// key and her own budget), ONE run starts under the "heartbeat" profile: a fresh session on HEARTBEAT_MODEL with the conversation's own persona, notes, skills and tools
// (the owner's connectors; a friend's or a group's are what its capability set holds), the time in its zone and the tail of its chat log up front. It reads what it needs
// (mail, calendar, Notion tasks, older chat) and acts through the unchanged floor -> judge -> phone path, with `standing` provenance (the fixed instruction below is what the
// judge reads as the reason for the run; no message of anyone's led there) and the conversation's own approver (a question is asked in the chat that triggered it).
// It answers with a message or [[silent]] and the minutes until its next look.
// What code keeps whatever the model decides: pause and mayRun, the next look clamped to 10..120 minutes also at night, and one row per look in instance/heartbeat.jsonl (counts, never words).

export interface RunExtra {
  onToolSuccess?: (tool: string, input: unknown) => void;
  provenance?: RunProvenance;
  onDelegate?: (agent: string) => void;
  seenMail?: SeenMail; // this look's tracker of the inbox mail already worked through
  signal?: AbortSignal; // the look is called off (a message overtook it): the run stops, or never starts if it still waits for a place (rungate.ts)
}

export interface HeartbeatDeps {
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record" | "sendWhile" | "busy"> & Partial<Pick<Pipeline, "lease">>;
  awaitingApproval?: (conv: Conversation) => boolean; // is a question of the look open in the chat (default approvals.ts hasOpen): a message then does not call the look off
  run: (conv: Conversation, payer: Payer, prompt: string, extra: RunExtra) => Promise<{ text: string; costUsd?: number; structured?: unknown }>; // agent.ts runHeartbeat
  may: (conv: Conversation, what: string) => Payer | Refusal;
  why: (r: Refusal) => string;
  notesChangedAt: (dir: string) => number;
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

// How a conversation's recent looks ended, for the starvation guard below.
export interface LookHistory {
  preempted: number; // consecutive looks that ended preempted, up to now
  completedAt?: number; // ms: when the last look that was not preempted began
}

// May a message call the running look off? Not if that would starve it: a conversation that chats steadily would otherwise preempt every look, and triage (the mail, the brief) would
// never finish while each aborted look still costs money. So a look is preemptible only while (a) fewer than 2 looks in a row ended preempted and (b) the last look that was not
// preempted is younger than 2x the look interval (30 minutes at least). Otherwise it runs to completion (the message is still news: a read-only look's post is dropped as stale).
export function preemptible(h: LookHistory, nowMs: number, intervalMinutes: number): boolean {
  if (h.preempted >= 2) return false;
  return h.completedAt === undefined || nowMs - h.completedAt < Math.max(2 * intervalMinutes, 30) * 60_000;
}

export function createHeartbeatLook(deps: HeartbeatDeps) {
  const { pipeline } = deps;
  const history = new Map<string, LookHistory>(); // per conversation, in memory (a restart starts fresh)

  // One look of one conversation. Returns what happened (for the log and tests).
  async function look(conv: Conversation, st: LookState, now: Date): Promise<string> {
    const tagged = conv.kind === "group" && settings.groupParticipation === "tagged"; // there only a tag counts as news
    if (!lookDue(st, now, { notesChangedMs: deps.notesChangedAt(conv.notesDir), messagesCount: !tagged })) return "not-due";
    if (!hasSomethingToLookAt(conv, now)) return "nothing-to-look-at"; // no mail, calendar or tasks to read and no note: a model call for nothing
    // The conversation's lease (conversation.ts): a look never STARTS while a turn of it is settling, queued or running (the owner has just written and is being answered); it
    // waits, nothing is recorded or dropped, it is still due and the next tick (a few minutes) looks again. Once it runs (outside the queue: it may wait hours on an approval)
    // a message to the conversation OVERTAKES it: the look is called off unless it waits on an approval, and a closing message-only post is dropped when news came meanwhile.
    if (pipeline.busy(conv)) return "busy";
    // A look is a model run on someone's account (a friend's: the instance key, billed to her): paused, in a cooldown or past the day's budget means no run, nothing recorded, and the next tick looks again.
    const access = deps.may(conv, "heartbeat look");
    if (isRefusal(access)) return deps.why(access);

    // Written BEFORE acting: a crash in the run must not mean a retry on every tick.
    recordWake(pipeline, conv, settings.heartbeatDayMinutes, now, clampLook);
    const looker = lookerOf(conv);
    const night = inQuietHours(now, settings.quietStartHour, settings.quietEndHour, looker.zone);
    let toolCalls = 0;
    let acted = 0; // tool calls that are not reads (listing the inbox or asking seen_mail is looking, not acting)
    let archived = 0;
    let delegations = 0;
    const seenMail = createSeenMail(conv.convId); // the ids the run is told are new count as seen only if this look ends well
    let sent = 0; // pieces the run (or its expert) sent with the send tool while it worked
    const instruction = lookInstruction(now, st.wake?.looked, looker);
    let reply: { text: string; costUsd?: number; structured?: unknown } | undefined;
    let failure: unknown; // what the run threw (notices.ts names the cause when looks keep failing)
    const overtaken = new AbortController();
    const h = history.get(conv.key) ?? { preempted: 0 };
    history.set(conv.key, h);
    const callOff = () => {
      if (preemptible(h, now.getTime(), settings.heartbeatDayMinutes)) overtaken.abort();
      else console.log(`heartbeat: a message came while the ${conv.kind} look ran; it is not called off (${h.preempted} preempted in a row, or the last full look is old)`);
    };
    const lease = pipeline.lease?.(conv, callOff, () => (deps.awaitingApproval ?? ((c) => hasOpen(c.key)))(conv));
    try {
      reply = await pipeline.sendWhile(
        conv,
        () => {
          // What the run sends with the send tool is held like its final answer (quiet hours, the day's cap) unless it says urgent (notices.ts).
          gateSink(conv.key, (text, urgent) => {
            if (submitPost(conv, text, urgent, now) !== "held") return undefined;
            pipeline.record(conv, "action", Date.now(), `[heartbeat] held for later (quiet hours or the day's limit): ${text.slice(0, 300)}`);
            return "Not sent now: it is quiet hours or today's limit of unprompted messages is spent, so it is held and will be delivered later with your other messages. Do not send it again.";
          });
          return deps.run(conv, access, lookPrompt(now, instruction, logTail(conv, 40), looker.zone), {
            provenance: { kind: "standing", task: instruction },
            seenMail,
            signal: overtaken.signal,
            onDelegate: () => void delegations++,
            onToolSuccess: (tool) => {
              toolCalls++;
              if (!isReadTool(tool) && tool !== "mcp__seenmail__seen_mail") acted++;
              if (entryFor(tool)?.action === "archive") archived++;
            },
          });
        },
        () => void sent++,
      );
    } catch (e) {
      failure = e;
      if (!overtaken.signal.aborted && !(e instanceof RunStopped)) console.error(`heartbeat: the ${conv.kind} run failed:`, (e as Error).message);
    } finally {
      lease?.end();
    }
    // What the run needed a yes for did not hold it up (approvals/pendingflow.ts): the look is over, so it is asked now, as one numbered message (held in quiet hours).
    await flushPending(conv.key, { ended: true }).catch((e) => console.error("heartbeat: could not ask the parked approvals:", (e as Error).message));

    const answer = reply ? parseHeartbeatAnswer(reply.structured, reply.text) : undefined;
    const calledOff = overtaken.signal.aborted || failure instanceof RunStopped; // a message overtook it, or the owner said /stop: not a failure
    let outcome: HeartbeatRow["outcome"] = reply ? "silent" : calledOff ? "preempted" : "failed";
    const stale = !!lease?.news() && acted === 0 && sent === 0; // news came while it looked and it did nothing but read: what it would say was written for a log that has moved on
    if (answer?.message && !stale) {
      const message = answer.message;
      // Quiet hours and the day's cap are kept here, in code (notices.ts): an unprompted post inside them is held for one combined message later, unless the run marked it urgent.
      if (submitPost(conv, message, answer.urgent, now, answer.needsYou) === "held") pipeline.record(conv, "action", Date.now(), `[heartbeat] held for later (quiet hours or the day's limit): ${message.slice(0, 300)}`);
      else {
        const res = await postNotice(pipeline, conv, message, reply?.costUsd);
        if (res.error) console.error("heartbeat: could not post:", (res.error as Error).message);
        outcome = res.error ? "failed" : res.spoke ? "posted" : "silent";
      }
    }
    if (outcome === "preempted") h.preempted++;
    else (h.preempted = 0, (h.completedAt = now.getTime()));
    if (outcome !== "preempted") observeLook(conv, outcome, failure, now);
    if (outcome === "failed" || outcome === "preempted" || (stale && !!answer?.message)) seenMail.discard(); // (a post dropped as stale reported mail nobody heard of: it is raised again at the next look)
    else seenMail.commit();
    if (sent > 0 && outcome === "silent") outcome = "posted"; // it spoke while it worked, and its final answer had nothing to add
    if (toolCalls > 0) pipeline.record(conv, "action", Date.now(), `[heartbeat] look: ${toolCalls} tool call(s), ${archived} mail archived${delegations > 0 ? `, ${delegations} delegated` : ""}, ${outcome === "posted" ? "message sent" : "no message"}`);
    audit("wake", outcome, onLogin(conv) ? "background" : "group"); // (a friend's rows carry no words: permissions.ts)
    appendRow({ at: now.toISOString(), kind: conv.kind, night, message: outcome === "posted", sent, nextCheckMinutes: answer?.nextCheckMinutes ?? clampLook(undefined), costUsd: reply?.costUsd ?? 0, toolCalls, archived, delegations, outcome });
    recordWake(pipeline, conv, answer?.nextCheckMinutes ?? settings.heartbeatDayMinutes, now, clampLook); // after the act: notes it wrote are not news
    return outcome;
  }

  return { look };
}
