// Plays one end-to-end case once, in this process: the owner's conversation built by the production code (agent.ts runConversation -> runoptions.ts runFor -> agentrun.ts buildOptions) with every capability, the real
// judge and the real tasks, notes and send tools, in a temporary data folder; only the external services are fakes, and a guard keeps the run away from every real account (guard.ts).
// Import it only AFTER HARNESS_DATA_DIR and TZ are set (scripts/e2e-case.ts does): the application reads them when it is loaded.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settings } from "../../src/core/settings.ts";
import { OWNER_KEY } from "../../src/core/ownerkey.ts";
import { owner } from "../../src/conversation/conversationmodel.ts";
import { runConversation } from "../../src/run/agent.ts";
import { chatTurn } from "../../src/run/chattail.ts";
import { recordMessage } from "../../src/core/messages.ts";
import { scopeOf } from "../../src/approvals/turnscope.ts";
import { setApprovers, type Approve } from "../../src/approvals/permissions.ts";
import { NEVER_ASKS } from "../../src/approvals/approvers.ts";
import { withSend, type SendSink } from "../../src/modules/send/send.ts";
import { setDraftReader } from "../../src/modules/mailbird/module.ts";
import { viewDraft } from "../../src/modules/mailbird/proposals.ts";
import { Mailbird } from "../../src/modules/mailbird/mailbird.ts";
import { setupItems } from "../../src/modules/index.ts";
import { addItem, listItems, type Item } from "../../src/tasks/store.ts";
import { spentToday } from "../../src/core/budget.ts";
import { readAudit } from "../../src/core/audit.ts";
import { FakeCalendar } from "./fakecalendar.ts";
import { FakeMail } from "./fakemail.ts";
import { Recorder } from "./fakeserver.ts";
import { assertHermetic, blockRealMailbird, guardedQuery, newGuardState, type GuardState } from "./guard.ts";
import { makeTime } from "./time.ts";
import { OWNER_EMAIL } from "./cases.ts";
import type { Case, Check, Outcome, PerfectScript } from "./case.ts";

interface Ask {
  turn: number;
  tool: string;
  description: string;
  input: Record<string, unknown>;
  typedYes: boolean;
  answer: "approved" | "declined";
}

export interface PlayResult {
  checks: Check[];
  never: string[];
  asks: Ask[];
  needlessAsks: number;
  guard: GuardState;
  turns: { message: string; messages: string[] }[];
  calls: Outcome["calls"];
  audit: { tool: string; decision: string; meta?: Record<string, unknown> }[]; // the run's audit rows (the judge's verdicts and reasons, the questions): the first place to look when a case fails
  costUsd: number;
  latencyS: number;
  error?: string;
}

// The setup notes the skills look for (modules' `setup`), so that no run starts by setting up; the content is fictional.
const SETUP_TEXT: Record<string, string> = {
  "setup-calendars.md": "Calendars to check: the primary calendar only. Time zone: Europe/London. Travel bookings go on the primary calendar.",
  "setup-meetings.md": "Meeting notes are not kept in Notion in this setup.",
  "voice-writing.md": "Short, warm, plain. No exclamation marks. Sign off with just the first name.",
};

function seedNotes(extra: Record<string, string> = {}): void {
  const dir = owner().notesDir;
  mkdirSync(dir, { recursive: true });
  for (const i of setupItems()) writeFileSync(join(dir, i.file), SETUP_TEXT[i.file] ?? `Set up for the evaluation: ${i.label}.`);
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(dir, file), text);
}

const allTasks = (zone: string, now: number): Item[] => listItems(OWNER_KEY, { status: ["open", "done", "dropped", "snoozed"] }, now, zone);

