import { emit } from "../core/events.ts";
import { convIdOfKey, convPaths } from "../core/convpaths.ts";
import { ledgerEntries, withoutDeleted, type Sent } from "../core/messages.ts";
import { isNonAction, journalable } from "../approvals/journalrender.ts";
import { clockLine } from "../core/brief.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { owner } from "../conversation/conversationmodel.ts";
import { onLogin } from "../core/ownerkey.ts";
import { fence } from "../core/fence.ts";
import { logTail } from "../conversation/gate.ts";
import { lookDue, recordWake, type LookState } from "../conversation/ledger.ts";
import { isRefusal, type Payer, type Refusal } from "../tenants/payer.ts";
import { heartbeatInstruction } from "../run/persona.ts";
import { delegatedText, expertSetup, variantOf } from "../run/delegation.ts";
import { mailSlot } from "../modules/index.ts";
import { PLUGIN, preset } from "../core/preset.ts";
import { settings } from "../core/settings.ts";
import { dayAt, dayIn, inQuietHours, systemZone, timeIn } from "../core/timezone.ts";
import { isReadTool } from "../policy/policy.ts";
import { entryFor } from "../policy/toolmanifest.ts";
import type { RunProvenance } from "../approvals/autojudge.ts";
import { clampLook, parseHeartbeatAnswer } from "../run/rules.ts";
import { createSeenMail, type SeenMail } from "../modules/seenmail/seenmail.ts";
import { hasSomethingToLookAt, lookerOf, type Looker } from "../run/scope.ts";
import { RunStopped, RunTimeout } from "../run/ceiling.ts";
import { failStartedNote, statusFact } from "../modules/status/statusnote.ts";
import { NOTES_DIR } from "../memory/notes.ts";
import { hasOpen, openCount } from "../approvals/approvals.ts";
import type { HeartbeatRow } from "../core/looks.ts";
import { failingLooksFact, observeLook, overnightWaiting, postNotice, submitPost, takeOvernight, type Held } from "./notices.ts";
import { oneLine } from "./digest.ts";
import { gateSink } from "../modules/send/send.ts";
import { tasksFacts } from "../tasks/render.ts";
import { reminderFacts } from "../tasks/remind.ts";
import { activeItems } from "../tasks/store.ts";
import { afterLook, remindersWaiting, waitingReminders } from "./remindtick.ts";
import { learnedFact } from "../memory/learned.ts";
import { resultText } from "../modules/browse/browseguard.ts";
import { markStarted, settleRoutines, markTold, routineFacts, routineOfAgent } from "../tasks/routines.ts";

// A conversation's heartbeat run: the ONLY way anything acts on its own, for the owner, every group and every friend alike. When a look is due (the next look the model
// chose, something was said, a note that changed), there is something to look at (scope.ts) and mayRun allows it (payer.ts: pause, cooldown, the day's budget, a friend's
// key and her own budget), ONE run starts under the "heartbeat" profile: a fresh session on HEARTBEAT_MODEL with the conversation's own persona, notes, skills and tools
// (the owner's connectors; a friend's or a group's are what its capability set holds), the time in its zone and the tail of its chat log up front. It reads what it needs
// (mail, calendar, Notion tasks, older chat) and acts through the unchanged floor -> judge path, with `standing` provenance (the fixed instruction below is what the
// judge reads as the reason for the run; no message of anyone's led there). It never asks anyone: what the judge is not sure about is not done (permissions.ts UNATTENDED_SKIP).
// It answers with a message or [[silent]] and the minutes until its next look.
// What code keeps whatever the model decides: pause and mayRun, the next look clamped to 10..120 minutes also at night, and one row per look in the looks table of instance.db (counts, never words).

export interface RunExtra {
  untrusted?: boolean;
  onToolSuccess?: (tool: string, input: unknown, response?: unknown) => void;
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
  clocks?: { wall: () => number; mono: () => number }; // (tests) the wall clock and the monotonic one (on macOS it stands still while the Mac sleeps)
}

