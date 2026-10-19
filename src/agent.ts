import { createHash } from "node:crypto";
import { query, startup, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, runAgent, type AgentReply, type RunOptions } from "./agentrun.ts";
import { groupSpare, newSlot, runWarmOrCold, spare, warmUp } from "./agentwarm.ts";
import { tenantOverBudget } from "./budget.ts";
import { readConsent, TENANT_CONSENT_TOOL, toolsFor, type TenantContext } from "./tenants.ts";
import type { SpareSlot } from "./warmslot.ts";
import { chatResume } from "./chatsession.ts";
import { disconnected, readConnectors } from "./connectors.ts";
import type { Conversation } from "./conversation.ts";
import { userInput, type Picture } from "./image.ts";
import type { Document } from "./document.ts";
import { LAST_BRIEF, memoryFor, missingSetup, NOTES_DIR, readNotes } from "./notes.ts";
import { approveIn, setChatOwnerMessage, type Approve } from "./permissions.ts";
import { backgroundSystem, briefSystem, chatSystem, groupSystem, handlerSystem, radarSystem, tenantSystem } from "./persona.ts";
import { PROFILES, type OwnerProfile } from "./profiles.ts";
import { recentNotices } from "./messages.ts";
import { OWNER_SESSION_FILE } from "./session.ts";
import { settings } from "./settings.ts";
import { readText } from "./state.ts";

const down = () => disconnected(readConnectors());

function profileSystem(name: OwnerProfile): string {
  const notes = memoryFor(PROFILES[name].notes);
  const missing = missingSetup(readNotes(), down());
  return name === "brief" ? briefSystem(notes, missing, down()) : name === "radar" ? radarSystem(notes, missing, down()) : backgroundSystem(notes, missing, down());
}

// The options of an owner profile's run (a fresh session).
function profileOptions(name: OwnerProfile, extra: { onToolSuccess?: RunOptions["onToolSuccess"]; judgeContext?: string } = {}): RunOptions {
  const p = PROFILES[name];
  return { source: p.source, systemPrompt: profileSystem(name), skills: p.skills, maxTurns: p.maxTurns, maxBudgetUsd: p.maxBudgetUsd, outputFormat: p.outputSchema, onToolSuccess: extra.onToolSuccess, judgeContext: extra.judgeContext };
}

// One run under a named owner profile: always a fresh session.
export const runProfile = (name: OwnerProfile, prompt: string, approve: Approve, extra: { onToolSuccess?: RunOptions["onToolSuccess"]; judgeContext?: string } = {}): Promise<AgentReply> =>
  runAgent(prompt, approve, profileOptions(name, extra));

// ---- the owner's chat ----

const chatOptions = (notify: (text: string) => Promise<void>): RunOptions => ({
  source: "chat",
  systemPrompt: chatSystem(readText(LAST_BRIEF), new Date(), missingSetup(readNotes(), down()), down(), recentNotices()),
  sessionFile: OWNER_SESSION_FILE,
  memory: { dir: NOTES_DIR, notify },
  maxTurns: 40,
  maxBudgetUsd: 2.0, // a cold prompt cache alone can cost most of a dollar
});

export function prepareChat(approve: Approve, notify: (text: string) => Promise<void>, o: { refresh?: boolean } = {}): void {
  if (o.refresh && !spare.wants("owner")) return; // the timer renews a process in use; it does not keep an idle one alive
  warmUp(spare, "owner", chatOptions(notify), chatResume(), "chat", approve, startup, o.refresh);
}

// Interactive chat: resumes the persistent conversation, on the warm process when it fits.
export async function ask(prompt: string, approve: Approve, notify: (text: string) => Promise<void>, ownerMessage?: string, pictures: Picture[] = [], hooks?: { firstOutput: () => void }, documents: Document[] = []): Promise<AgentReply> {
  setChatOwnerMessage(ownerMessage ?? prompt);
  spare.touch("owner"); // in use: the idle period starts over
  const o = { ...chatOptions(notify), onFirstOutput: hooks?.firstOutput };
  const r = chatResume();
  const input = userInput(prompt, pictures, documents);
  return runWarmOrCold(spare, "owner", o, r, "chat", input, (abortController) => query({ prompt: input, options: { ...buildOptions(approve, o, r.resume), abortController } }));
}

// ---- a group's chat ----

// A group turn: the group's own resumed session, memory (its notes folder) and tools.
// Groups are bursty and many, so there is no warm process per group: one is kept for the group that spoke last (above).
type GroupConv = Pick<Conversation, "notesDir" | "sessionFile" | "groupId">;
export const groupRunOptions = (conv: GroupConv, systemPrompt: string): RunOptions => ({
  source: PROFILES.group.source,
  systemPrompt,
  sessionFile: conv.sessionFile,
  memory: { dir: conv.notesDir, groupId: conv.groupId },
  skills: PROFILES.group.skills,
  maxTurns: PROFILES.group.maxTurns,
  maxBudgetUsd: PROFILES.group.maxBudgetUsd,
});

// `build` makes the prompt once it is known whether the session resumes: a resumed one is told only what it has not seen (group.ts).
export async function runGroupTurn(conv: GroupConv, style: string, build: (since?: string) => { prompt: string; seenAt?: string; pictures?: Picture[]; documents?: Document[] }, onFirstOutput?: () => void, io: { query?: typeof query } = {}): Promise<AgentReply> {
  const r = chatResume(conv.sessionFile);
  const { prompt, seenAt, pictures, documents } = build(r.resume ? r.seenAt : undefined);
  const o = { ...groupRunOptions(conv, groupSystem({ style })), seenAt, onFirstOutput };
  const input = userInput(prompt, pictures, documents);
  // The group's own warm process, if it is the one kept and nothing it was built from has changed (same group, session, prompt, notes index).
  return runWarmOrCold(groupSpare, conv.groupId, o, r, "group", input, (abortController) => (io.query ?? query)({ prompt: input, options: { ...buildOptions(approveIn(conv.groupId!), o, r.resume), abortController } }));
}

