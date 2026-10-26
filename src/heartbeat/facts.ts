import { ledgerEntries, withoutDeleted, type Sent } from "../core/messages.ts";
import { openCount } from "../approvals/approvals.ts";
import type { Conversation } from "../conversation/conversation.ts";
import { fence } from "../core/fence.ts";
import { dayAt, dayIn, timeIn } from "../core/timezone.ts";
import { PLUGIN } from "../core/preset.ts";
import { settings } from "../core/settings.ts";
import { takeWelcome } from "../core/welcome.ts";
import { mailSlot } from "../modules/index.ts";
import { briefDelivered, learnedFact } from "../memory/learned.ts";
import { variantOf } from "../run/delegation.ts";
import { lookerOf } from "../run/scope.ts";
import { resultText } from "../modules/browse/browseguard.ts";
import { scheduledIn } from "../modules/tasks/routinelist.ts";
import { reminderFacts } from "../tasks/remind.ts";
import { meetingFacts } from "../tasks/meetings.ts";
import { tasksFacts } from "../tasks/render.ts";
import { activeItems } from "../tasks/store.ts";
import { markStarted, markTold, routineFacts, routineOfAgent, routineStatus, settleRoutines, type Routine } from "../tasks/routines.ts";
import { failingLooksFact, takeHeld, type Held } from "./notices.ts";
import { afterLook, waitingReminders } from "./remindtick.ts";
import { afterPrep, waitingMeetings } from "./preptick.ts";

// THE FACTS CODE HANDS A RUN (CLAUDE.md §2: one agent, whatever started it). The heartbeat look and every chat turn (the owner's, a friend's, a group's) call `factsFor` and get the same
// facts for their conversation: held posts, reminders due, meetings to prepare, a friend's learned changes, the welcome, a due routine or routine note, and as information the own posts of the last days,
// what was added to the list on its own and a long run of failing looks. Whichever run comes first says them; each is delivered AT MOST ONCE:
//   * the claimed ones (held posts, reminders, meetings, learned, routines) are PENDING while the run that took them is going (`busy`, in memory): another run of the conversation does not get
//     them. `done` settles them when the run ends: the same rule as before for a look (reminders: posted, or held and not urgent; learned: posted or held; prep: posted only; held posts and a skipped
//     routine's mention: the look ended posted or silent), and for a chat turn "said" means the reply carried words (a [[silent]] or reaction-only turn tells nothing and leaves them for the next run).
//   * a failed or called-off run leaves them for the next one. The claims themselves (a reminder, a meeting, a routine's period) are still written by the ticks and the planner in code.
// A look's own bookkeeping (when its next look is) is not a fact: it is part of the look's answer.

export const OWN_POSTS_DAYS = 7;
export const OWN_POSTS_MAX = 15;
const OWN_POST_CHARS = 100;
export const HELD_MAX = 8;
const HELD_CHARS = 400;

