import { createHash } from "node:crypto";
import type { RunOptions } from "./agentrun.ts";
import { tenantOverBudget } from "./budget.ts";
import { disconnected, readConnectors } from "./connectors.ts";
import { allows, type Conversation } from "./conversationmodel.ts";
import { recentNotices } from "./messages.ts";
import { LAST_BRIEF, missingSetup, readNotes } from "./notes.ts";
import { chatSystem, groupSystem, tenantSystem } from "./persona.ts";
import { groupTools, tenantCapabilities, toolsFor } from "./capabilities.ts";
import { GOOGLE_MAIL_TOOL } from "./modules/google.ts";
import { mailDigest } from "./tenantmail.ts";
import { PROFILES } from "./profiles.ts";
import { readText } from "./state.ts";
import { skillsFor } from "./skills.ts";
import { readConsent, TENANT_CONSENT_TOOL, tenantById, tenantContext, type TenantContext } from "./tenants.ts";

// The ONE builder of the options of a conversation's run: the owner's chat, a group and a tenant. What a run is made of comes from the
// conversation's record (conversationmodel.ts: kind, source, notes folder, session file, the group's id) and, for a person with a registry record,
// that record (tenants.ts: capabilities, credential source, her ledger and limits). The caller adds only what is not in a record: the style lines of
// a group's chat, the owner's notifier, the instance key a run on it carries, the clock.
//
//   owner   the preset prompt with the owner's persona and notes, the owner's connectors and tools (agentrun.ts buildOptions: no tenant, no group id)
//   group   the group's persona, its own notes and session, the group profile's limits; isolated: no connectors, no user settings; its tools and skills are those of the group's capability set
//   tenant  a group run with one person in it: her persona, notes, session and limits, her ledger and consent, and the instance key in this run's environment only
//
// Security stays where it was and is not decided here: the isolation (strictMcpConfig, no settings sources, no plugins) follows from `source` in
// buildOptions; the tools and skills of a group or a tenant come from its capabilities (capabilities.ts, skills.ts) and policy.ts classify; the instance key goes only into the
// run's environment (tenanttools.ts tenantEnv).

export interface RunInputs {
  notify?: (text: string) => Promise<void>; // the owner's chat: every change of her notes is announced on the phone (a group's reply says what was saved)
  style?: string; // a group: the style lines of its chat (group.ts styleLines)
  apiKey?: string; // a run on the instance key (a tenant's): TENANT_ANTHROPIC_API_KEY
  now?: Date;
}

type Shape = Pick<RunOptions, "systemPrompt" | "maxTurns" | "maxBudgetUsd" | "memory" | "skills" | "tools" | "tenant">;

const down = () => disconnected(readConnectors());

const ownerShape = (conv: Conversation, i: RunInputs): Shape => ({
  systemPrompt: chatSystem(readText(LAST_BRIEF), i.now, missingSetup(readNotes(), down()), down(), recentNotices()),
  memory: { dir: conv.notesDir, ...(i.notify ? { notify: i.notify } : {}) },
  maxTurns: 40,
  maxBudgetUsd: 2.0, // a cold prompt cache alone can cost most of a dollar
});

const groupShape = (conv: Conversation, i: RunInputs): Shape => ({
  systemPrompt: groupSystem({ style: i.style }),
  memory: { dir: conv.notesDir, groupId: conv.groupId },
  skills: PROFILES.group.skills,
  tools: groupTools(),
  maxTurns: PROFILES.group.maxTurns,
  maxBudgetUsd: PROFILES.group.maxBudgetUsd,
});

// A tenant's turn (tenants.ts): an isolated "group" run in a private chat, on the instance key, with her notes, her session, her ledger. Until she has
// confirmed her age and region the run has one tool, record_consent, and no skill.
const tenantShape = (conv: Conversation, i: RunInputs): Shape => {
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  if (!rec) throw new Error("not a tenant");
  const ctx: TenantContext = tenantContext(rec);
  const apiKey = i.apiKey;
  if (!apiKey) throw new Error("a tenant's run needs the instance API key"); // never a quiet fall back to the owner's login
  const consented = !!readConsent(ctx);
  const caps = tenantCapabilities(ctx);
  return {
    systemPrompt: tenantSystem({ name: ctx.name, consented, timed: allows(conv, "heartbeat") && allows(conv, "wake"), google: consented && toolsFor(caps).has(GOOGLE_MAIL_TOOL), digest: consented && toolsFor(caps).has(GOOGLE_MAIL_TOOL) ? mailDigest(ctx, i.now ?? new Date()) : undefined, language: ctx.language, persona: ctx.persona, now: i.now ?? new Date() }),
    memory: { dir: ctx.notesDir },
    skills: consented ? skillsFor(caps) : [],
    tools: consented ? toolsFor(caps) : new Set([TENANT_CONSENT_TOOL]),
    maxTurns: ctx.maxTurns,
    maxBudgetUsd: ctx.maxBudgetUsdPerRun,
    tenant: {
      id: ctx.id,
      key: conv.key,
      apiKey,
      keyTag: createHash("sha256").update(apiKey).digest("hex").slice(0, 8),
      costFile: ctx.costFile,
      logFile: ctx.logFile,
      consentFile: ctx.consentFile,
      consented,
      overBudget: () => tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd),
    },
  };
};

const SHAPES: Record<Conversation["kind"], (conv: Conversation, i: RunInputs) => Shape> = { owner: ownerShape, group: groupShape, tenant: tenantShape };

export function runOptionsFor(conv: Conversation, inputs: RunInputs = {}): RunOptions {
  return { source: conv.source, sessionFile: conv.sessionFile, ...SHAPES[conv.kind](conv, inputs) };
}
