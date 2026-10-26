import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, runAgent, type AgentReply, type RunOptions } from "./agentrun.ts";
import { pool, runWarmOrCold, warmUp } from "./agentwarm.ts";
import { runOptionsFor, turnContext, type RunInputs } from "./runoptions.ts";
import { markShown, unseen } from "./turncontext.ts";
import { chatResume } from "./chatsession.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { userInput, type Picture } from "./image.ts";
import type { Document } from "../conversation/document.ts";
import { tenantKey } from "../core/ownerkey.ts";
import { memoryFor, readNotes } from "../memory/notes.ts";
import { missingSetup } from "../modules/index.ts";
import { approveIn, type Approve } from "../approvals/permissions.ts";
import { expertSystem, heartbeatSystem } from "./persona.ts";
import { expertSetup } from "./delegation.ts";
import type { Payer } from "../tenants/payer.ts";
import { categoriesFor, preset } from "../core/preset.ts";
import { tenantById, tenantContext } from "../tenants/tenants.ts";
import { PROFILES } from "./profiles.ts";
import type { SeenMail } from "../modules/seenmail/seenmail.ts";
import { lookerOf, unattendedTools, type Looker } from "./scope.ts";
import { gated } from "../core/rungate.ts";
import { settings } from "../core/settings.ts";
import type { RunProvenance } from "../approvals/autojudge.ts";

// What a job tells the run it starts: the approval judge's provenance, as a value (autojudge.ts RunProvenance): `standing` with the job's fixed text (the heartbeat run's look).
export interface ProfileExtra {
  onToolSuccess?: RunOptions["onToolSuccess"];
  provenance?: RunProvenance;
  onDelegate?: (agent: string) => void; // the heartbeat run: told each accepted delegation to an expert
  seenMail?: SeenMail; // the look's tracker of the inbox mail already worked through (seenmail.ts)
  signal?: AbortSignal; // the look is called off (a chat message overtook it, look.ts)
  untrusted?: boolean; // the prompt itself carries a third party's words (a task made from a mail, look.ts): the judge is told from the first call
}
const fixed = (p: RunProvenance | undefined): RunOptions["provenance"] => p && (() => p);

// The texts of a conversation's heartbeat run and of its expert, for the owner or for a friend or a group (persona.ts heartbeatSystem, expertSystem): the persona, the notes of the
// categories that conversation has (in its own zone: the day an `expires:` is compared with) and, for the owner, what is connected and set up. One function, so the run and its
// expert are told the same notes.
function heartbeatTexts(conv: Conversation, looker: Looker, now: Date): { run: string; expert: string } {
  if (looker.own) {
    const o = { missing: missingSetup(readNotes()) };
    const notes = memoryFor(undefined, now, conv.notesDir, looker.zone);
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
        return { ...mine, sessionConv: undefined, memory: undefined, seenAt: undefined, groupId: conv.groupId, tools: unattendedTools(mine.tools ?? new Set()), systemPrompt: texts.run, maxTurns: p.maxTurns, maxBudgetUsd: Math.min(p.maxBudgetUsd, mine.maxBudgetUsd), conversation: conv.key };
      })();
  return {
    ...base,
    notesRead: { dir: conv.notesDir, ...(looker.own ? {} : { categories: categoriesFor(conv.kind) }), write: preset().notes.background.filter((c) => categoriesFor(conv.kind).includes(c)), maxNotes: settings.memoryMaxNotes, zone: looker.zone },
    model: p.model,
    effort: p.effort,
    maxMinutes: settings.heartbeatTimeoutMinutes, // short on purpose: a look that hangs frees its conversation and is retried on the next ticks (an expert it delegates to: expertMaxMinutes in all)
    expertMaxMinutes: settings.expertTimeoutMinutes,
    outputFormat: p.outputSchema,
    onToolSuccess: extra.onToolSuccess,
    provenance: fixed(extra.provenance),
    signal: extra.signal,
    ...(extra.untrusted ? { untrusted: true } : {}),
    stopScope: conv.convId, // "/stop" in this conversation reaches its look too
    gate: looker.own ? "ownerLook" : conv.kind === "tenant" ? "friendLook" : "look", // the owner's look goes first after a wake or a start, then friends, then groups (rungate.ts)
    unattended: true, // a look answers nobody's message: it acts when sure and asks nobody (permissions.ts UNATTENDED_SKIP), for the owner, a group and a friend alike
    ...(looker.mail && extra.seenMail ? { seenMail: extra.seenMail } : {}),
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
  return gated("chat", () => chatTurn(conv, inputs, build, onFirstOutput, io)); // a place in the run gate (rungate.ts), which a chat turn never waits for
}

async function chatTurn(conv: Conversation, inputs: RunInputs, build: TurnBuilder, onFirstOutput?: () => void, io: { query?: typeof query } = {}): Promise<AgentReply> {
  const r = chatResume(conv.convId);
  const { prompt, seenAt, pictures, documents } = build(r.resume ? r.seenAt : undefined);
  const o = { ...runOptionsFor(conv, inputs), seenAt, onFirstOutput };
  const context = unseen(conv.convId, r.resume, turnContext(conv, inputs)); // what changed since the session was last told (runoptions.ts), in front of the message
  const input = userInput(context ? `${context}\n\n${prompt}` : prompt, pictures, documents);
  const reply = await runWarmOrCold(conv, o, r, input, (abortController) => (io.query ?? query)({ prompt: input, options: { ...buildOptions(approveIn(conv.key), o, r.resume, abortController.signal), abortController } }));
  if (context) markShown(conv.convId, chatResume(conv.convId).resume, context); // the turn went through: the session has it now
  return reply;
}

// Keep a process warm for the conversation's next message. `refresh`: only renew one that is in use (a timer; it does not keep an idle one alive).
// `keep`: not if it holds a fresh one (a message arrived for an active group); otherwise it is rebuilt (the session moved on). WARM=off: nothing.
export function prepare(conv: Conversation, inputs: RunInputs, opts: { refresh?: boolean; keep?: boolean; start?: typeof startup } = {}): void {
  if (opts.refresh && !pool.wants(conv)) return;
  if (!settings.warm) return;
  if (opts.keep && pool.has(conv)) return void pool.touch(conv);
  warmUp(conv, runOptionsFor(conv, inputs), chatResume(conv.convId), opts.start, opts.refresh);
}

// A tenant who was suspended or removed: her process is closed.
export const dropTenantWarm = (id: string): void => pool.drop(tenantKey(id));
