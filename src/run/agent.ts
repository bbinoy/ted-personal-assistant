import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, runAgent, type AgentReply, type RunOptions } from "./agentrun.ts";
import { pool, runWarmOrCold, warmUp } from "./agentwarm.ts";
import { notesIndex, runFor, turnContext, TRIGGERS, type RunInputs, type Trigger } from "./runoptions.ts";
import { markShown, spoke, toldKey, turnFacts, unseen, type TurnFacts } from "./turncontext.ts";
import { chatResume, sessionTaint } from "./chatsession.ts";
import { lookerOf } from "./scope.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { userInput, type Picture } from "./image.ts";
import type { Document } from "../conversation/document.ts";
import { tenantKey } from "../core/ownerkey.ts";
import { approveIn, type Approve } from "../approvals/permissions.ts";
import type { Payer } from "../tenants/payer.ts";
import type { SeenMail } from "../modules/seenmail/seenmail.ts";
import { gated } from "../core/rungate.ts";
import { settings } from "../core/settings.ts";
import type { RunProvenance } from "../approvals/autojudge.ts";

// The entry points of a run. ONE function does a run of any conversation, whatever started it (runTurn): the conversation's own session for the trigger, options from the one builder
// (runoptions.ts runFor), the context code hands every run (what is set up, the facts of heartbeat/facts.ts, a look's notes), each told only when it differs from what that session was last told,
// then the trigger's own message. The two public functions below only say which trigger and bring its callbacks.

// What a look tells the run it starts: the approval judge's provenance, as a value (autojudge.ts RunProvenance): `standing` with the look's fixed text.
export interface LookExtra {
  onToolSuccess?: RunOptions["onToolSuccess"];
  provenance?: RunProvenance;
  onDelegate?: (agent: string) => void; // told each accepted delegation to an expert
  seenMail?: SeenMail; // the look's tracker of the inbox mail already worked through (seenmail.ts)
  signal?: AbortSignal; // the look is called off (a chat message overtook it, look.ts)
  expertContext?: string; // the look's facts and chat lines, appended by code to every brief it hands an expert (delegation.ts)
  untrusted?: boolean; // the message itself carries a third party's words (a task made from a mail, look.ts): the judge is told from the first call
  style?: string; // a group: the style lines of its chat, as for a message (runoptions.ts RunInputs)
  facts: TurnFacts; // the facts of this look, taken by look.ts (it needs them before it writes its message, and settles them itself with what it knows of how the look ended)
}

// What a trigger says, made once it is known whether the session resumes (`since`: the newest line the session has been shown; groups' chat and every look).
export type TurnBuilder = (since?: string) => { prompt: string; seenAt?: string; pictures?: Picture[]; documents?: Document[] };

interface Wiring {
  approve: Approve;
  inputs: RunInputs;
  onFirstOutput?: () => void;
  facts?: TurnFacts; // given: the caller settles it
  extra?: (built: RunOptions) => Partial<RunOptions>; // a look's callbacks, given what the builder made
  io?: { query?: typeof query };
}

async function runTurn(conv: Conversation, trigger: Trigger, build: TurnBuilder, w: Wiring): Promise<AgentReply> {
  const t = TRIGGERS[trigger];
  const now = w.inputs.now ?? new Date();
  const r = chatResume(conv.convId, t.track);
  const { prompt, seenAt, pictures, documents } = build(r.resume ? r.seenAt : undefined);
  const built = runFor(conv, trigger, w.inputs);
  const o: RunOptions = { ...built, ...w.extra?.(built), seenAt, onFirstOutput: w.onFirstOutput };
  // What the session is told in front of the message: what is set up and the recent notices (turnContext), a look's notes, the claimed facts and the information facts (heartbeat/facts.ts),
  // each only when it differs from what the session was last told. A claimed fact is settled when the run ends: told if the reply said something, else left for the next run.
  const own = !w.facts; // a look settles its facts itself
  const facts = w.facts ?? turnFacts(conv, now);
  const k = toldKey(conv.convId, t.track);
  const told = [
    [k, turnContext(conv, trigger)],
    [`${k}:notes`, notesIndex(conv, trigger, now)],
    [`${k}:status`, facts?.status.join("\n\n")],
    [`${k}:facts`, facts?.blocks.join("\n\n")],
  ] as const;
  const shown = told.flatMap(([key, text]) => {
    const fresh = unseen(key, r.resume, text);
    return fresh ? [{ key, text: fresh }] : [];
  });
  if (facts?.untrusted && shown.some((s) => s.key.endsWith(":status"))) sessionTaint(conv.convId, r.resume, t.track).mark(); // (the session now holds a mail's words: the judge is told from here on)
  const input = userInput(shown.length ? `${shown.map((s) => s.text).join("\n\n")}\n\n${prompt}` : prompt, pictures, documents);
  let reply: AgentReply;
  try {
    reply = t.attended
      ? await runWarmOrCold(conv, o, r, input, (abortController) => (w.io?.query ?? query)({ prompt: input, options: { ...buildOptions(w.approve, o, r.resume, abortController.signal), abortController } })) // on the conversation's warm process when it still fits (agentwarm.ts)
      : await runAgent(input, w.approve, o, w.io);
  } catch (e) {
    if (own) facts?.done({ ended: false, said: false, abandoned: true });
    throw e;
  }
  for (const s of shown) markShown(s.key, chatResume(conv.convId, t.track).resume, s.text); // the run went through: the session has it now
  if (own) {
    const said = spoke(reply.text);
    facts?.done({ ended: said, said, abandoned: !said });
  }
  return reply;
}