export async function play(c: Case, o: { now: Date; zone: string; perfect?: boolean }): Promise<PlayResult> {
  assertHermetic(process.env, process.env.HARNESS_DATA_DIR); // fail closed: before anything starts
  (settings as unknown as { warm: boolean }).warm = false;
  const started = Date.now();
  const time = makeTime(o.now, o.zone);
  const world = c.world(time);
  seedNotes(world.notes);

  const rec = new Recorder();
  const cal = new FakeCalendar(rec, o.zone, OWNER_EMAIL, world.calendar, () => o.now.getTime());
  const mail = new FakeMail(rec, { email: OWNER_EMAIL, displayName: settings.owner }, world.mail);
  const guard = newGuardState();
  blockRealMailbird(Mailbird, guard);
  setDraftReader(async (id) => viewDraft(mail.readDraft(id))); // the approval of a send reads the draft back from the fake, not from Mailbird

  // The scripted owner: the phone. Every question is recorded; the answers come from the case, in order, and anything else declines.
  const asks: Ask[] = [];
  let turn = 0;
  const answers = [...(c.answers ?? [])];
  const phone: Approve = async (description, call, _signal, opts) => {
    const next = answers.shift();
    const yes = next !== undefined && (opts?.typedYes ? next === "YES" : /^(y|yes)$/i.test(next));
    asks.push({ turn, tool: call.tool, description, input: call.input, typedYes: !!opts?.typedYes, answer: yes ? "approved" : "declined" });
    return yes ? { approved: true } : { approved: false, feedback: next };
  };
  setApprovers((_key, opts) => (opts?.background ? NEVER_ASKS : phone));

  const fakes = { [cal.service.server]: cal.service.config, [mail.service.server]: mail.service.config };
  const fakeTools = new Set([...cal.service.tools, ...mail.service.tools]);
  const conv = owner();
  const turns: PlayResult["turns"] = [];
  const snapshots: Outcome["turns"] = [];
  let error: string | undefined;

  const snapshot = (message: string, messages: string[]) => {
    turns.push({ message, messages });
    snapshots.push({
      message,
      messages,
      sent: mail.sent.map((s) => ({ ...s })),
      drafts: mail.drafts().map((m) => ({ id: m.id, to: m.to.map((p) => p.email), subject: m.subject, body: m.body })),
    });
  };

  if (o.perfect) {
    // No model: a scripted run that does what a good one would, through the same fakes, tasks store and recorder, to test the grading.
    let said: string[] = [];
    const script: PerfectScript = {
      time,
      turn: (n) => {
        if (n > 0) snapshot(c.turns[n - 1]!, said), (said = []);
        turn = rec.turn = n;
      },
      tool: async (full, args) => {
        const svc = [cal.service, mail.service].find((s) => s.tools.includes(full));
        if (!svc) throw new Error(`no fake has ${full}`);
        const r = await svc.call(full.slice(full.lastIndexOf("__") + 2), args);
        if (r.isError) throw new Error(r.text);
        return r.text;
      },
      addTask: (t) => void addItem({ key: OWNER_KEY, zone: o.zone, by: "owner", origin: "owner", source: "chat", now: o.now.getTime() }, { title: t.title, due: t.due, remindAt: t.remindAtMs }),
      say: (text) => void said.push(text),
    };
    await c.perfect(script);
    snapshot(c.turns[c.turns.length - 1]!, said);
  } else {
    const realQuery = guardedQuery(query, fakes, fakeTools, guard);
    for (const [i, message] of c.turns.entries()) {
      turn = rec.turn = i;
      const messages: string[] = [];
      const sink: SendSink = async (content) => (content.kind === "text" && messages.push(content.text), "Sent.");
      try {
        scopeOf(conv.key).say(message);
        recordMessage("owner", Date.now(), message, o.now);
        const reply = await withSend(conv.key, sink, () => runConversation(conv, { now: o.now }, chatTurn(conv, { prompt: message }), undefined, { query: realQuery }));
        const text = reply.text.trim();
        if (text && !/^\[\[silent\]\]$/.test(text)) {
          messages.push(text);
          scopeOf(conv.key).assistantSaid(text);
          recordMessage("chat", Date.now(), text, o.now);
        }
      } catch (e) {
        error = `turn ${i + 1}: ${(e as Error).message}`;
        snapshot(message, messages);
        break;
      } finally {
        scopeOf(conv.key).end();
      }
      snapshot(message, messages);
    }
  }

  const outcome: Outcome = { time, calendar: cal.final(), mail, tasks: allTasks(o.zone, o.now.getTime()), calls: rec.calls.map((x) => ({ tool: x.tool, turn: x.turn, args: x.args, ok: x.ok })), turns: snapshots };
  if (!error && guard.inits === 0 && !o.perfect) guard.violations.push("no start-up message was checked");
  return {
    checks: c.state(outcome),
    never: c.never(outcome),
    asks,
    needlessAsks: Math.max(0, asks.length - c.maxQuestions),
    guard,
    turns,
    calls: outcome.calls,
    audit: readAudit(() => true).map((e) => ({ tool: e.tool, decision: e.decision, ...(e.meta ? { meta: e.meta } : {}) })),
    costUsd: o.perfect ? 0 : spentToday(),
    latencyS: (Date.now() - started) / 1000,
    ...(error ? { error } : {}),
  };
}
