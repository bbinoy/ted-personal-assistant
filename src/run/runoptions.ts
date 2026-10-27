import { createHash } from "node:crypto";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { RunOptions } from "./agentrun.ts";
import { tenantOverBudget } from "../core/budget.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { recentNotices } from "../core/messages.ts";
import { memoryFor, readNotes } from "../memory/notes.ts";
import { missingSetup } from "../modules/index.ts";
import { importOffer } from "../modules/tasks/taskfacts.ts";
import { OWNER_KEY } from "../core/ownerkey.ts";
import type { RunKind } from "../core/runkind.ts";
import { categoriesFor, preset } from "../core/preset.ts";
import { chatContext, chatSystem, expertSystem, FIRST_CONTACT, groupSystem, tenantSystem } from "./persona.ts";
import { allows, capabilitiesOf, toolsFor } from "../policy/capabilities.ts";
import { GOOGLE_MAIL_TOOL } from "../modules/google/module.ts";
import { skillsFor } from "../modules/skills.ts";
import { tenantById, tenantContext, wasDisclosed, zoneOf, type TenantContext } from "../tenants/tenants.ts";
import { settings } from "../core/settings.ts";
import { HEARTBEAT_SCHEMA } from "./rules.ts";
import { expertSetup } from "./delegation.ts";
import { lookerOf } from "./scope.ts";
import type { Track } from "./sessionstore.ts";

// THE builder of the options of a run (CLAUDE.md §2: one agent): `runFor(conv, trigger)` for the owner's chat, a group, a friend, whatever starts it: a message that was written, or
// a look (a background check the assistant starts itself). What a run is made of comes from the conversation's record (conversationmodel.ts: kind, notes folder, session file,
// the group's id) and, for a person with a registry record, that record (tenants.ts: capabilities, credential source, her ledger and limits); its tools and skills from the
// conversation's capability set (capabilities.ts toolsFor, skills.ts skillsFor), the owner's included: she simply has every capability. The caller adds only what is not in a record:
// the style lines of a group's chat, the owner's notifier, the instance key a run on it carries, the clock, and a look's callbacks.
//
//   owner   the preset prompt with the owner's persona, the owner's connectors (agentrun.ts buildOptions: no tenant, no group id)
//   group   the group's persona and its own notes and session; isolated: no connectors, no user settings
//   tenant  a group run with one person in it: her persona, notes, session and limits, her ledger, and the instance key in this run's environment only
//
// What a message and a look differ in is THIS table and nothing else (the code that reads it never asks which trigger it is):
//   attended  who is waiting: a message's person is, a look's nobody. It decides the tools the manifest marks `attended` (the notes' file tools and the edits of the person's list for a message,
//             the look's bookkeeping for a look: toolmanifest.ts), and that an unattended run never asks (permissions.ts)
//   track     the session it resumes: the conversation's chat, or its looks' (sessionstore.ts); different models never share a session
//   model     HARNESS_MODEL, or HEARTBEAT_MODEL (a look is a cheap model that decides and delegates)
//   answer    a reply, or the look's JSON (message, nextCheckMinutes, urgent)
// Not in the table, on purpose: the limits. A look has the conversation's own turn cap, budget, ceiling (RUN_MAX_MINUTES_CHAT) and place in the run gate, exactly as a message has.
//   experts   a look may delegate to the expert (a look only until delegation is built for every run)
// Security stays where it was and is not decided here: the isolation (strictMcpConfig, no settings sources, no plugins) follows from `who` in buildOptions; the tools and skills come from
// the capabilities (capabilities.ts, skills.ts) and policy.ts classify; the instance key goes only into the run's environment (tenanttools.ts tenantEnv).

export type Trigger = "message" | "look";

interface TriggerRow {
  attended: boolean;
  track: Track;
  model: () => string | undefined; // undefined: HARNESS_MODEL
  effort?: Options["effort"];
  answer?: Options["outputFormat"]; // constrained JSON; absent: a normal reply
  experts: boolean; // may delegate to the expert (a look only until delegation is built for every run)
}
export const TRIGGERS: Readonly<Record<Trigger, TriggerRow>> = {
  message: { attended: true, track: "chat", model: () => undefined, experts: false },
  look: {
    attended: false,
    track: "look",
    model: () => settings.heartbeatModel,
    effort: "high",
    answer: HEARTBEAT_SCHEMA,
    experts: true,
  },
};

export interface RunInputs {
  notify?: (text: string) => Promise<void>; // the owner's chat: every change of her notes is announced on the phone (a group's reply says what was saved)
  style?: string; // a group: the style lines of its chat (group.ts styleLines)
  apiKey?: string; // a run on the instance key (a tenant's): TENANT_ANTHROPIC_API_KEY
  now?: Date;
}

type Shape = Pick<RunOptions, "systemPrompt" | "maxTurns" | "maxBudgetUsd" | "tenant"> & { notes: { dir: string; zone: string } };

const ownerShape = (conv: Conversation, i: RunInputs): Shape => ({
  systemPrompt: chatSystem(i.now), // (only what is stable: what changes between two runs is turnContext below)
  notes: { dir: conv.notesDir, zone: zoneOf(conv) },
  ...preset().profiles.chat, // (the preset's: a cold prompt cache alone can cost most of a dollar)
});

const groupShape = (conv: Conversation, i: RunInputs): Shape => ({
  systemPrompt: groupSystem({ style: i.style, caps: capabilitiesOf(conv), looker: lookerOf(conv) }),
  notes: { dir: conv.notesDir, zone: zoneOf(conv) },
  ...preset().profiles.group,
});

