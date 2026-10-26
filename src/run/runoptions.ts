import { createHash } from "node:crypto";
import type { RunOptions } from "./agentrun.ts";
import { tenantOverBudget } from "../core/budget.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { recentNotices } from "../core/messages.ts";
import { readNotes } from "../memory/notes.ts";
import { missingSetup } from "../modules/index.ts";
import { importOffer } from "../modules/tasks/taskfacts.ts";
import { OWNER_KEY } from "../core/ownerkey.ts";
import { takeWelcome } from "../core/welcome.ts";
import { chatContext, chatSystem, FIRST_CONTACT, groupSystem, tenantSystem } from "./persona.ts";
import { allows, capabilitiesOf, groupTools, toolsFor } from "../policy/capabilities.ts";
import { GOOGLE_MAIL_TOOL } from "../modules/google/module.ts";
import { PROFILES } from "./profiles.ts";
import { skillsFor } from "../modules/skills.ts";
import { tenantById, tenantContext, wasDisclosed, type TenantContext } from "../tenants/tenants.ts";

// The ONE builder of the options of a conversation's run: the owner's chat, a group and a tenant. What a run is made of comes from the
// conversation's record (conversationmodel.ts: kind, source, notes folder, session file, the group's id) and, for a person with a registry record,
// that record (tenants.ts: capabilities, credential source, her ledger and limits). The caller adds only what is not in a record: the style lines of
// a group's chat, the owner's notifier, the instance key a run on it carries, the clock.
//
//   owner   the preset prompt with the owner's persona and notes, the owner's connectors and tools (agentrun.ts buildOptions: no tenant, no group id)
//   group   the group's persona, its own notes and session, the group profile's limits; isolated: no connectors, no user settings; its tools and skills are those of the group's capability set
//   tenant  a group run with one person in it: her persona, notes, session and limits, her ledger, and the instance key in this run's environment only
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

const ownerShape = (conv: Conversation, i: RunInputs): Shape => ({
  systemPrompt: chatSystem(i.now), // (only what is stable: what changes between two messages is turnContext below)
  memory: { dir: conv.notesDir, ...(i.notify ? { notify: i.notify } : {}) },
  maxTurns: PROFILES.chat.maxTurns,
  maxBudgetUsd: PROFILES.chat.maxBudgetUsd, // (the preset's: a cold prompt cache alone can cost most of a dollar)
});

const groupShape = (conv: Conversation, i: RunInputs): Shape => ({
  systemPrompt: groupSystem({ style: i.style, caps: capabilitiesOf(conv) }),
  memory: { dir: conv.notesDir, groupId: conv.groupId },
  skills: PROFILES.group.skills,
  tools: groupTools(),
  maxTurns: PROFILES.group.maxTurns,
  maxBudgetUsd: PROFILES.group.maxBudgetUsd,
});

// A tenant's turn (tenants.ts): an isolated "group" run in a private chat, on the instance key, with her notes, her session, her ledger.
const tenantShape = (conv: Conversation, i: RunInputs): Shape => {
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  if (!rec) throw new Error("not a tenant");
  const ctx: TenantContext = tenantContext(rec);
  const apiKey = i.apiKey;
  if (!apiKey) throw new Error("a tenant's run needs the instance API key"); // never a quiet fall back to the owner's login
  const caps = capabilitiesOf(conv);
  return {
    systemPrompt: tenantSystem({ name: ctx.name, caps, timed: allows(conv, "heartbeat") && allows(conv, "wake"), google: toolsFor(caps).has(GOOGLE_MAIL_TOOL), language: ctx.language, persona: ctx.persona, now: i.now ?? new Date() }),
    memory: { dir: ctx.notesDir },
    skills: skillsFor(caps),
    tools: toolsFor(caps),
    maxTurns: ctx.maxTurns,
    maxBudgetUsd: ctx.maxBudgetUsdPerRun,
    tenant: {
      id: ctx.id,
      key: conv.key,
      apiKey,
      keyTag: createHash("sha256").update(apiKey).digest("hex").slice(0, 8),
      ledger: ctx.ledger,
      logFile: ctx.logFile,
      overBudget: () => tenantOverBudget(ctx.ledger, ctx.dailyBudgetUsd),
    },
  };
};

const SHAPES: Record<Conversation["kind"], (conv: Conversation, i: RunInputs) => Shape> = { owner: ownerShape, group: groupShape, tenant: tenantShape };

// What changes between two turns of a conversation and so is NOT in its system prompt (a spare process is built from the system prompt, and a resumed session is
// cached from it on: any change would throw both away): told at the start of the turn's message instead, and only when it differs from what the session was last
// told (turncontext.ts). The same hook for every kind; a group has nothing of the sort.
const CONTEXTS: Record<Conversation["kind"], (conv: Conversation, i: RunInputs) => string | undefined> = {
  owner: () => {
    const notes = readNotes();
    return chatContext({ welcome: takeWelcome(), missing: missingSetup(notes), pings: recentNotices(), tasks: importOffer(OWNER_KEY, notes.some((n) => n.file.startsWith("setup-task"))) });
  },
  group: () => undefined,
  // Her first turn after the owner let her in (tenantrun.ts marks it with the first reply): she is new here. (Her mail is read by her heartbeat run and her tools when she asks: there is no digest to show.)
  tenant: (conv) => {
    const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
    return rec && !wasDisclosed(tenantContext(rec)) ? FIRST_CONTACT : undefined;
  },
};
export const turnContext = (conv: Conversation, inputs: RunInputs = {}): string | undefined => CONTEXTS[conv.kind](conv, inputs);

export function runOptionsFor(conv: Conversation, inputs: RunInputs = {}): RunOptions {
  return { source: conv.source, sessionConv: conv.convId, ...SHAPES[conv.kind](conv, inputs) };
}