// A run whose wall time exceeds its monotonic time by more than this spanned a sleep: whatever it ended with (a timeout, a dead connection) is the sleep's, not a failure.
export const SLEEP_DRIFT_MS = 60_000;

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
// `notesDir`: where the conversation's status notes are (the daily brief's state: its fact line is computed from there).
export function lookInstruction(now: Date, looked: string | undefined, looker: Looker = lookerOf(owner()), notesDir: string = NOTES_DIR, routineFacts = ""): string {
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
    briefFact: looker.brief ? statusFact("brief", now, looker.zone, notesDir) : "",
    briefHow: looker.brief ? briefHow() : "",
    routineFacts,
    who: looker.who,
    own: looker.own,
    reads: looker.reads,
    mail: looker.mail,
    experts: looker.experts,
    brief: looker.brief,
    sources: looker.sources,
    tasks: looker.tasks,
    meetings: looker.meetings,
    group: looker.group,
  });
}

// `facts`: code-built blocks for this look (ownPostsBlock, overnightBlock, the task list's facts, the owner's failing-looks fact; "" when empty). They are in the prompt, not in the instruction the judge reads as the run's standing reason
// (they quote what was posted, which can carry words of a mail or a page).
export const lookPrompt = (now: Date, instruction: string, tail: readonly string[], zone?: string, ...facts: string[]): string =>
  [clockLine(now, zone), instruction, ...facts, `The recent chat and what you already did on your own (data, do not repeat it):\n${fence("chat_log", tail.join("\n") || "(none)")}`].filter(Boolean).join("\n\n");

export const OWN_POSTS_DAYS = 7;
export const OWN_POSTS_MAX = 15;
const OWN_POST_CHARS = 100;
// What this conversation's own looks posted in the last OWN_POSTS_DAYS (kind `notice` in its log: the looks' posts, the digests), newest first, at most OWN_POSTS_MAX, each its first
// ~100 characters: the chat tail of a busy log can be shorter than a week, and a daily fact must not come round again. "" when there is none.
export function ownPostsBlock(entries: readonly Sent[], now: Date, zone: string): string {
  const since = now.getTime() - OWN_POSTS_DAYS * 86_400_000;
  const posts = entries.filter((e) => e.kind === "notice" && Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime()).slice(-OWN_POSTS_MAX).reverse();
  if (posts.length === 0) return "";
  const lines = posts.map((e) => `[${dayIn(new Date(e.at), zone)} ${timeIn(new Date(e.at), zone)}] ${oneLine(e.text, OWN_POST_CHARS)}`);
  return `Your own posts here in the last ${OWN_POSTS_DAYS} days (newest first):\n${fence("own_posts", lines.join("\n"))}\nDo not repeat a fact, joke, quote or idea you posted in the last ${OWN_POSTS_DAYS} days; a recurring post (daily fact, pep talk) must be new each time.`;
}

