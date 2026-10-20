import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Source } from "./audit.ts";
import type { Category } from "./notes.ts";
import { BROWSE_SCHEMA } from "./browse.ts";
import { groupCapabilities } from "./capabilities.ts";
import { preset } from "./preset.ts";
import { RADAR_SCHEMA } from "./radar-rules.ts";
import { settings } from "./settings.ts";
import { ownerSkills, skillsFor } from "./skills.ts";

// The only skills the model can load. The SDK enforces this list (anything else is refused with
// "not in this session's skills allowlist"); Skill calls never reach canUseTool.
// A group or a tenant loads only the shared ones its capabilities allow (skills.ts), never a private one.
// The owner's are the assistant's own and those of the loaded tool modules (skills.ts): without mail no mail module is loaded, so no mail skill is offered
// (the others keep a few mail sentences; the system prompt says to skip them, persona.ts).
export const offeredSkills = (mail: boolean, provider: string = settings.mailProvider): string[] => ownerSkills(mail, provider);

// ---- run profiles ----
// HOW a run is allowed to work, fixed in code and named: the policy source (policy.ts: which tools are allowed, asked,
// denied), the system prompt, the skills offered, the turn and budget limits and the output schema. A Task (tasks.ts)
// names one; the gate can choose a task but never edit a profile. `notes` are the note categories injected as data.
// The skills are read from the loaded tool modules when asked for (a getter), so the table can be built before the modules are.
export type ProfileName = "chat" | "brief" | "radar" | "background" | "group" | "handler" | "browse";
interface RunProfile {
  readonly source: Source;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly skills: readonly string[];
  readonly outputSchema?: Options["outputFormat"];
  readonly notes: readonly Category[];
}
// The limits and the note categories of each profile are the assistant preset's (assistants/<name>/preset.json "profiles"); the policy source, the output
// schema and the browse worker's settings are the harness's.
const data = preset().profiles;
export const PROFILES: Readonly<Record<ProfileName, RunProfile>> = {
  // The owner's chat: its resumed session, its own notes as memory. A cold prompt cache alone can cost most of a dollar, hence the budget.
  chat: { source: "chat", ...data.chat, get skills() { return ownerSkills(); } },
  // The mail handler (handler.ts), every conversation's: a fresh session, the mail module's tools, standing-task provenance.
  handler: { source: "handler", ...data.handler, get skills() { return ownerSkills(); } },
  // Unattended daily brief: a fresh session each run, a bigger budget, no banter.
  brief: { source: "brief", ...data.brief, get skills() { return ownerSkills(); } },
  // The proactive radar: a fresh session each time; it answers with constrained JSON.
  radar: { source: "radar", ...data.radar, get skills() { return ownerSkills(); }, outputSchema: RADAR_SCHEMA },
  // An unprompted free-form run in the owner's chat (a wake-up): the radar's rights (reads; anything else asks on the phone),
  // web search allowed (page fetches ask), no memory tools (policy.ts, source "background").
  background: { source: "background", ...data.background, get skills() { return ownerSkills(); } },
  // A group's run: its own resumed session, its own notes folder as memory, nothing of the owner's (policy source "group"). Its skills are the shared
  // ones its capability set allows (skills.ts); a tenant's come from her record in the same way (runoptions.ts).
  group: { source: "group", ...data.group, get skills() { return skillsFor(groupCapabilities()); } },
  // The browse sub-task (browse.ts): a fresh run per task with the headless browser, web search and nothing else (no skills, no notes,
  // no connectors, policy source "browse"); it answers with constrained JSON.
  browse: { source: "browse", maxTurns: settings.browseMaxTurns, maxBudgetUsd: settings.browseMaxUsd, skills: [], outputSchema: BROWSE_SCHEMA, notes: [] },
};

export type OwnerProfile = "brief" | "radar" | "background";
