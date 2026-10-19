import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Source } from "./audit.ts";
import type { Category } from "./notes.ts";
import { BROWSE_SCHEMA } from "./browse.ts";
import { groupCapabilities } from "./capabilities.ts";
import { RADAR_SCHEMA } from "./radar-rules.ts";
import { settings } from "./settings.ts";
import { skillsFor } from "./skills.ts";

// The only skills the model can load. The SDK enforces this list (anything else is refused with
// "not in this session's skills allowlist"); Skill calls never reach canUseTool.
// A group or a tenant loads only the shared ones its capabilities allow (skills.ts), never a private one.
// Without mail the two mail skills are not offered (the others keep a few mail sentences; the system prompt says to skip them, persona.ts).
const MAIL_SKILLS = ["mailbird", "mailbird-troubleshooting", "gmail"];
export const offeredSkills = (mail: boolean, provider: string = settings.mailProvider): string[] =>
  ["daily-brief", provider === "gmail" ? "gmail" : "mailbird", ...(provider === "gmail" ? [] : ["mailbird-troubleshooting"]), "calendar", "notion-tasks", "meeting-prep", "research-booking", "follow-through", "setup", "radar", ...(settings.weather ? ["surf-conditions"] : []), ...(settings.draw ? ["draw"] : [])].filter((s) => mail || !MAIL_SKILLS.includes(s)).map((s) => `ted-personal-assistant:${s}`);
export const OFFERED_SKILLS = offeredSkills(settings.mail, settings.mailProvider);

// ---- run profiles ----
// HOW a run is allowed to work, fixed in code and named: the policy source (policy.ts: which tools are allowed, asked,
// denied), the system prompt, the skills offered, the turn and budget limits and the output schema. A Task (tasks.ts)
// names one; the gate can choose a task but never edit a profile. `notes` are the note categories injected as data.
export type ProfileName = "brief" | "radar" | "background" | "group" | "browse";
interface RunProfile {
  readonly source: Source;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly skills: readonly string[];
  readonly outputSchema?: Options["outputFormat"];
  readonly notes: readonly Category[];
}
export const PROFILES: Readonly<Record<ProfileName, RunProfile>> = {
  // Unattended daily brief: a fresh session each run, a bigger budget, no banter.
  brief: { source: "brief", maxTurns: 120, maxBudgetUsd: 5.0, skills: OFFERED_SKILLS, notes: ["triage", "people", "scheduling", "context", "brief", "style", "setup", "voice"] },
  // The proactive radar: a fresh session each time; it answers with constrained JSON.
  radar: { source: "radar", maxTurns: 30, maxBudgetUsd: 1.0, skills: OFFERED_SKILLS, outputSchema: RADAR_SCHEMA, notes: ["people", "scheduling", "context", "style", "brief", "setup", "voice"] },
  // An unprompted free-form run in the owner's chat (a wake-up): the radar's rights (reads; anything else asks on the phone),
  // web search allowed (page fetches ask), no memory tools (policy.ts, source "background").
  background: { source: "background", maxTurns: 20, maxBudgetUsd: 1.0, skills: OFFERED_SKILLS, notes: ["people", "scheduling", "context", "style", "brief", "setup", "voice"] },
  // A group's run: its own resumed session, its own notes folder as memory, nothing of the owner's (policy source "group"). Its skills are the shared
  // ones its capability set allows (skills.ts); a tenant's come from her record in the same way (runoptions.ts).
  group: { source: "group", maxTurns: 8, maxBudgetUsd: 0.5, skills: skillsFor(groupCapabilities()), notes: [] },
  // The browse sub-task (browse.ts): a fresh run per task with the headless browser, web search and nothing else (no skills, no notes,
  // no connectors, policy source "browse"); it answers with constrained JSON.
  browse: { source: "browse", maxTurns: settings.browseMaxTurns, maxBudgetUsd: settings.browseMaxUsd, skills: [], outputSchema: BROWSE_SCHEMA, notes: [] },
};

export type OwnerProfile = Exclude<ProfileName, "group" | "browse">;