// A tenant's run (tenants.ts): an isolated "group" run in a private chat, on the instance key, with her notes, her session, her ledger.
const tenantShape = (conv: Conversation, i: RunInputs): Shape => {
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  if (!rec) throw new Error("not a tenant");
  const ctx: TenantContext = tenantContext(rec);
  const apiKey = i.apiKey;
  if (!apiKey) throw new Error("a tenant's run needs the instance API key"); // never a quiet fall back to the owner's login
  const caps = capabilitiesOf(conv);
  return {
    systemPrompt: tenantSystem({ name: ctx.name, caps, looker: lookerOf(conv), timed: allows(conv, "heartbeat") && allows(conv, "wake"), google: toolsFor(caps, { who: "tenant", attended: true }).has(GOOGLE_MAIL_TOOL), language: ctx.language, persona: ctx.persona, now: i.now ?? new Date() }),
    notes: { dir: ctx.notesDir, zone: zoneOf(conv) },
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

// What changes between two runs of a conversation and so is NOT in its system prompt (a spare process is built from the system prompt, and a resumed session is cached from it on: any change would
// throw both away): told at the start of the run's message instead, and only when it differs from what the session was last told (turncontext.ts). The same hook for every kind and both triggers;
// a group has nothing of the sort. (The facts that code hands every run, held posts to a due routine, are agent.ts's, from heartbeat/facts.ts.)
const CONTEXTS: Record<Conversation["kind"], (conv: Conversation, attended: boolean) => string | undefined> = {
  owner: (_conv, attended) => {
    const notes = readNotes();
    return chatContext({ missing: missingSetup(notes), pings: recentNotices(), tasks: importOffer(OWNER_KEY, notes.some((n) => n.file.startsWith("setup-task"))) }, undefined, attended);
  },
  group: () => undefined,
  // Her first turn after the owner let her in (tenantrun.ts marks it with the first reply): she is new here. Only a message can greet her. (Her mail is read by her look and her tools when she asks: there is no digest to show.)
  tenant: (conv, attended) => {
    const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
    return attended && rec && !wasDisclosed(tenantContext(rec)) ? FIRST_CONTACT : undefined;
  },
};
export const turnContext = (conv: Conversation, trigger: Trigger = "message"): string | undefined => CONTEXTS[conv.kind](conv, TRIGGERS[trigger].attended);

// An unattended run has no file tools for its notes: their index, as data, is the context it is told (and again only when it changed). A message turn's notes are the SDK's auto-memory.
export const notesIndex = (conv: Conversation, trigger: Trigger, now: Date): string | undefined =>
  TRIGGERS[trigger].attended ? undefined : memoryFor(categoriesFor(conv.kind), now, conv.notesDir, zoneOf(conv)) || undefined;

export function runFor(conv: Conversation, trigger: Trigger, inputs: RunInputs = {}): RunOptions {
  const t = TRIGGERS[trigger];
  const kind: RunKind = { who: conv.kind, attended: t.attended };
  const shape = SHAPES[conv.kind](conv, inputs);
  const caps = capabilitiesOf(conv);
  const skills = skillsFor(caps, conv.kind === "owner");
  const now = inputs.now ?? new Date();
  const looker = lookerOf(conv);
  const { notes, ...rest } = shape;
  return {
    ...rest,
    kind,
    sessionConv: conv.convId,
    sessionTrack: t.track,
    conversation: conv.key,
    stopScope: conv.convId, // "/stop" in this conversation reaches its look too
    ...(conv.groupId ? { groupId: conv.groupId } : {}),
    tools: toolsFor(caps, kind),
    skills,
    // Notes: a message turn has the SDK's auto-memory (its file tools and the memory server, confined to the notes folder); an unattended run reads and writes its notes through the notes server
    // (read_note, write_note), which reads untrusted mail and so cannot change them but as logged, inferred facts (modules/memory/notestools.ts).
    ...(t.attended
      ? { memory: { dir: notes.dir, zone: notes.zone, ...(conv.groupId ? { groupId: conv.groupId } : {}), ...(conv.kind === "owner" && inputs.notify ? { notify: inputs.notify } : {}) } }
      : { notesRead: { dir: notes.dir, categories: categoriesFor(conv.kind), write: preset().notes.background.filter((c) => categoriesFor(conv.kind).includes(c)), maxNotes: settings.memoryMaxNotes, zone: notes.zone } }),
    model: t.model(),
    effort: t.effort,
    outputFormat: t.answer,
    ...(t.experts && looker.experts ? { experts: { setup: expertSetup(looker.skills, expertText(conv, now)) } } : {}),
  };
}

// The expert a look may delegate to is told the same persona and notes as the run it works for (persona.ts expertSystem).
function expertText(conv: Conversation, now: Date): string {
  if (conv.kind === "owner") return expertSystem(memoryFor(categoriesFor("owner"), now, conv.notesDir, zoneOf(conv)), { missing: missingSetup(readNotes()) });
  const ctx = conv.tenantId ? tenantContext(tenantById(conv.tenantId)!) : undefined;
  const looker = lookerOf(conv);
  const looked = { name: looker.who, group: looker.group, language: ctx?.language, persona: ctx?.persona };
  return expertSystem(memoryFor(categoriesFor(conv.kind), now, conv.notesDir, zoneOf(conv)), { looked });
}
