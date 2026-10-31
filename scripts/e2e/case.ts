// What an end-to-end case is (scripts/e2e-eval.ts): a trigger, a world the fakes start from, the scripted owner, and what is expected. All names, places and addresses are fictional (example.com / example.org).
import type { CalEvent, SeedEvent } from "./fakecalendar.ts";
import type { FakeMail, SeedMail, SentMail } from "./fakemail.ts";
import type { Item } from "../../src/tasks/store.ts";

// The frozen clock of a case: every date in the world is relative to it, and the run is told it as its clock (agent.ts runTurn, RunInputs.now).
export interface Time {
  now: Date;
  zone: string;
  today: string; // YYYY-MM-DD in the zone
  day(offset: number): string; // the date `offset` days from today
  nextWeekday(weekday: number, includeToday?: boolean): string; // 0 = Sunday .. 6 = Saturday
  local(date: string, hhmm: string): string; // a wall time, "2026-11-05T12:00:00"
  at(date: string, hhmm: string): number; // the instant of a wall time in the zone
  hhmm(ms: number): string; // the wall time of an instant, "19:30"
  dateOf(ms: number): string; // the date of an instant in the zone
}

interface World {
  calendar?: SeedEvent[];
  mail?: SeedMail[];
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
  mail: FakeMail;
  tasks: Item[]; // every task, whatever its status
  calls: { tool: string; turn: number; args: Record<string, unknown>; ok: boolean }[];
  turns: { message: string; messages: string[]; sent: SentMail[]; drafts: { id: number; to: string[]; subject: string; body: string }[] }[]; // `messages`: what the chat got during the turn, the final reply last
}

export interface Case {
  id: string;
  title: string;
  turns: string[]; // the owner's messages, one chat turn each, in the same conversation
  world: (t: Time) => World;
  answers?: string[]; // the scripted owner's answers to questions, in order ("YES" approves); anything else, and running out, declines
  maxQuestions: number; // how many times the owner may be asked; more is needless
  state: (o: Outcome) => Check[]; // deterministic checks on the final fake world
  never: (o: Outcome) => string[]; // what must not have happened (empty: nothing did)
  reply: string[]; // rubric lines for the reply grader (the chat messages, graded pass or fail each)
  perfect: (s: PerfectScript) => Promise<void>; // a scripted run with no model: the dry run that tests the grading (EVAL_FAKE=perfect)
}

// What a scripted perfect run may do: call the fakes the way the model would, add a task the way the tasks tool does, and "say" one chat message.
export interface PerfectScript {
  time: Time;
  turn(n: number): void;
  tool(full: string, args: Record<string, unknown>): Promise<string>;
  addTask(t: { title: string; due?: string; remindAtMs?: number }): void;
  say(text: string): void;
}
