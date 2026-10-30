import { ledgerEntries, withoutDeleted, type Sent } from "../core/messages.ts";
import { forgetLapsed, lapsedIn, openCount, type Lapsed } from "../approvals/approvals.ts";
import { convDb } from "../core/convdb.ts";
import { told } from "../core/told.ts";
import type { Conversation } from "../conversation/conversation.ts";
import { fence } from "../core/fence.ts";
import { dayAt, dayIn, timeIn } from "../core/timezone.ts";
import { PLUGIN } from "../core/preset.ts";
import { takeWelcome } from "../core/welcome.ts";
import { lookerOf } from "../run/scope.ts";
import { resultText } from "../modules/browse/browseguard.ts";
import { brokenText, scheduledIn } from "../modules/tasks/routinelist.ts";

import { reminderFacts } from "../tasks/remind.ts";
import { meetingFacts } from "../tasks/meetings.ts";
import { tasksFacts } from "../tasks/render.ts";
import { activeItems } from "../tasks/store.ts";
import { mailSlot } from "../modules/index.ts";
import { inboxBlock } from "../tasks/maildecisions.ts";
import { markOwed, markStarted, markTold, planRoutine, readRecord, routineFacts, routineStatus, settleRoutines } from "../tasks/routines.ts";
import { capabilitiesOf } from "../policy/capabilities.ts";
import { whereaboutsFact } from "./whereabouts.ts";
import { failingLooksFact, takeHeld, type Held } from "./notices.ts";
import { afterLook, waitingReminders } from "./remindtick.ts";
import { afterPrep, waitingMeetings } from "./preptick.ts";
// A routine (a routine note) the Mac slept through still runs on waking within this many hours of its time, else that period is skipped.
const ROUTINE_CATCHUP_HOURS = 4;

// THE FACTS CODE HANDS A RUN (CLAUDE.md §2: one agent, whatever started it). The heartbeat look and every chat turn (the owner's, a friend's, a group's) call `factsFor` and get the same
// facts for their conversation: held posts, reminders due, meetings to prepare, the welcome, a due routine or routine note, and as information the own posts of the last days,
// what was added to the list on its own and a long run of failing looks. Whichever run comes first says them; each is delivered AT MOST ONCE:
//   * the claimed ones (held posts, reminders, meetings, routines) are PENDING while the run that took them is going (`busy`, in memory): another run of the conversation does not get
//     them. `done` settles them when the run ends: the same rule as before for a look (reminders: posted, or held and not urgent; prep: posted only; held posts and a skipped
//     routine's mention: the look ended posted or silent), and for a chat turn "said" means the reply carried words (a [[silent]] or reaction-only turn tells nothing and leaves them for the next run).
//   * a failed or called-off run leaves them for the next one. The claims themselves (a reminder, a meeting, a routine's period) are still written by the ticks and the planner in code.
// A look's own bookkeeping (when its next look is) is not a fact: it is part of the look's answer.

const OWN_POSTS_DAYS = 7;
const OWN_POSTS_MAX = 15;
const OWN_POST_CHARS = 100;
export const HELD_MAX = 8;
const HELD_CHARS = 400;

