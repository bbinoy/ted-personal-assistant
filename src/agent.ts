import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, runAgent, type AgentReply, type RunOptions } from "./agentrun.ts";
import { pool, runWarmOrCold, warmUp } from "./agentwarm.ts";
import { runOptionsFor, turnContext, type RunInputs } from "./runoptions.ts";
import { markShown, unseen } from "./turncontext.ts";
import { chatResume } from "./chatsession.ts";
import { disconnected, readConnectors } from "./connectors.ts";
import type { Conversation } from "./conversationmodel.ts";
import { userInput, type Picture } from "./image.ts";
import type { Document } from "./document.ts";
import { tenantKey } from "./ownerkey.ts";
import { memoryFor, missingSetup, readNotes } from "./notes.ts";
import { approveIn, type Approve } from "./approvals/permissions.ts";
import { expertSystem, handlerSystem, heartbeatSystem } from "./persona.ts";
import { expertSetup } from "./heartbeat/delegation.ts";
import { handlerToolsOf } from "./mailhandler.ts";
import type { Payer } from "./payer.ts";
import { categoriesFor } from "./preset.ts";
import { tenantById, tenantContext } from "./tenants/tenants.ts";
import { PROFILES } from "./profiles.ts";
import { lookerOf, unattendedTools, type Looker } from "./heartbeat/scope.ts";
import { settings } from "./settings.ts";
import type { RunProvenance } from "./approvals/autojudge.ts";

const down = () => disconnected(readConnectors());

// What a job tells the run it starts: the approval judge's provenance, as a value (autojudge.ts RunProvenance): `standing` with the job's fixed text (the heartbeat run's look).
export interface ProfileExtra {
  onToolSuccess?: RunOptions["onToolSuccess"];
  provenance?: RunProvenance;
  onDelegate?: (agent: string) => void; // the heartbeat run: told each accepted delegation to an expert
}
const fixed = (p: RunProvenance | undefined): RunOptions["provenance"] => p && (() => p);

// The texts of a conversation's heartbeat run and of its expert, for the owner or for a friend or a group (persona.ts heartbeatSystem, expertSystem): the persona, the notes of the
// categories that conversation has (in its own zone: the day an `expires:` is compared with) and, for the owner, what is connected and set up. One function, so the run and its
// expert are told the same notes.
function heartbeatTexts(conv: Conversation, looker: Looker, now: Date): { run: string; expert: string } {
  if (looker.own) {
    const off = down(); // (read once)
    const o = { missing: missingSetup(readNotes(), off), down: off };
    const notes = memoryFor(PROFILES.heartbeat.notes, now, conv.notesDir, looker.zone);
    return { run: heartbeatSystem(notes, o), expert: expertSystem(notes, o) };
  }
  const ctx = conv.tenantId ? tenantContext(tenantById(conv.tenantId)!) : undefined;
  const looked = { name: looker.who, group: looker.group, language: ctx?.language, persona: ctx?.persona };
  const notes = memoryFor(categoriesFor(conv.kind), now, conv.notesDir, looker.zone);
  return { run: heartbeatSystem(notes, { looked }), expert: expertSystem(notes, { looked }) };
}

// The options of a conversation's heartbeat run (heartbeat/look.ts), ONE for the owner, every group and every friend: a fresh session, the conversation's own persona and notes
// (as data: the run reads untrusted mail and has no note tools), its own tools and skills from its capability set, the heartbeat profile's limits (a friend's or a group's also
// held to its own per-run ceiling), the model and output of the profile, the standing instruction as the approval judge's provenance (fixed text, no mail), and its own approver
// state. The payer is the conversation's (payer.ts): the login, or the instance key on her ledger. What differs is data: the owner's run is the "background" policy source with her
// connectors; a friend's or a group's is the isolated one, with the tools its capabilities hold (the notes' file tools left out) and no connectors.
export function heartbeatOptions(conv: Conversation, payer: Payer, extra: ProfileExtra = {}, now = new Date()): RunOptions {
  const p = PROFILES.heartbeat;
  const looker = lookerOf(conv);
  const texts = heartbeatTexts(conv, looker, now);
  const base: RunOptions = looker.own
    ? { source: p.source, systemPrompt: texts.run, skills: p.skills, mcpTools: p.mcpTools, maxTurns: p.maxTurns, maxBudgetUsd: p.maxBudgetUsd }
    : (() => {
        const mine = runOptionsFor(conv, { ...(payer.kind === "instance" ? { apiKey: payer.apiKey } : {}), now });
        return { ...mine, sessionFile: undefined, memory: undefined, seenAt: undefined, groupId: conv.groupId, tools: unattendedTools(mine.tools ?? new Set()), systemPrompt: texts.run, maxTurns: p.maxTurns, maxBudgetUsd: Math.min(p.maxBudgetUsd, mine.maxBudgetUsd), conversation: conv.key };
      })();
  return {
    ...base,
    model: p.model,
    outputFormat: p.outputSchema,
    onToolSuccess: extra.onToolSuccess,
    provenance: fixed(extra.provenance),
    ...(looker.experts ? { experts: { setup: expertSetup(looker.skills, texts.expert), onDelegate: (d) => extra.onDelegate?.(d.agent) } } : {}),
  };
}

