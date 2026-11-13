// What an end-to-end case is (scripts/e2e-eval.ts): a trigger, a world the fakes start from, the scripted owner, and what is expected. All names, places and addresses are fictional (example.com / example.org).
import type { CalEvent, SeedEvent } from "./fakecalendar.ts";
import type { FakeMail, SeedMail, SentMail } from "./fakemail.ts";
import type { FakePage, Payment } from "./fakebrowser.ts";
import type { NotionPage, SeedDatabase } from "./fakenotion.ts";
import type { Item } from "../../src/tasks/store.ts";

// The frozen clock of a case: every date in the world is relative to it, and the run is told it as its clock (agent.ts runTurn, RunInputs.now).
export interface Time {
  now: Date;
  zone: string;
  today: string; // YYYY-MM-DD in the zone
  day(offset: number): string; // the date `offset` days from today
  plus(date: string, days: number): string; // a date moved by days
  nextWeekday(weekday: number, includeToday?: boolean): string; // 0 = Sunday .. 6 = Saturday
  local(date: string, hhmm: string): string; // a wall time, "2026-11-05T12:00:00"
  at(date: string, hhmm: string): number; // the instant of a wall time in the zone
  hhmm(ms: number): string; // the wall time of an instant, "19:30"
  dateOf(ms: number): string; // the date of an instant in the zone
}

interface World {
  tasks?: { title: string; due?: string; details?: string; person?: string; remindAt?: number; focus?: boolean; moves?: number }[]; // open tasks of the owner's list (Ted's own tasks store, in the temp data folder; `moves`: the due date was moved that many times in the days before, a history of edited rows)
  calendar?: SeedEvent[];
  mail?: SeedMail[];
  mailAccounts?: string[]; // more accounts in the mail client (account 2, 3...; `account` of a seed mail picks one), by email address
  mailDown?: boolean; // the mail connector is down: every call to it errors
  notion?: SeedDatabase[]; // Notion databases (the owner has the connector in every case; most cases have none)
  notionPages?: { id: string; title: string; content: string }[]; // standalone Notion pages of the owner (found by search, fetched by id)
  slowMs?: number; // the calendar's reads take this long (a slow service: the owner's next message can arrive while one runs)
  fetch?: Record<string, string>; // pages the built-in WebFetch can open, by their public-looking address (html); served by a local server for the run (fakeweb.ts)
  web?: Record<string, FakePage>; // the fake web (the browser the browse worker uses); the owner's card is a public test card, set up for the run
  notes?: Record<string, string>; // note files of the owner's notes folder (people-*.md, ...), on top of the setup notes every case gets
}

export interface Check {
  name: string;
  pass: boolean;
  why?: string;
}

// What the fakes and the run's own stores hold when the case is graded: after each owner message (`after`) and at the end.
export interface Outcome {
  time: Time;
  calendar: CalEvent[];
  notion: NotionPage[];
  mail: FakeMail;
  notes: Record<string, string>; // the owner's note files (file name to text), the seeded ones included
  tasks: Item[]; // every task, whatever its status
  web: { fetched: string[]; searches: string[]; submissions: { page: string; button: string; values: Record<string, string> }[]; payments: Payment[]; payClicks: string[]; ledger: { status: string; totalMinor: number; currency: string }[] }; // what reached the fake pay endpoint, and what the real payment ledger says
  calls: { tool: string; turn: number; args: Record<string, unknown>; ok: boolean }[];
  asks: { turn: number; tool: string; question: string; payment: boolean; answer: string }[]; // every question put to the owner (the model-written text she was shown) and what the scripted owner answered
  turns: { message: string; messages: string[]; sent: SentMail[]; drafts: { id: number; to: string[]; subject: string; body: string }[] }[]; // `messages`: what the chat got during the turn, the final reply last
}

export interface Case {
  id: string;
  zone?: string; // the owner's time zone for the case (default Europe/London): the conversation takes it from the process
  title: string;
  turns: string[]; // the owner's messages, one chat turn each, in the same conversation; none for a look
  look?: boolean; // the trigger is a background look (heartbeat/look.ts), not a message
  group?: { members: string[]; turns: { from: string; text: string; addressed?: boolean }[] }; // the trigger is a group chat the owner sponsors: the messages go through the production intake (vouch, gate, participation, group prompt). `members`: the other members by name; `from` is a member's name or "owner"; `addressed`: tagged or quoted (default no, so the participation gate decides); `turns` above is empty
  interject?: { on: string; text: string; afterMs?: number }; // the owner's chat only: a second message, sent through the production intake `afterMs` after the named tool (a full tool name) is first called, while the first turn is still running
  world: (t: Time) => World;
  answers?: string[]; // the scripted owner's answers to the questions that are not a card payment, in order ("yes" approves); anything else, and running out, declines
  payment?: string; // the answer to the card payment question: "YES" pays; default "no"
  maxQuestions: number; // how many times the owner may be asked; more is needless
  state: (o: Outcome) => Check[]; // deterministic checks on the final fake world
  never: (o: Outcome) => string[]; // what must not have happened (empty: nothing did)
  reply: string[]; // rubric lines for the reply grader (the chat messages, graded pass or fail each)
  perfect: (s: PerfectScript) => Promise<void>; // a scripted run with no model: the dry run that tests the grading (EVAL_FAKE=perfect)
}

// What a scripted perfect run may do: call the fakes the way the model would, change the task list the way the tasks tool does, and "say" one chat message.
export interface PerfectScript {
  time: Time;
  turn(n: number): void;
  tool(full: string, args: Record<string, unknown>): Promise<string>;
  tasks: {
    add(t: { title: string; due?: string; remindAtMs?: number }): void;
    find(titlePart: string): number; // the id of the open task whose title has this text
    done(id: number): void;
    drop(id: number): void;
    edit(id: number, patch: { title?: string; due?: string | null; details?: string | null; remindAtMs?: number | null; focus?: boolean }): void;
  };
  ask(tool: string, question: string, answer: string, payment?: boolean): void; // a question the scripted run put to the owner
  note(file: string, text: string): void; // a note file the run saved
  search(query: string): string; // a web search, answered by the case's fake web
  open(url: string): string; // a page opened on the case's fake web
  say(text: string): void;
}
