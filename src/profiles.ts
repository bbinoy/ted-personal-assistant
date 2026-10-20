import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Source } from "./audit.ts";
import type { Category } from "./notes.ts";
import { BROWSE_SCHEMA } from "./modules/browse/browse.ts";
import { groupCapabilities } from "./policy/capabilities.ts";
import { preset } from "./preset.ts";
import { HEARTBEAT_SCHEMA } from "./heartbeat/rules.ts";
import { settings } from "./settings.ts";
import { ownerSkills, skillsFor } from "./skills.ts";


// ---- run profiles ----
// HOW a run is allowed to work, fixed in code and named: the policy source (policy.ts: which tools are allowed, asked,
// denied), the system prompt, the skills offered, the turn and budget limits and the output schema. The gate can
// choose the instructions of a free-form wake-up but never name or edit a profile. `notes` are the note categories injected as data.
// The skills are read from the loaded tool modules when asked for (a getter), so the table can be built before the modules are.
export type ProfileName = "chat" | "heartbeat" | "background" | "group" | "handler" | "browse";
interface RunProfile {
  readonly source: Source;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly skills: readonly string[];
  readonly mcpTools?: ReadonlySet<string>; // the connector tools the job sees; absent: the owner's whole set (profiletools.ts)
  readonly model?: string; // the run's own model (default: HARNESS_MODEL)
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
  // The owner's heartbeat run (heartbeat/look.ts): one look at everything, a fresh session each time, on HEARTBEAT_MODEL (Haiku by default). Every connector tool the owner
  // has is offered and every call passes the same floor, judge and phone as anywhere (policy source "background"); it answers with constrained JSON.
  heartbeat: { source: "background", ...data.heartbeat, get skills() { return ownerSkills(); }, get model() { return settings.heartbeatModel; }, outputSchema: HEARTBEAT_SCHEMA },
  // An unprompted free-form run in a conversation (a wake-up): reads are free, anything else asks on the phone,
  // web search allowed (page fetches ask), no memory tools (policy.ts, source "background").
  background: { source: "background", ...data.background, get skills() { return ownerSkills(); } },
  // A group's run: its own resumed session, its own notes folder as memory, nothing of the owner's (policy source "group"). Its skills are the shared
  // ones its capability set allows (skills.ts); a tenant's come from her record in the same way (runoptions.ts).
  group: { source: "group", ...data.group, get skills() { return skillsFor(groupCapabilities()); } },
  // The browse sub-task (browse.ts): a fresh run per task with the headless browser, web search and nothing else (no skills, no notes,
  // no connectors, policy source "browse"); it answers with constrained JSON.
  browse: { source: "browse", maxTurns: settings.browseMaxTurns, maxBudgetUsd: settings.browseMaxUsd, skills: [], outputSchema: BROWSE_SCHEMA, notes: [] },
};

export type OwnerProfile = "heartbeat" | "background";
