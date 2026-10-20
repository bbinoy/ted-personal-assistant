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
import { tenantKey } from "./send.ts";
import { memoryFor, missingSetup, readNotes } from "./notes.ts";
import { approveIn, type Approve } from "./permissions.ts";
import { backgroundSystem, briefSystem, handlerSystem, radarSystem, tenantHandlerSystem } from "./persona.ts";
import { GOOGLE_PREFIX } from "./modules/google.ts";
import { tenantById, tenantContext } from "./tenants.ts";
import { PROFILES, type OwnerProfile } from "./profiles.ts";
import { settings } from "./settings.ts";
import type { RunProvenance } from "./autojudge.ts";

const down = () => disconnected(readConnectors());

function profileSystem(name: OwnerProfile): string {
  const notes = memoryFor(PROFILES[name].notes);
  const missing = missingSetup(readNotes(), down());
  return name === "brief" ? briefSystem(notes, missing, down()) : name === "radar" ? radarSystem(notes, missing, down()) : backgroundSystem(notes, missing, down());
}

// What a job tells the run it starts: the approval judge's provenance, as a value (autojudge.ts RunProvenance): `standing` with the job's fixed text (the brief's and the radar's
// instructions), `derived` for a wake-up, whose task a gate model wrote.
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

// A friend's background mail handler run (mailloops.ts): a fresh run of hers on the instance key, with her Google tools and nothing else, her notes as data, and her
// chat's approver, so that anything it would send or invite asks HER there. The standing task is the approval judge's provenance, as for the owner's handler.
export function tenantHandlerOptions(conv: Conversation, access: { apiKey: string }, onToolSuccess: RunOptions["onToolSuccess"], task: string): RunOptions {
  const base = runOptionsFor(conv, { apiKey: access.apiKey });
  const rec = tenantById(conv.tenantId!);
  const ctx = tenantContext(rec!);
  return {
    ...base,
    sessionFile: undefined, // a fresh session every run
    memory: undefined,
    seenAt: undefined,
    skills: [],
    tools: new Set([...(base.tools ?? [])].filter((t) => t.startsWith(GOOGLE_PREFIX))),
    systemPrompt: tenantHandlerSystem(ctx.name, memoryFor(["people", "scheduling", "context", "style"], new Date(), ctx.notesDir)),
    maxTurns: Math.max(ctx.maxTurns, 25),
    onToolSuccess,
    provenance: fixed({ kind: "standing", task }), // (no chat message of hers is this run's provenance: the fixed task is)
    conversation: conv.key, // her anti-repeat state is her conversation's, as in her chat
    untrusted: true, // it reads raw mail
  };
}

export const runTenantHandlerTurn = (conv: Conversation, access: { apiKey: string }, prompt: string, approve: Approve, onToolSuccess: RunOptions["onToolSuccess"], task: string): Promise<AgentReply> =>
  runAgent(prompt, approve, tenantHandlerOptions(conv, access, onToolSuccess, task));

// ---- the other owner runs ----

// Background handling of heartbeat-flagged mail: fresh session, least privilege (see policy.ts).
export function runHandlerTurn(prompt: string, approve: Approve, onToolSuccess?: (tool: string, input: unknown, response?: unknown) => void, task?: string): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "handler",
    systemPrompt: handlerSystem(memoryFor(["people", "scheduling", "context", "style", "setup", "voice"]), missingSetup(readNotes(), down()), down()),
    maxTurns: 40,
    maxBudgetUsd: 2.0,
    onToolSuccess,
    provenance: fixed(task ? { kind: "standing", task } : undefined), // the standing task: the approval judge's provenance (fixed text, no mail)
    untrusted: true, // it reads raw mail
  });
}
