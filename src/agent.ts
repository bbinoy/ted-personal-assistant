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
import { backgroundSystem, briefSystem, handlerSystem, radarSystem } from "./persona.ts";
import { handlerToolsOf } from "./mailhandler.ts";
import type { Payer } from "./payer.ts";
import { categoriesFor } from "./preset.ts";
import { tenantById, tenantContext } from "./tenants/tenants.ts";
import { PROFILES, type OwnerProfile } from "./profiles.ts";
import { settings } from "./settings.ts";
import type { RunProvenance } from "./approvals/autojudge.ts";

const down = () => disconnected(readConnectors());

function profileSystem(name: OwnerProfile): string {
  const notes = memoryFor(PROFILES[name].notes);
  const off = down(); // (read once)
  const missing = missingSetup(readNotes(), off);
  return name === "brief" ? briefSystem(notes, missing, off) : name === "radar" ? radarSystem(notes, missing, off) : backgroundSystem(notes, missing, off);
}

// What a job tells the run it starts: the approval judge's provenance, as a value (autojudge.ts RunProvenance): `standing` with the job's fixed text (the brief's and the radar's
// instructions), `derived` for a wake-up, whose task a gate model selected from the notes (the person's standing instruction, judged like their chat message).
export interface ProfileExtra {
  onToolSuccess?: RunOptions["onToolSuccess"];
  provenance?: RunProvenance;
}
const fixed = (p: RunProvenance | undefined): RunOptions["provenance"] => p && (() => p);

// The options of an owner profile's run (a fresh session).
export function profileOptions(name: OwnerProfile, extra: ProfileExtra = {}): RunOptions {
  const p = PROFILES[name];
  return { source: p.source, systemPrompt: profileSystem(name), skills: p.skills, mcpTools: p.mcpTools, maxTurns: p.maxTurns, maxBudgetUsd: p.maxBudgetUsd, outputFormat: p.outputSchema, onToolSuccess: extra.onToolSuccess, provenance: fixed(extra.provenance) };
}

// One run under a named owner profile: always a fresh session.
export const runProfile = (name: OwnerProfile, prompt: string, approve: Approve, extra: ProfileExtra = {}): Promise<AgentReply> =>
  runAgent(prompt, approve, profileOptions(name, extra));

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