// ---- a message: the owner's chat, a group's, a friend's ----

// The one path of a chat turn: the conversation's own resumed session, options (runoptions.ts) and approver (its key).
export function runConversation(conv: Conversation, inputs: RunInputs, build: TurnBuilder, onFirstOutput?: () => void, io: { query?: typeof query } = {}): Promise<AgentReply> {
  return gated("chat", () => runTurn(conv, "message", build, { approve: approveIn(conv.key), inputs, onFirstOutput, io })); // a place in the run gate (rungate.ts), which a chat turn never waits for
}

// ---- a look: a background check of the owner's conversation, a group's or a friend's ----

// One look of a conversation: the conversation's own look session, resumed. `approve` is that conversation's own approver (main.ts); the payer is the conversation's (payer.ts): the login, or the instance key on her ledger.
export function runLook(conv: Conversation, payer: Payer, build: TurnBuilder, approve: Approve, extra: LookExtra, o: { now?: Date; io?: { query?: typeof query } } = {}): Promise<AgentReply> {
  return runTurn(conv, "look", build, { approve, inputs: lookInputs(payer, extra, o.now ?? new Date()), facts: extra.facts, extra: (built) => lookExtras(conv, built, extra), io: o.io });
}

// What a look adds to the builder's options: the callbacks it was given (and, where it has experts, what they are told). Also how tests build a look's options.
const lookInputs = (payer: Payer, extra: Pick<LookExtra, "style">, now: Date): RunInputs => ({ ...(payer.kind === "instance" ? { apiKey: payer.apiKey } : {}), ...(extra.style ? { style: extra.style } : {}), now });
const lookExtras = (conv: Conversation, built: RunOptions, extra: Partial<LookExtra>): Partial<RunOptions> => {
  const { facts: _facts, onDelegate, expertContext, style: _style, provenance, seenMail, ...callbacks } = extra;
  return { ...callbacks, ...(provenance ? { provenance: () => provenance } : {}), ...(seenMail && lookerOf(conv).mail ? { seenMail } : {}), ...(built.experts ? { experts: { ...built.experts, onDelegate: (d) => onDelegate?.(d.agent), context: () => expertContext } } : {}) };
};
export function lookOptions(conv: Conversation, payer: Payer, extra: Partial<LookExtra> = {}, now = new Date()): RunOptions {
  const built = runFor(conv, "look", lookInputs(payer, extra, now));
  return { ...built, ...lookExtras(conv, built, extra) };
}

// Keep a process warm for the conversation's next message. `refresh`: only renew one that is in use (a timer; it does not keep an idle one alive).
// `keep`: not if it holds a fresh one (a message arrived for an active group); otherwise it is rebuilt (the session moved on). WARM=off: nothing.
export function prepare(conv: Conversation, inputs: RunInputs, opts: { refresh?: boolean; keep?: boolean; start?: typeof startup } = {}): void {
  if (opts.refresh && !pool.wants(conv)) return;
  if (!settings.warm) return;
  if (opts.keep && pool.has(conv)) return void pool.touch(conv);
  warmUp(conv, runFor(conv, "message", inputs), chatResume(conv.convId), opts.start, opts.refresh);
}

// A tenant who was suspended or removed: her process is closed.
export const dropTenantWarm = (id: string): void => pool.drop(tenantKey(id));