// One heartbeat run of a conversation: always a fresh session. `approve` is that conversation's own approver (main.ts).
export const runHeartbeat = (conv: Conversation, payer: Payer, prompt: string, approve: Approve, extra: ProfileExtra = {}): Promise<AgentReply> =>
  runAgent(prompt, approve, heartbeatOptions(conv, payer, extra));

// ---- a conversation's chat: the owner's, a group's, a tenant's ----

// What a turn says, made once it is known whether the session resumes (`since`: the newest line it has been shown, groups only; group.ts).
export type TurnBuilder = (since?: string) => { prompt: string; seenAt?: string; pictures?: Picture[]; documents?: Document[] };

// The one path of a chat turn: the conversation's own resumed session, options (runoptions.ts) and approver (its key), on the conversation's
// warm process when it still fits (agentwarm.ts), else a cold start.
export async function runConversation(conv: Conversation, inputs: RunInputs, build: TurnBuilder, onFirstOutput?: () => void, io: { query?: typeof query } = {}): Promise<AgentReply> {
  const r = chatResume(conv.sessionFile);
  const { prompt, seenAt, pictures, documents } = build(r.resume ? r.seenAt : undefined);
  const o = { ...runOptionsFor(conv, inputs), seenAt, onFirstOutput };
  const context = unseen(conv.sessionFile, r.resume, turnContext(conv, inputs)); // what changed since the session was last told (runoptions.ts), in front of the message
  const input = userInput(context ? `${context}\n\n${prompt}` : prompt, pictures, documents);
  const reply = await runWarmOrCold(conv, o, r, input, (abortController) => (io.query ?? query)({ prompt: input, options: { ...buildOptions(approveIn(conv.key), o, r.resume), abortController } }));
  if (context) markShown(conv.sessionFile, chatResume(conv.sessionFile).resume, context); // the turn went through: the session has it now
  return reply;
}

// Keep a process warm for the conversation's next message. `refresh`: only renew one that is in use (a timer; it does not keep an idle one alive).
// `keep`: not if it holds a fresh one (a message arrived for an active group); otherwise it is rebuilt (the session moved on). WARM=off: nothing.
export function prepare(conv: Conversation, inputs: RunInputs, opts: { refresh?: boolean; keep?: boolean; start?: typeof startup } = {}): void {
  if (opts.refresh && !pool.wants(conv)) return;
  if (!settings.warm) return;
  if (opts.keep && pool.has(conv)) return void pool.touch(conv);
  warmUp(conv, runOptionsFor(conv, inputs), chatResume(conv.sessionFile), opts.start, opts.refresh);
}

// A tenant who was suspended or removed: her process is closed.
export const dropTenantWarm = (id: string): void => pool.drop(tenantKey(id));

// The options of a conversation's background mail handler run (handler.ts), ONE for the owner and every friend: the conversation's own options (runoptions.ts), a
// fresh session, its mail module's tools only (a friend's: from her capability set; the owner's: the connectors, as ever, under the handler's policy source), the
// handler profile's limits (the preset), the notes of the profile's categories that conversation has, the standing task as the approval judge's provenance (fixed text,
// no mail), and the conversation's own approver state. The payer is the conversation's (payer.ts): the login, or the instance key on her ledger.
export function handlerOptions(conv: Conversation, payer: Payer, onToolSuccess: RunOptions["onToolSuccess"], task: string): RunOptions {
  const own = conv.kind === "owner";
  const p = PROFILES.handler;
  const base = runOptionsFor(conv, payer.kind === "instance" ? { apiKey: payer.apiKey } : {});
  const ctx = conv.tenantId ? tenantContext(tenantById(conv.tenantId)!) : undefined;
  const categories = categoriesFor(conv.kind);
  return {
    ...base,
    source: own ? p.source : base.source, // the owner's handler is its own policy source; a friend's is the isolated one
    sessionFile: undefined, // a fresh session every run
    memory: undefined,
    seenAt: undefined,
    skills: own ? undefined : [],
    tools: own ? base.tools : handlerToolsOf(conv, base.tools ?? new Set()),
    systemPrompt: handlerSystem(memoryFor(p.notes.filter((c) => categories.includes(c)), new Date(), conv.notesDir), own ? { missing: missingSetup(readNotes(), down()), down: down() } : { who: ctx!.name }),
    maxTurns: p.maxTurns,
    maxBudgetUsd: own ? p.maxBudgetUsd : Math.min(p.maxBudgetUsd, base.maxBudgetUsd), // a friend's run is also held to her own per-run ceiling
    onToolSuccess,
    provenance: fixed({ kind: "standing", task }), // (no chat message is this run's provenance: the fixed task is)
    conversation: conv.key, // its anti-repeat state is its conversation's, as in its chat
    untrusted: true, // it reads raw mail
  };
}

export const runHandlerTurn = (conv: Conversation, payer: Payer, prompt: string, approve: Approve, onToolSuccess: RunOptions["onToolSuccess"], task: string): Promise<AgentReply> =>
  runAgent(prompt, approve, handlerOptions(conv, payer, onToolSuccess, task));