// Whitespace collapsed, cut at a word boundary: a post quoted in a fact block.
function oneLine(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

// What this conversation's own looks posted in the last OWN_POSTS_DAYS (kind `notice` in its log: the looks' posts, a held post handed on), newest first, at most OWN_POSTS_MAX, each its first
// ~100 characters: the chat tail of a busy log can be shorter than a week, and a daily fact must not come round again. "" when there is none.
function ownPostsBlock(entries: readonly Sent[], now: Date, zone: string): string {
  const since = now.getTime() - OWN_POSTS_DAYS * 86_400_000;
  const posts = entries.filter((e) => e.kind === "notice" && Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime()).slice(-OWN_POSTS_MAX).reverse();
  if (posts.length === 0) return "";
  const lines = posts.map((e) => `[${dayIn(new Date(e.at), zone)} ${timeIn(new Date(e.at), zone)}] ${oneLine(e.text, OWN_POST_CHARS)}`);
  return `Your own posts here in the last ${OWN_POSTS_DAYS} days (newest first):\n${fence("own_posts", lines.join("\n"))}\nDo not repeat a fact, joke, quote or idea you posted in the last ${OWN_POSTS_DAYS} days; a recurring post (daily fact, pep talk) must be new each time.`;
}

// Background approvals that lapsed unanswered (approvals.ts lapsedIn) and were not yet told to a look of this conversation: one line each, with how long ago (the label is the action as the approval details describe it).
const LAPSED_DAYS = 7;
const lapsedKey = (l: Lapsed) => `lapsed:${l.at}`;
function lapsedFact(convId: string, entries: readonly Lapsed[], now: number): string {
  const db = convDb(convId);
  const fresh = entries.filter((l) => now - l.at < LAPSED_DAYS * 86_400_000 && !db.get("SELECT 1 FROM told WHERE key = ?", lapsedKey(l)));
  if (!fresh.length) return "";
  const lines = fresh.map((l) => `${oneLine(l.label, 120)} (no answer within ${l.wait}; ${Math.max(1, Math.round((now - l.at) / 60_000))} min ago, nothing was done)`);
  return `Approvals that lapsed unanswered, nothing was done:\n${fence("lapsed_approvals", lines.join("\n"))}`;
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

// What is pending in a run right now, per conversation (memory only: a restart ends every run, so nothing can be stuck).
const busy = new Map<string, Set<string>>();
const isBusy = (key: string, id: string): boolean => busy.get(key)?.has(id) ?? false;


/** How the run ended. `ended`: it went well (a look posted or stayed silent; a chat turn replied). `said`: it told the person something. `held`: what it said was held for later. `abandoned`: called off or failed, nothing is settled. `sends`: pieces it sent while it worked. */
interface End {
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

/** The facts of a conversation for one run at `now`. Reuses the per-fact planners and records (notices, remindtick, preptick, tasks/*); this only picks, holds and settles them. */
export function factsFor(conv: Conversation, now: Date, attended: boolean): Facts {
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
  const tasks = looker.tasks ? tasksFacts(conv.key, t, zone) : { text: "", fromMail: false };
  const dueFacts = looker.tasks ? reminderFacts(handed, attended ? [] : activeItems(conv.key), { now: t, zone, group: conv.kind === "group" }) : "";
  const skill = `${PLUGIN}:meeting-prep`;
  const prepFacts = meetingFacts(prepping, { now: t, zone, skill: looker.skills.includes(skill) ? skill : undefined });

  // The routines (tasks/routines.ts): the scheduled skills this conversation has (the daily brief among them) and its routine notes. EVERY run sees their status; only a look acts on them, one per look: every routine is delegated
  // to an expert (a skill to its variant, a note to the general one; recorded as started at the delegation, done when the expert returned a result). A chat turn never starts one. A routine the look is handed is pending
  // (`busy`), and the record says started, so no second look runs it.
  const started = new Set<string>();
  const finished = new Set<string>();
  // A routine whose delivery REQUIRES a channel is complete only when that channel went out: the brief's email, by the mail provider's send-to-self tool (modules MailSlot.brief.tool; the skill's delivery line tells the run to use it).
  // Code looks at the run's successful tool calls (an expert's too); a routine that ended without it is failed and owes the email, so the retry path runs it again (routines.ts markOwed).
  const emailTool = looker.own && looker.mail ? mailSlot()?.brief.tool() : undefined;
  const emailed = (r: { instruction: string }): boolean => !!emailTool && /daily-brief/.test(r.instruction);
  let selfMailed = 0; // routine emails sent to the owner: like a send, they cannot be taken back
  const { routines: ownRoutines, broken } = scheduledIn({ notesDir: conv.notesDir, zone, now });
  const routines = attended ? undefined : routineFacts(conv.convId, ownRoutines.filter((r) => !isBusy(conv.key, `routine:${r.name}`)), now, zone, { catchUpHours: ROUTINE_CATCHUP_HOURS, who: looker.who, approvals: openCount(conv.key), });
  const routineNames = [...(routines?.due ? [routines.due.routine.name] : []), ...(routines?.told ?? [])];
  for (const n of routineNames) grab(`routine:${n}`);
  const start = (name: string): void => {
    if (!started.has(name) && routines?.due?.routine.name === name) (started.add(name), markStarted(conv.convId, name, routines.due.plan.slot.date, Date.now())); // (a second delegation of the same routine is not another attempt)
  };

  const lapsedNow = !attended && !isBusy(conv.key, "lapsed") ? lapsedIn(conv.key).slice() : [];
  const lapsed = lapsedFact(conv.convId, lapsedNow, t);
  if (lapsed) grab("lapsed");
  const blocks = [heldBlock(held.held, now, zone), welcome, dueFacts, prepFacts].filter(Boolean);
  const status = [looker.mail ? inboxBlock(conv.convId, t) : "", ownPostsBlock(withoutDeleted(ledgerEntries(conv.logFile)), now, zone), tasks.text && fence("task_list_facts", tasks.text), routineStatus(conv.convId, ownRoutines.filter((r) => r.name !== routines?.due?.routine.name), now, zone, ROUTINE_CATCHUP_HOURS), broken.length ? `Routine notes that will never run, fix their when: line (front matter, a repeat rule like "every weekday at 18:30"): ${broken.map(brokenText).join("; ")}.` : "", failingLooksFact(conv), lapsed, capabilitiesOf(conv).has("profile") ? whereaboutsFact(now, zone, looker.who) : ""].filter(Boolean);
  let settled = false;
  return {
    blocks,
    status,
    routines: routines?.text ?? "",
    untrusted: tasks.fromMail,
    onDelegate: () => {
      if (routines?.due) start(routines.due.routine.name); // (any expert: the general one, or a heavy skill's)
    },
    onTool: (tool, input, response) => {
      const args = (input ?? {}) as { subagent_type?: unknown };
      const due = routines?.due?.routine;
      if (due && (tool === "Agent" || tool === "Task") && typeof args.subagent_type === "string" && started.has(due.name) && resultText(response).trim()) finished.add(due.name); // the expert came back with a result (a run that ran out of turns has none)
      if (emailTool && tool === emailTool) selfMailed++;
    },
    done: (end) => {
      if (settled) return;
      settled = true;
      const abandoned = end.abandoned ?? false;
      const sends = (end.sends ?? 0) + selfMailed;
      try {
        if (end.ended) held.done(); // (a failed or called-off run leaves the held posts for the next one)
        const due = routines?.due?.routine.name;
        if (due && !end.ended) finished.delete(due); // (a routine's message is the look's answer: a look that failed or was called off leaves it for the retry)
        const owing = routines?.due && emailed(routines.due.routine) && started.has(routines.due.routine.name) && !selfMailed ? routines.due.routine.name : undefined;
        if (owing) (finished.delete(owing), markOwed(conv.convId, owing, "email", end.said || (end.sends ?? 0) > 0)); // (the chat may have gone out already: the retry owes only the email)
        settleRoutines(conv.convId, started, finished, { calledOff: abandoned, sends }, Date.now());
        if (routines?.told.length && end.ended && !abandoned) markTold(conv.convId, routines.told);
        if (handed.length && (!attended || end.said)) afterLook(conv, handed, { posted: end.said, held: !!end.held }, Date.now(), zone);
        if (prepping.length && (attended ? end.said : !abandoned)) afterPrep(conv, prepping, end.said, t); // (a look a message overtook leaves them claimed: the next run is handed them)
        if (lapsed && end.ended && !abandoned) {
          for (const l of lapsedNow) told(convDb(conv.convId), lapsedKey(l), { once: true });
          forgetLapsed(conv.key, lapsedNow);
        }
      } finally {
        for (const id of mine) busy.get(conv.key)?.delete(id);
      }
    },
  };
}

// Is a routine due right now (inside its slot and catch-up window, not started)? Then the conversation's look is due at once, like a claimed reminder: the 5-minute tick asks, no timer of its own.
export function routinesWaiting(conv: Conversation, now: Date): boolean {
  const looker = lookerOf(conv);
  const { routines } = scheduledIn({ notesDir: conv.notesDir, zone: looker.zone, now });
  return routines.some((r) => planRoutine(r, now, looker.zone, readRecord(conv.convId, r.name), ROUTINE_CATCHUP_HOURS).state === "due");
}
