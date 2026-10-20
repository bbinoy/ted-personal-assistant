import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Source } from "./audit.ts";
import type { Category } from "./notes.ts";
import { BROWSE_SCHEMA } from "./browse.ts";
import { groupCapabilities } from "./capabilities.ts";
import { preset } from "./preset.ts";
import { RADAR_SCHEMA } from "./radar-rules.ts";
import { settings } from "./settings.ts";
import { toolsFor } from "./profiletools.ts";
import { ownerSkills, skillsFor } from "./skills.ts";


// ---- run profiles ----
// HOW a run is allowed to work, fixed in code and named: the policy source (policy.ts: which tools are allowed, asked,
// denied), the system prompt, the skills offered, the turn and budget limits and the output schema. A Task (tasks.ts)
// names one; the gate can choose a task but never edit a profile. `notes` are the note categories injected as data.
// The skills are read from the loaded tool modules when asked for (a getter), so the table can be built before the modules are.
export type ProfileName = "brief" | "radar" | "background" | "group" | "browse";
interface RunProfile {
  readonly source: Source;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly skills: readonly string[];
  readonly mcpTools?: ReadonlySet<string>; // the connector tools the job sees; absent: the owner's whole set (profiletools.ts)
  readonly outputSchema?: Options["outputFormat"];
  readonly notes: readonly Category[];
}
// What the radar uses, as the radar skill (plugin/skills/radar/SKILL.md) and the skills it names ask for: it reads the calendar and the owner's task list and
// meeting notes, may write the meeting prep page, and sends its nudge as its JSON answer. No mail client, no calendar writes, no other connector: those schemas
// would be sent on every one of its calls (a test pins that every tool and skill the radar skill names is here).
export const RADAR_SKILLS = ["radar", "calendar", "meeting-prep", "notion-tasks"] as const;
export const RADAR_TOOLS = ["calendar:read", "notion:read", "notion:page-write"] as const;
const named = (names: readonly string[]) => ownerSkills().filter((s) => names.includes(s.split(":").pop()!));

// The limits and the note categories of each profile are the assistant preset's (assistants/<name>/preset.json "profiles"); the policy source, the output
// schema and the browse worker's settings are the harness's.
const data = preset().profiles;
export const PROFILES: Readonly<Record<ProfileName, RunProfile>> = {
  // Unattended daily brief: a fresh session each run, a bigger budget, no banter.
  brief: { source: "brief", ...data.brief, get skills() { return ownerSkills(); } },
  // The proactive radar: a fresh session each time; it answers with constrained JSON.
  radar: { source: "radar", ...data.radar, get skills() { return named(RADAR_SKILLS); }, get mcpTools() { return toolsFor(RADAR_TOOLS); }, outputSchema: RADAR_SCHEMA },
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

export type OwnerProfile = Exclude<ProfileName, "group" | "browse">;