// Keep ONE warm process for the group that spoke last, replacing another group's. Called when a message arrives for a
// group that may be answered (not if it already holds a fresh one), and after each of its turns (`force`: the session moved on).
// Nothing happens with WARM=off.
export function prepareGroupChat(conv: GroupConv, style: () => string, opts: { force?: boolean; start?: typeof startup } = {}): void {
  const id = conv.groupId;
  if (!settings.warm || !id) return;
  if (!opts.force && groupSpare.has(id)) return void groupSpare.touch(id); // active group, already warm: keep it so
  warmUp(groupSpare, id, groupRunOptions(conv, groupSystem({ style: style() })), chatResume(conv.sessionFile), "group", approveIn(id), opts.start);
}

// ---- the other owner runs ----

// Background handling of heartbeat-flagged mail: fresh session, least privilege (see policy.ts).
export function runHandlerTurn(prompt: string, approve: Approve, onToolSuccess?: (tool: string, input: unknown, response?: unknown) => void): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "handler",
    systemPrompt: handlerSystem(memoryFor(["people", "scheduling", "context", "style", "setup", "voice"]), missingSetup(readNotes(), down()), down()),
    maxTurns: 40,
    maxBudgetUsd: 2.0,
    onToolSuccess,
  });
}


// ---- a tenant's chat ----

// A tenant's turn (tenants.ts): an isolated "group" run in a private chat, on the instance key, with her notes, her session, her ledger. Until she has
// confirmed her age and region the run has one tool, record_consent. The key (settings.tenantApiKey, via tenantrun.ts) goes only into this run's environment.
export function tenantRunOptions(ctx: TenantContext, apiKey: string, now = new Date()): RunOptions {
  const consented = !!readConsent(ctx);
  const key = `tenant:${ctx.id}`;
  return {
    source: PROFILES.group.source,
    systemPrompt: tenantSystem({ name: ctx.name, consented, language: ctx.language, persona: ctx.persona, now }),
    sessionFile: ctx.sessionFile,
    memory: { dir: ctx.notesDir },
    skills: PROFILES.group.skills,
    maxTurns: ctx.maxTurns,
    maxBudgetUsd: ctx.maxBudgetUsdPerRun,
    tenant: {
      id: ctx.id,
      key,
      apiKey,
      keyTag: createHash("sha256").update(apiKey).digest("hex").slice(0, 8),
      costFile: ctx.costFile,
      logFile: ctx.logFile,
      consentFile: ctx.consentFile,
      consented,
      tools: consented ? new Set([...toolsFor(ctx)].filter((t) => t !== TENANT_CONSENT_TOOL)) : new Set([TENANT_CONSENT_TOOL]),
      overBudget: () => tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd),
    },
  };
}

// The few most recently active tenants keep a warm process each (TENANT_WARM_MAX); an older one is closed to make room. WARM=off: none.
const tenantSlots = new Map<string, SpareSlot<WarmQuery>>();
const noSlot = newSlot(); // never filled: a run without a warm process still goes through the same path
function tenantSlot(id: string, create: boolean): SpareSlot<WarmQuery> | undefined {
  if (!settings.warm || settings.tenantWarmMax <= 0) return undefined;
  let slot = tenantSlots.get(id);
  if (slot) tenantSlots.delete(id); // re-inserted last: the oldest entries are the ones to close
  else if (create) slot = newSlot();
  if (!slot) return undefined;
  tenantSlots.set(id, slot);
  while (tenantSlots.size > settings.tenantWarmMax) {
    const [oldest, old] = tenantSlots.entries().next().value!;
    old.drop();
    tenantSlots.delete(oldest);
  }
  return slot;
}
export function dropTenantWarm(id: string): void {
  tenantSlots.get(id)?.drop();
  tenantSlots.delete(id);
}
export const tenantWarmHolders = (): string[] => [...tenantSlots].filter(([, s]) => s.holder).map(([id]) => id); // tests

export async function askTenant(ctx: TenantContext, apiKey: string, prompt: string, pictures: Picture[] = [], hooks?: { firstOutput: () => void }, documents: Document[] = [], io: { query?: typeof query } = {}): Promise<AgentReply> {
  const r = chatResume(ctx.sessionFile);
  const o = { ...tenantRunOptions(ctx, apiKey), onFirstOutput: hooks?.firstOutput };
  const input = userInput(prompt, pictures, documents);
  const slot = tenantSlot(ctx.id, false);
  slot?.touch(ctx.id);
  return runWarmOrCold(slot ?? noSlot, slot ? ctx.id : undefined, o, r, "tenant", input, (abortController) => (io.query ?? query)({ prompt: input, options: { ...buildOptions(approveIn(o.tenant!.key), o, r.resume), abortController } }));
}

// After her turn: keep a process warm for her next message (her session moved on).
export function prepareTenantChat(ctx: TenantContext, apiKey: string, opts: { start?: typeof startup } = {}): void {
  const slot = tenantSlot(ctx.id, true);
  if (!slot) return;
  const o = tenantRunOptions(ctx, apiKey);
  warmUp(slot, ctx.id, o, chatResume(ctx.sessionFile), "tenant", approveIn(o.tenant!.key), opts.start);
}