export const OVERNIGHT_MAX = 5;
const OVERNIGHT_CHARS = 400;
// The held posts of an earlier day (notices.ts takeOvernight, newest first) as a fact block written by code: what was not sent and when it was written, at most OVERNIGHT_MAX, each trimmed.
// The look says again only what is still true today, in today's words; "" when there is none.
export function overnightBlock(held: readonly Pick<Held, "text" | "at">[], now: Date, zone: string): string {
  if (held.length === 0) return "";
  const yesterday = dayAt(now, -1, zone).date;
  const when = (at: number | undefined): string => (at === undefined ? "earlier" : `${timeIn(new Date(at), zone)} ${dayIn(new Date(at), zone) === yesterday ? "yesterday" : `on ${dayIn(new Date(at), zone)}`}`);
  const lines = held.slice(0, OVERNIGHT_MAX).map((h) => `Held overnight and not sent (written ${when(h.at)}): "${oneLine(h.text, OVERNIGHT_CHARS)}"`);
  return `${fence("held_overnight", lines.join("\n"))}\nThese were not delivered. Say again only what is still true and still matters today, in today's words; anything outdated or already resolved (check the journal, the brief status line, the chat log) you drop silently.`;
}

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
  const clocks = deps.clocks ?? { wall: Date.now, mono: () => performance.now() };
  const history = new Map<string, LookHistory>(); // per conversation, in memory (a restart starts fresh)
  const inflight = new Set<AbortController>(); // the looks that are running now (abortAll)
  const slept = new WeakSet<AbortController>(); // those stopped because the Mac slept

  // One look of one conversation. Returns what happened (for the log and tests).
  async function look(conv: Conversation, st: LookState, now: Date): Promise<string> {
    const tagged = conv.kind === "group" && settings.groupParticipation === "tagged"; // there only a tag counts as news
    const looker0 = lookerOf(conv);
    if (!lookDue(st, now, { notesChangedMs: deps.notesChangedAt(conv.notesDir), messagesCount: !tagged }) && !overnightWaiting(conv, now) && !(looker0.tasks && remindersWaiting(conv))) return "not-due"; // (held posts of an earlier day: due once quiet ends; a reminder that came due: at once)
    if (!hasSomethingToLookAt(conv, now) && !(looker0.tasks && waitingReminders(conv).length)) return "nothing-to-look-at"; // no mail, calendar or tasks to read and no note: a model call for nothing
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
    const journalFile = convPaths(convIdOfKey(conv.key)).messages; // where the journal sink writes this conversation's lines
    const journaled = (): number => ledgerEntries(journalFile).filter((m) => m.kind === "journal").length;
    const journaledBefore = journaled();
    let steps = 0; // calls that could have a journal line (an action, not a read or plumbing)
    let acted = 0; // tool calls that are not reads (listing the inbox or asking seen_mail is looking, not acting)
    let archived = 0;
    let delegations = 0;
    const seenMail = createSeenMail(conv.convId); // the ids the run is told are new count as seen only if this look ends well
    let sent = 0; // pieces the run (or its expert) sent with the send tool while it worked
    // The routines besides the brief (core/routines.ts): only the owner's own look has them (a friend's or a group's skills never include them), and only with experts to delegate to.
    const routines = looker.own && looker.experts ? routineFacts(conv.convId, settings.routines.filter((r) => looker.skills.includes(`${PLUGIN}:${r.skill}`)), now, looker.zone, { catchUpHours: settings.routineCatchUpHours, who: looker.who, agentOf: variantOf, approvals: openCount(conv.key), ...(settings.mail ? { emailHow: () => mailSlot()!.brief.how(true, true) } : {}) }) : undefined;
    const started = new Set<string>(); // the routines this look handed to their expert
    const finished = new Set<string>(); // those whose expert's result came back with something in it
    let selfMailed = 0; // routine emails the expert sent to the owner (Gmail send_message, Mailbird's self briefing): like a send, they cannot be taken back
    const instruction = lookInstruction(now, st.wake?.looked, looker, conv.notesDir, routines?.text ?? "");
    const overnight = overnightBlock(takeOvernight(conv, now), now, looker.zone); // (handed over once: taken out of the held posts here)
    const tasks = looker.tasks ? tasksFacts(conv.key, now.getTime(), looker.zone) : { text: "", fromMail: false }; // what was added to the list on its own (tasks/render.ts): the look says it, if no look has yet
    const handed = looker.tasks ? waitingReminders(conv) : []; // reminders that came due (remindtick.ts): this look says them; only once it has are they journaled
    const dueFacts = looker.tasks ? reminderFacts(handed, activeItems(conv.key), { now: now.getTime(), zone: looker.zone, group: conv.kind === "group" }) : "";
    const taskBlock = [dueFacts, tasks.text].filter(Boolean).join("\n\n");
    let held = false; // something this look said was held for later (quiet hours, the day's cap)
    const failing = failingLooksFact(conv);
    const learned = conv.kind === "tenant" ? learnedFact(conv.convId, conv.notesDir, now.getTime()) : undefined; // a friend's notes that changed on their own (memory/learned.ts): the look says it, in its words
    let reply: { text: string; costUsd?: number; structured?: unknown } | undefined;
    let failure: unknown; // what the run threw (notices.ts names the cause when looks keep failing)
    const overtaken = new AbortController();
    const h = history.get(conv.key) ?? { preempted: 0 };
    history.set(conv.key, h);
    const callOff = () => {
      if (preemptible(h, now.getTime(), settings.heartbeatDayMinutes)) overtaken.abort();
      else console.log(`heartbeat: a message came while the ${conv.kind} look ran; it is not called off (${h.preempted} preempted in a row, or the last full look is old)`);
    };
    inflight.add(overtaken);
    const wall0 = clocks.wall();
    const mono0 = clocks.mono();
    const lease = pipeline.lease?.(conv, callOff, () => (deps.awaitingApproval ?? ((c) => hasOpen(c.key)))(conv));
    try {
      reply = await pipeline.sendWhile(
        conv,
        () => {
          // What the run sends with the send tool is held like its final answer (quiet hours, the day's cap) unless it says urgent (notices.ts).
          gateSink(conv.key, (text, urgent) => {
            if (submitPost(conv, text, urgent, now) !== "held") return undefined;
            held = true;
            emit({ type: "notice", state: "held", conv: conv.key, text, source: onLogin(conv) ? "background" : "group" });
            return "Not sent now: it is quiet hours or today's limit of unprompted messages is spent, so it is held and will be delivered later with your other messages. Do not send it again.";
          });
          return deps.run(conv, access, lookPrompt(now, instruction, logTail(conv, 40), looker.zone, ownPostsBlock(withoutDeleted(ledgerEntries(conv.logFile)), now, looker.zone), overnight, taskBlock && fence("task_list_facts", taskBlock), failing, learned ? fence("notes_changed_facts", learned.text) : ""), {
            provenance: { kind: "standing", task: instruction },
            ...(tasks.fromMail ? { untrusted: true } : {}), // a task made from a mail carries the mail's words: acting on it is judged like acting on the mail
            seenMail,
            signal: overtaken.signal,
            onDelegate: (agent) => {
              delegations++;
              const r = routines?.due && routineOfAgent([routines.due.routine], agent, variantOf);
              if (r && !started.has(r.name)) (started.add(r.name), markStarted(conv.convId, r.name, routines!.due!.plan.slot.date, Date.now())); // (a second delegation of the same routine is not another attempt)
            },
            onToolSuccess: (tool, input, response) => {
              toolCalls++;
              if (tool === "Agent" || tool === "Task") {
                const agent = (input as { subagent_type?: unknown } | undefined)?.subagent_type;
                const r = routines?.due && typeof agent === "string" ? routineOfAgent([routines.due.routine], agent, variantOf) : undefined;
                if (r && started.has(r.name) && resultText(response).trim()) finished.add(r.name); // the expert came back with a result (a run that ran out of turns has none)
              }
              if (tool === "mcp__claude_ai_Gmail__send_message" || tool === "mcp__mailbird__send_self_briefing") selfMailed++;
              if (!isReadTool(tool) && !isNonAction(tool) && tool !== "mcp__seenmail__seen_mail") acted++; // (handing in the answer is not acting: a stale post is still dropped)
              if (entryFor(tool)?.action === "archive") archived++;
              if (journalable(tool)) steps++;
            },
          });
        },
        () => void sent++,
      );
    } catch (e) {
      failure = e;
      if (!overtaken.signal.aborted && !(e instanceof RunStopped)) console.error(`heartbeat: the ${conv.kind} run failed:`, (e as Error).message);
    } finally {
      inflight.delete(overtaken);
      lease?.end();
    }

    const answer = reply ? parseHeartbeatAnswer(reply.structured, reply.text) : undefined;
    const spannedSleep = clocks.wall() - wall0 - (clocks.mono() - mono0) > SLEEP_DRIFT_MS; // the run spanned a sleep (the tick may not have noticed it yet): a timeout or a dead connection then is the sleep's
    const interrupted = !reply && (slept.has(overtaken) || spannedSleep); // the Mac slept: the connections are dead; a failed row, neutral for the failure tracker, due again at once
    const timedOut = !reply && failure instanceof RunTimeout; // aborted at its ceiling (ceiling.ts): the query and its subagents are stopped and the conversation's busy state is released
    const calledOff = !interrupted && (overtaken.signal.aborted || failure instanceof RunStopped); // a message overtook it, or the owner said /stop: not a failure
    let outcome: HeartbeatRow["outcome"] = reply ? "silent" : interrupted ? "failed" : calledOff ? "preempted" : timedOut ? "timeout" : "failed";
    if (timedOut) console.error(`heartbeat: the ${conv.kind} run timed out:`, (failure as Error).message);
    else if (interrupted) console.error(`heartbeat: the ${conv.kind} run was stopped: the Mac slept`);
    const stale = !!lease?.news() && acted === 0 && sent === 0; // news came while it looked and it did nothing but read: what it would say was written for a log that has moved on
    if (answer?.message && !stale) {
      const message = answer.message;
      // Quiet hours and the day's cap are kept here, in code (notices.ts): an unprompted post inside them is held for one combined message later, unless the run marked it urgent.
      if (submitPost(conv, message, answer.urgent, now, answer.needsYou) === "held") (held = true), emit({ type: "notice", state: "held", conv: conv.key, text: message, source: onLogin(conv) ? "background" : "group" });
      else {
        const res = await postNotice(pipeline, conv, message, reply?.costUsd);
        if (res.error) console.error("heartbeat: could not post:", (res.error as Error).message);
        outcome = res.error ? "failed" : res.spoke ? "posted" : "silent";
      }
    }
    if (outcome === "preempted") h.preempted++;
    else (h.preempted = 0, (h.completedAt = now.getTime()));
    const failed = outcome === "failed" || outcome === "timeout";
    const retry = failed ? clampLook(settings.heartbeatMinutes) : undefined; // a failed or timed-out look is due again on the next free ticks (the tick period, within the 10..120 rule), not after the day's 30 minutes
    // A look that ended badly after delegating the brief must not leave its note `started` for 45 minutes: the code marks it failed now, so the next look redoes it (heartbeat.md)
    if (failed && looker.brief && delegations > 0 && failStartedNote("brief", timedOut ? "the run timed out" : interrupted ? "the run was stopped, the Mac slept" : "the run failed", new Date(), conv.notesDir, looker.zone)) console.error("heartbeat: the brief's note was left 'started'; marked failed");
    // The routine this look handed on is delivered or failed now (a look only called off by a message does not count as an attempt); a skip it mentioned counts as told once the look is over and went well.
    // Delivered only when the expert's result came back; an attempt is given back only when nothing of it reached the owner (no result, no send, no email): else the next look would send it again.
    settleRoutines(conv.convId, started, finished, { calledOff: outcome === "preempted" || interrupted, sends: sent + selfMailed }, Date.now());
    if (routines?.told.length && !failed && outcome !== "preempted") markTold(conv.convId, routines.told);
    if (outcome !== "preempted" && !interrupted) observeLook(conv, outcome === "timeout" ? "failed" : outcome, failure, now, clocks.mono()); // (a sleep is neutral: neither a failure nor the end of a streak)
    if (failed || outcome === "preempted" || (stale && !!answer?.message)) seenMail.discard(); // (a post dropped as stale reported mail nobody heard of: it is raised again at the next look)
    else seenMail.commit();
    if (sent > 0 && outcome === "silent") outcome = "posted"; // it spoke while it worked, and its final answer had nothing to add
    afterLook(conv, handed, { posted: outcome === "posted", held }, Date.now(), looker.zone);
    if (learned && (outcome === "posted" || held)) learned.told(); // (told only if the look said something)
    // What the look DID is in the conversation's journal, one line per action as it happened (core/events.ts); the look itself is one audit row and one metrics row, told once.
    const unjournaled = steps > 0 && journaled() === journaledBefore ? steps : 0; // acted, yet no line of its own (browser steps): one short line, so the gate's "you acted without posting" survives
    emit({ type: "look", conv: conv.key, unjournaled, source: onLogin(conv) ? "background" : "group", row: { at: now.toISOString(), kind: conv.kind, night, message: outcome === "posted", sent, nextCheckMinutes: retry ?? answer?.nextCheckMinutes ?? clampLook(undefined), costUsd: reply?.costUsd ?? 0, toolCalls, archived, delegations, outcome } });
    if (interrupted) recordWake(pipeline, conv, 0, now, (m) => Number(m)); // it was cut off, not decided: due again at the next due-check (no 10-minute minimum)
    else recordWake(pipeline, conv, retry ?? answer?.nextCheckMinutes ?? settings.heartbeatDayMinutes, now, clampLook); // after the act: notes it wrote are not news
    return outcome;
  }

  // Stops every look that is running (the Mac slept: their connections are dead). Each one ends as a failed row and is due again at once.
  const abortAll = (reason: string): number => {
    const n = inflight.size;
    for (const c of inflight) (slept.add(c), c.abort(reason));
    return n;
  };

  return { look, abortAll };
}