// Whitespace collapsed, cut at a word boundary: a post quoted in a fact block.
export function oneLine(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

// What this conversation's own looks posted in the last OWN_POSTS_DAYS (kind `notice` in its log: the looks' posts, a held post handed on), newest first, at most OWN_POSTS_MAX, each its first
// ~100 characters: the chat tail of a busy log can be shorter than a week, and a daily fact must not come round again. "" when there is none.
export function ownPostsBlock(entries: readonly Sent[], now: Date, zone: string): string {
  const since = now.getTime() - OWN_POSTS_DAYS * 86_400_000;
  const posts = entries.filter((e) => e.kind === "notice" && Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime()).slice(-OWN_POSTS_MAX).reverse();
  if (posts.length === 0) return "";
  const lines = posts.map((e) => `[${dayIn(new Date(e.at), zone)} ${timeIn(new Date(e.at), zone)}] ${oneLine(e.text, OWN_POST_CHARS)}`);
  return `Your own posts here in the last ${OWN_POSTS_DAYS} days (newest first):\n${fence("own_posts", lines.join("\n"))}\nDo not repeat a fact, joke, quote or idea you posted in the last ${OWN_POSTS_DAYS} days; a recurring post (daily fact, pep talk) must be new each time.`;
}

// Everything held back (notices.ts takeHeld, newest first: quiet hours, /quiet or the day's cap) as a fact block written by code: what was written when and that it was not delivered, at most HELD_MAX,
// each trimmed. The run says again only what is still true today, in today's words; "" when there is none.
export function heldBlock(held: readonly Pick<Held, "text" | "at">[], now: Date, zone: string): string {
  if (held.length === 0) return "";
  const today = dayIn(now, zone);
  const yesterday = dayAt(now, -1, zone).date;
  const when = (at: number | undefined): string => {
    if (at === undefined) return "earlier";
    const day = dayIn(new Date(at), zone);
    return `${timeIn(new Date(at), zone)} ${day === today ? "today" : day === yesterday ? "yesterday" : `on ${day}`}`;
  };
  const lines = held.slice(0, HELD_MAX).map((h) => `Held back and not sent (written ${when(h.at)}): "${oneLine(h.text, HELD_CHARS)}"`);
  return `${fence("held_posts", lines.join("\n"))}\nThese were not delivered. Say again only what is still true and still matters now, in today's words; anything outdated or already resolved (check the journal, the brief status line, the chat log) you drop silently.`;
}

// How the daily brief reaches the owner, for its fact line: the mail provider's own words, or the chat alone when there is no mail. Any other routine: the chat message alone.
export const deliverHow = (r: Routine): string =>
  r.skill === "daily-brief" ? `How to deliver: ${settings.mail ? mailSlot()!.brief.how() : "There is no email in this setup: your final answer is the whole brief itself, in the skill's format."}` : "";

// What is pending in a run right now, per conversation (memory only: a restart ends every run, so nothing can be stuck).
const busy = new Map<string, Set<string>>();
const isBusy = (key: string, id: string): boolean => busy.get(key)?.has(id) ?? false;

export type Kind = "look" | "chat";

/** How the run ended. `ended`: it went well (a look posted or stayed silent; a chat turn replied). `said`: it told the person something. `held`: what it said was held for later. `abandoned`: called off or failed, nothing is settled. `sends`: pieces it sent while it worked. */
export interface End {
  ended: boolean;
  said: boolean;
  held?: boolean;
  abandoned?: boolean;
  sends?: number;
  acted?: number; // tool calls of the run that were not reads
}

export interface Facts {
  blocks: string[]; // the claimed facts, delivered once (in the prompt, fenced where they quote anything)
  status: string[]; // information that is not claimed: own posts, what was added to the list, failing looks (a chat session is told only when these change)
  routines: string; // a look: the routines section of its instruction (what to delegate or do now); a chat turn: "" (it only sees their status)
  untrusted: boolean; // a block carries a mail's words (a task made from mail): acting on it is judged like acting on the mail
  onDelegate(agent: string): void; // the run handed a task to its expert
  onTool(tool: string, input: unknown, response?: unknown): void; // a tool of the run succeeded
  done(end: End): void; // settle what the run was handed, once, and release it
}

/** The facts of a conversation for one run at `now`. Reuses the per-fact planners and records (notices, remindtick, preptick, memory/learned, tasks/*); this only picks, holds and settles them. */
export function factsFor(conv: Conversation, now: Date, kind: Kind): Facts {
  const looker = lookerOf(conv);
  const t = now.getTime();
  const zone = looker.zone;
  const mine = new Set<string>();
  const grab = (id: string): boolean => {
    if (isBusy(conv.key, id)) return false;
    (busy.get(conv.key) ?? busy.set(conv.key, new Set()).get(conv.key)!).add(id);
    mine.add(id);
    return true;
  };

  const held = (() => {
    const h = takeHeld(conv, now); // (pending: deleted in done only when the run ended well)
    return h.held.length && grab("held") ? h : { held: [] as Held[], done: () => {} };
  })();
  const welcome = looker.own ? takeWelcome() : ""; // (once ever, on the owner's first run, whichever it is)
  const handed = looker.tasks ? waitingReminders(conv).filter((w) => grab(`rem:${w.item.id}|${w.key}`)) : [];
  const prepping = looker.meetings ? waitingMeetings(conv).filter((m) => grab(`prep:${m.eventId}|${m.startMs}`)) : [];
  const learned = conv.kind === "tenant" && !isBusy(conv.key, "learned") ? learnedFact(conv.convId, conv.notesDir, t) : undefined; // a friend's notes that changed on their own (memory/learned.ts)
  if (learned) grab("learned");
  const tasks = looker.tasks ? tasksFacts(conv.key, t, zone) : { text: "", fromMail: false };
  const dueFacts = looker.tasks ? reminderFacts(handed, kind === "look" ? activeItems(conv.key) : [], { now: t, zone, group: conv.kind === "group" }) : "";
  const skill = `${PLUGIN}:meeting-prep`;
  const prepFacts = meetingFacts(prepping, { now: t, zone, skill: looker.skills.includes(skill) ? skill : undefined });

  // The routines (tasks/routines.ts): the scheduled skills this conversation has (the daily brief among them) and its routine notes. EVERY run sees their status; only a look acts on them, one per look: a skill is delegated to its
  // expert (recorded as started at the delegation), a note is done by the look itself (started when it is handed, done when the look posted, sent or acted). A chat turn never starts one. A routine the look is handed is pending
  // (`busy`), and the record says started, so no second look runs it.
  const started = new Set<string>();
  const finished = new Set<string>();
  let selfMailed = 0; // routine emails sent to the owner (Gmail send_message, Mailbird's self briefing): like a send, they cannot be taken back
  const { routines: ownRoutines, broken } = scheduledIn({ skills: looker.skills, notesDir: conv.notesDir, zone, now });
  const routines = kind === "look" ? routineFacts(conv.convId, ownRoutines.filter((r) => (!r.skill || looker.experts) && !isBusy(conv.key, `routine:${r.name}`)), now, zone, { catchUpHours: settings.routineCatchUpHours, who: looker.who, agentOf: variantOf, approvals: openCount(conv.key), deliver: deliverHow }) : undefined;
  const routineNames = [...(routines?.due ? [routines.due.routine.name] : []), ...(routines?.told ?? [])];
  for (const n of routineNames) grab(`routine:${n}`);
  const start = (name: string): void => {
    if (!started.has(name) && routines?.due?.routine.name === name) (started.add(name), markStarted(conv.convId, name, routines.due.plan.slot.date, Date.now())); // (a second delegation of the same routine is not another attempt)
  };
  if (routines?.due && !routines.due.routine.skill) start(routines.due.routine.name);

  const blocks = [heldBlock(held.held, now, zone), welcome, dueFacts, prepFacts, learned ? fence("notes_changed_facts", learned.text) : "" ].filter(Boolean);
  const status = [ownPostsBlock(withoutDeleted(ledgerEntries(conv.logFile)), now, zone), tasks.text && fence("task_list_facts", tasks.text), routineStatus(conv.convId, ownRoutines, now, zone, settings.routineCatchUpHours), broken.length ? `Routine notes that will never run, fix their when: line (front matter, a repeat rule like "every weekday at 18:30"): ${broken.join("; ")}.` : "", failingLooksFact(conv)].filter(Boolean);
  let settled = false;
  return {
    blocks,
    status,
    routines: routines?.text ?? "",
    untrusted: tasks.fromMail,
    onDelegate: (agent) => {
      const r = routines?.due && routineOfAgent([routines.due.routine], agent, variantOf);
      if (r) start(r.name);
    },
    onTool: (tool, input, response) => {
      const args = (input ?? {}) as { subagent_type?: unknown };
      const due = routines?.due?.routine;
      if (due && (tool === "Agent" || tool === "Task") && typeof args.subagent_type === "string" && routineOfAgent([due], args.subagent_type, variantOf) && started.has(due.name) && resultText(response).trim()) finished.add(due.name); // the expert came back with a result (a run that ran out of turns has none)
      if (tool === "mcp__claude_ai_Gmail__send_message" || tool === "mcp__mailbird__send_self_briefing") selfMailed++;
    },
    done: (end) => {
      if (settled) return;
      settled = true;
      const abandoned = end.abandoned ?? false;
      const sends = (end.sends ?? 0) + selfMailed;
      try {
        if (end.ended) held.done(); // (a failed or called-off run leaves the held posts for the next one)
        const note = routines?.due && !routines.due.routine.skill ? routines.due.routine.name : undefined;
        if (note && end.ended && (end.said || end.held || sends > 0 || (end.acted ?? 0) > 0)) finished.add(note); // (a routine note is done once the look posted, sent or acted; silent without acting is a failed attempt)
        settleRoutines(conv.convId, started, finished, { calledOff: abandoned, sends }, Date.now());
        if (finished.has("daily-brief")) briefDelivered(conv.convId); // the "learned overnight" list the brief carried is told now, not when the tool handed it out (memory/learned.ts)
        if (routines?.told.length && end.ended && !abandoned) markTold(conv.convId, routines.told);
        if (handed.length && (kind === "look" || end.said)) afterLook(conv, handed, { posted: end.said, held: !!end.held }, Date.now(), zone);
        if (prepping.length && (kind === "look" ? !abandoned : end.said)) afterPrep(conv, prepping, end.said, t); // (a look a message overtook leaves them claimed: the next run is handed them)
        if (learned && (end.said || end.held)) learned.told();
      } finally {
        for (const id of mine) busy.get(conv.key)?.delete(id);
      }
    },
  };
}

// Used by tests: forget every pending claim.
export const resetFacts = (): void => busy.clear();
