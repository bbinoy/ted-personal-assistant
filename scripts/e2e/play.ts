// Plays one end-to-end case once, in this process: the owner's conversation built by the production code (agent.ts runConversation / runLook -> runoptions.ts runFor -> agentrun.ts buildOptions) with every capability, the real
// approval chain (question writer, judge, the answer path, the hand-off and its continuation turns) and the real tasks, notes and send tools, in a temporary data folder; only the external services are fakes, and a guard
// keeps the run away from every real account (guard.ts). A look goes through createHeartbeatLook, the code a heartbeat look uses.
// Import it only AFTER HARNESS_DATA_DIR and TZ are set (scripts/e2e-case.ts does): the application reads them when it is loaded.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settings } from "../../src/core/settings.ts";
import { OWNER_KEY } from "../../src/core/ownerkey.ts";
import { owner } from "../../src/conversation/conversationmodel.ts";
import { runConversation, runLook } from "../../src/run/agent.ts";
import { chatTurn } from "../../src/run/chattail.ts";
import { ledgerEntries, recordMessage } from "../../src/core/messages.ts";
import { lookState } from "../../src/conversation/ledger.ts";
import { scopeOf } from "../../src/approvals/turnscope.ts";
import { approveIn, setApprovers } from "../../src/approvals/permissions.ts";
import { createApprovers } from "../../src/approvals/approvers.ts";
import * as approvals from "../../src/approvals/approvals.ts";
import { createPipeline } from "../../src/conversation/conversation.ts";
import { createOutbound } from "../../src/conversation/outbound.ts";
import { sponsorInGroup } from "../../src/conversation/group.ts";
import { groupDir, recordGroup } from "../../src/conversation/groupstore.ts";
import { group as groupOf } from "../../src/conversation/conversationmodel.ts";
import { FakeMessenger } from "@ted-assistant/messenger/testing";
import { setContinuation } from "../../src/approvals/handoff.ts";
import { withSend, type SendSink } from "../../src/modules/send/send.ts";
import { setDraftReader } from "../../src/modules/mailbird/module.ts";
import { viewDraft } from "../../src/modules/mailbird/proposals.ts";
import { Mailbird } from "../../src/modules/mailbird/mailbird.ts";
import { setupItems } from "../../src/modules/index.ts";
import { addItem, completeItem, dropItem, editItem, listItems, type Scope } from "../../src/tasks/store.ts";
import { fireReminders } from "../../src/heartbeat/remindtick.ts";
import { createHeartbeatLook } from "../../src/heartbeat/look.ts";
import { LOGIN } from "../../src/tenants/payer.ts";
import { spentToday } from "../../src/core/budget.ts";
import { readAudit } from "../../src/core/audit.ts";
import { FakeCalendar } from "./fakecalendar.ts";
import { FakeBrowser, type FakeCard } from "./fakebrowser.ts";
import { RUNTIME } from "../../src/modules/runtime.ts";
import { browse, browseToolText } from "../../src/modules/browse/browse.ts";
import { Ledger } from "../../src/modules/browse/payments.ts";
import { type CardAccess, type CardRecord } from "../../src/modules/browse/card.ts";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { FakeMail } from "./fakemail.ts";
import { FakeNotion } from "./fakenotion.ts";
import { startFakeWeb } from "./fakeweb.ts";
import { Recorder } from "./fakeserver.ts";
import { assertHermetic, blockRealMailbird, guardedQuery, newGuardState, type GuardState } from "./guard.ts";
import { makeTime } from "./time.ts";
import { OWNER_EMAIL } from "./checks.ts";
import type { Case, Check, Outcome, PerfectScript } from "./case.ts";

export interface PlayResult {
  checks: Check[];
  never: string[];
  asks: Outcome["asks"];
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
  "setup-calendars.md": "Calendars to check: the primary calendar only. Time zone: {{zone}}. Travel bookings go on the primary calendar.",
  "setup-meetings.md": "Meeting notes are not kept in Notion in this setup.",
  "voice-writing.md": "Short, warm, plain. No exclamation marks. Sign off with just the first name.",
};

function seedNotes(zone: string, extra: Record<string, string> = {}): void {
  const dir = owner().notesDir;
  mkdirSync(dir, { recursive: true });
  for (const i of setupItems()) writeFileSync(join(dir, i.file), (SETUP_TEXT[i.file] ?? `Set up for the evaluation: ${i.label}.`).replace("{{zone}}", zone));
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(dir, file), text);
}

// The owner's card in the evaluation: the public test number, as in the guard's own tests. The fake pay endpoint accepts exactly this, so a payment is "real" only when it was typed completely.
const TEST_CARD: CardRecord = { pan: "4242424242424242", expMonth: 12, expYear: 2099, cvc: "0731", label: "Test card", last4: "4242", currency: "GBP", holder: "Test Holder" };
const TEST_CARD_FOR_BROWSER: FakeCard = { pan: TEST_CARD.pan, expiry: "12/99", cvc: TEST_CARD.cvc };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const GROUP_ID = "ZXZhbC1ncm91cC1leGFtcGxlLTAx"; // a made-up group id, and made-up numbers for its members (the owner's is number 0)
const memberNumber = (i: number) => `+1555555${String(100 + i).padStart(4, "0")}`;

export async function play(c: Case, o: { now: Date; zone: string; perfect?: boolean }): Promise<PlayResult> {
  assertHermetic(process.env, process.env.HARNESS_DATA_DIR); // fail closed: before anything starts
  (settings as unknown as { warm: boolean }).warm = false;
  const started = Date.now();
  const nowMs = o.now.getTime();
  const time = makeTime(o.now, o.zone);
  const ckey = c.group ? GROUP_ID : OWNER_KEY; // the conversation whose tasks and approvals the case is about
  const labels = c.group ? c.group.turns.map((t) => `${t.from}: ${t.text}`) : c.turns; // what each turn is called in the transcript
  const world = c.world(time);
  seedNotes(o.zone, world.notes);
  const web = world.fetch ? await startFakeWeb(world.fetch) : undefined;
  const scope: Scope = { key: OWNER_KEY, zone: o.zone, by: "owner", origin: "owner", source: "chat", now: nowMs };
  for (const t of world.tasks ?? []) addItem(scope, t);

  const rec = new Recorder();
  const cal = new FakeCalendar(rec, o.zone, OWNER_EMAIL, world.calendar, () => nowMs);
  const mail = new FakeMail(rec, { email: OWNER_EMAIL, displayName: settings.owner }, world.mail, world.mailDown);
  const notion = new FakeNotion(rec, world.notion);
  const guard = newGuardState();
  blockRealMailbird(Mailbird, guard);
  setDraftReader(async (id) => viewDraft(mail.readDraft(id))); // the approval of a send reads the draft back from the fake, not from Mailbird

  // The fake web (e8, e2): the browse entry tool and the browse worker's browser are Ted's own code, so they stay real; what is swapped is what reaches out. The worker's browser server is the fake one, the card
  // is the public test card behind a card access that never touches OpenBao, and the entry tool runs the real browse() with the egress proxy, the saved details and the real browser left out.
  const fb = world.web ? new FakeBrowser(rec, world.web, TEST_CARD_FOR_BROWSER) : undefined;
  const ledger = new Ledger();
  if (fb) {
    const access: CardAccess = { info: { last4: TEST_CARD.last4, label: TEST_CARD.label, currency: TEST_CARD.currency }, load: async () => TEST_CARD, off: () => undefined, ledger, caps: { purchaseMinor: 50_000, dayMinor: 100_000 } };
    RUNTIME.browser!.server = () => fb.service.config;
    RUNTIME.browse!.server = (ctx) =>
      createSdkMcpServer({
        name: "browse",
        version: "1.0.0",
        tools: [
          tool("browse", browseToolText(ctx), { task: z.string().min(5).max(2000) }, async ({ task }) => {
            const text = await browse({ mode: ctx.mode, groupId: ctx.groupId, key: ctx.key, attended: ctx.kind.attended, tenant: !!(ctx.tenant ?? ctx.sponsor), run: ctx.browseRun }, task, { status: { ok: true, cli: "fake", exe: "fake" }, proxy: null, resolver: async () => ["93.184.216.34"], profile: null, card: access, frames: async (url) => [{ url }], probe: async () => "there is no real browser in the evaluation" });
            rec.add("mcp__browse__browse", { task }, true, text);
            return { content: [{ type: "text" as const, text }] };
          }),
        ],
      });
  }

  // The scripted owner's phone. The approval chain is the production one (a model writes each question, the judge checks it, a yes goes through the real answer path and, for a handed-off question, a
  // continuation turn runs the approved call). Questions land here; each is answered from the case's script, in order, and anything else is "no".
  let turn = 0;
  const answers = [...(c.answers ?? [])];
  const answered: { turn: number; text: string }[] = [];
  const inflight = new Set<Promise<void>>();
  const continuations: { prompt: string; provenance?: unknown }[] = [];
  let sentTs = 1_000;
  setApprovers(createApprovers({
    reply: async () => {
      const at = turn;
      const p = (async () => {
        await sleep(300); // (the question is open once its send has returned)
        const asked = readAudit((e) => e.decision === "approval-asked").at(-1); // (the card payment question is the one whose details start with the card sign: it has its own answer)
        const text = String(asked?.meta?.details ?? "").startsWith("💳") ? (c.payment ?? "no") : (answers.shift() ?? "no");
        answered.push({ turn: at, text });
        await approvals.answer(text, () => {}, undefined, {}, { scope: ckey, by: settings.owner });
      })().catch((e) => void console.error("eval: the scripted owner could not answer:", (e as Error).message));
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
      return ++sentTs;
    },
  }));
  setContinuation((_scope, prompt, provenance) => void continuations.push({ prompt, provenance }));

  const fakes = { [cal.service.server]: cal.service.config, [mail.service.server]: mail.service.config, [notion.service.server]: notion.service.config };
  const fakeTools = new Set([...cal.service.tools, ...mail.service.tools, ...notion.service.tools, ...(fb ? ["mcp__browse__browse"] : [])]);
  const conv = owner();
  const turns: PlayResult["turns"] = [];
  const snapshots: Outcome["turns"] = [];
  let error: string | undefined;
  let said: string[] = [];
  const scriptedAsks: Outcome["asks"] = [];

  const snapshot = (message: string) => {
    turns.push({ message, messages: said });
    snapshots.push({ message, messages: said, sent: mail.sent.map((s) => ({ ...s })), drafts: mail.drafts().map((m) => ({ id: m.id, to: m.to.map((p) => p.email), subject: m.subject, body: m.body })) });
    said = [];
  };

  if (o.perfect) {
    const script: PerfectScript = {
      time,
      turn: (n) => {
        if (n > 0) snapshot(labels[n - 1]!);
        turn = rec.turn = n;
      },
      tool: async (full, args) => {
        const svc = [cal.service, mail.service, notion.service, ...(fb ? [fb.service] : [])].find((s) => s.tools.includes(full));
        if (!svc) throw new Error(`no fake has ${full}`);
        const r = await svc.call(full.slice(full.lastIndexOf("__") + 2), args);
        if (r.isError) throw new Error(r.text);
        return r.text;
      },
      tasks: {
        add: (t) => void addItem(scope, { title: t.title, due: t.due, remindAt: t.remindAtMs }),
        find: (part) => listItems(ckey, { status: ["open", "snoozed"] }, nowMs, o.zone).find((x) => x.title.toLowerCase().includes(part.toLowerCase()))!.id,
        done: (id) => void completeItem(scope, id),
        drop: (id) => void dropItem(scope, id),
        edit: (id, patch) => void editItem(scope, id, patch),
      },
      ask: (tool, question, answer, payment = false) => void scriptedAsks.push({ turn, tool, question, payment, answer }),
      note: (file, text) => void writeFileSync(join(owner().notesDir, file), text),
      search: (query) => web!.search(query),
      open: (url) => web!.open(url)!,
      say: (text) => void said.push(text),
    };
    await c.perfect(script);
    // (the scripted run does not go through the browse guard, which writes the payment ledger: a completed fake payment gets its ledger row here, as the guard would have written it)
    for (const p of fb?.payments.filter((x) => x.cardOk) ?? []) ledger.add({ id: "0000perf", merchant: "example.com", totalMinor: Math.round(Number(/\d+\.\d\d/.exec(p.amountText)?.[0]) * 100), currency: "GBP", last4: TEST_CARD.last4, cartHash: "perfect", status: "clicked" });
    snapshot(c.look ? "" : labels[labels.length - 1]!);
  } else {
    const realQuery = guardedQuery(query, fakes, fakeTools, guard, web);
    // One turn of the owner's chat as main.ts runs it (runChat): the judge is told what led to it, the run is built by runConversation, a reply is what the pipeline would have delivered.
    const chat = async (message: string, prompt: string, continuation?: { provenance?: unknown }) => {
      const sink: SendSink = async (content) => (content.kind === "text" && said.push(content.text), "Sent.");
      if (continuation) scopeOf(conv.key).carry((continuation.provenance as never) ?? null);
      else scopeOf(conv.key).say(message);
      if (!continuation) recordMessage("owner", Date.now(), message, o.now);
      try {
        const reply = await withSend(conv.key, sink, () => runConversation(conv, { now: o.now }, chatTurn(conv, { prompt, untrusted: !!continuation }), undefined, { query: realQuery }));
        const text = reply.text.trim();
        if (text && !/^\[\[silent\]\]$/.test(text)) {
          said.push(text);
          scopeOf(conv.key).assistantSaid(text);
          recordMessage("chat", Date.now(), text, o.now);
        }
      } finally {
        scopeOf(conv.key).end();
      }
    };
    try {
      if (c.group) {
        // A group chat as main.ts runs it: the production pipeline (the sponsor's vouch, the participation gate, the group prompt, the group's run and its delivery) over a fake messenger. Only the run's `query` is the guarded one.
        const messenger = new FakeMessenger();
        const record = (target: string | undefined, kind: Parameters<typeof recordGroup>[1], ts: number, text: string, extra?: Parameters<typeof recordGroup>[4]) => void (target && (groupDir(target, "Example group"), recordGroup(target, kind, ts, text, extra)));
        const people = c.group.members.map((name, i) => ({ name, number: memberNumber(i + 1) }));
        const numberOf = (from: string) => (from === "owner" ? memberNumber(0) : people.find((p) => p.name === from)!.number);
        const pipeline = createPipeline({
          messenger,
          out: createOutbound(messenger, (k, t, text, g) => record(g, k, t, text), { pauseMs: 0 }),
          record,
          run: async () => { throw new Error("not a private chat"); },
          picture: async () => { throw new Error("no pictures in the evaluation"); },
          document: async () => { throw new Error("no files in the evaluation"); },
          transcript: async () => { throw new Error("no voice in the evaluation"); },
          speech: { ready: () => false, synth: async () => { throw new Error("no speech"); }, foreign: async () => undefined },
          approvals,
          vouch: (id) => sponsorInGroup(id, async () => [{ id, name: "Example group", members: [{ number: memberNumber(0) }, ...people] }], (who) => (who.number === memberNumber(0) ? { id: "owner", since: "" } : undefined)),
          isOwner: (w) => w.from === memberNumber(0),
          group: { run: async (build, { conv, firstOutput }) => (await runConversation(conv, { now: o.now }, build, firstOutput, { query: realQuery })).text.trim() },
          wait: async () => undefined, // (the settling pause and the gate's delay are not waited out)
        });
        for (const [i, t] of c.group.turns.entries()) {
          turn = rec.turn = i;
          const before = messenger.sent.length;
          await pipeline.handleIncoming(groupOf(GROUP_ID), { type: "message", m: { from: numberOf(t.from), fromName: t.from === "owner" ? settings.owner : t.from, text: t.text, timestamp: Date.now(), direct: false, group: { id: GROUP_ID }, addressedToMe: !!t.addressed } });
          for (;;) {
            await Promise.all([...inflight]);
            const next = continuations.shift();
            if (!next) break;
            await pipeline.continuation(groupOf(GROUP_ID), next.prompt, next.provenance as never);
          }
          said.push(...messenger.sent.slice(before).map((x) => x.message.text));
          snapshot(labels[i]!);
        }
      } else if (c.look) {
        // A look as the heartbeat starts it: createHeartbeatLook with a pipeline that records what would have been said (a post, or the send tool) instead of delivering it.
        const sink: SendSink = async (content) => (content.kind === "text" && said.push(content.text), "Sent.");
        const pipeline = {
          enqueue: <X>(_c: unknown, job: () => Promise<X>) => job(),
          busy: () => false,
          record: () => {},
          sendWhile: (_c: unknown, run: () => Promise<unknown>) => withSend(conv.key, sink, run as never),
          runTurn: async (_c: unknown, t: { run: (x: object) => Promise<{ text: string }> }) => ((said.push((await t.run({})).text), { spoke: true })),
        };
        const hb = createHeartbeatLook({ pipeline: pipeline as never, run: (cv, payer, build, extra) => runLook(cv, payer, build, approveIn(cv.key, { background: true }), extra, { now: o.now, io: { query: realQuery } }), may: () => LOGIN, why: () => "refused", notesChangedAt: () => 0 });
        recordMessage("owner", nowMs - 3_600_000, "morning", new Date(nowMs - 3_600_000)); // (a conversation with some history, as a look finds it)
        await fireReminders(pipeline as never, conv, o.now); // (the wake tick claims a reminder that came due, which is what wakes the look with its reason)
        const outcome = await hb.look(conv, lookState(ledgerEntries(conv.logFile)), o.now);
        if (outcome !== "silent" && outcome !== "posted") error = `the look ended ${outcome}`;
        snapshot("(a look)");
      } else {
        for (const [i, message] of c.turns.entries()) {
          turn = rec.turn = i;
          await chat(message, message);
          // A question the owner answered with a yes ends in a continuation turn, run through the same path (handoff.ts), until nothing is left to run or to answer.
          for (;;) {
            await Promise.all([...inflight]);
            const next = continuations.shift();
            if (!next) break;
            await chat("", next.prompt, next);
          }
          snapshot(message);
        }
      }
    } catch (e) {
      error = `${c.look ? "look" : `turn ${turn + 1}`}: ${(e as Error).message}`;
      snapshot(c.look ? "(a look)" : labels[turn] ?? "");
    }
  }

  const questions = readAudit((e) => e.decision === "approval-asked");
  const asks = scriptedAsks.length ? scriptedAsks : questions.map((q, i) => ({ turn: answered[i]?.turn ?? 0, tool: q.tool, question: String(q.meta?.question ?? ""), payment: String(q.meta?.details ?? "").startsWith("💳"), answer: answered[i]?.text ?? "(unanswered)" }));
  const outcome: Outcome = { time, calendar: cal.final(), notion: notion.final(), mail, tasks: listItems(ckey, { status: ["open", "done", "dropped", "snoozed"] }, nowMs, o.zone), web: { fetched: web?.hits ?? [], searches: web?.searches ?? [], submissions: fb?.submissions ?? [], payments: fb?.payments ?? [], payClicks: fb?.payClicks ?? [], ledger: ledger.allRows().map((r) => ({ status: r.status, totalMinor: r.totalMinor, currency: r.currency })) }, calls: rec.calls.map((x) => ({ tool: x.tool, turn: x.turn, args: x.args, ok: x.ok })), asks, turns: snapshots, notes: Object.fromEntries(readdirSync(owner().notesDir).map((f) => [f, readFileSync(join(owner().notesDir, f), "utf8")])) };
  if (!error && guard.inits === 0 && !o.perfect && !c.group) guard.violations.push("no start-up message was checked"); // (a group the gate leaves unanswered starts no run at all)
  await web?.close();
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
