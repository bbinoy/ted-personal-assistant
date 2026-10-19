import type { Capability } from "./tenants.ts";

// Which bundled skills (plugin/skills/) a conversation without the owner's login may load, and the capabilities each needs. The owner loads the
// whole plugin (profiles.ts offeredSkills); a group or a tenant loads only the skills here whose capabilities its set holds (skillsFor), through the
// same plugin, with the SDK's skills allowlist as the gate. A skill that is in neither list is a mistake: the test names every folder of plugin/skills.
export const PLUGIN = "ted-personal-assistant";

export const SHARED_SKILLS: Readonly<Record<string, readonly Capability[]>> = {
  "research-booking": ["browse"], // finds options with web search and the browse tool; booking asks the conversation first
  "surf-conditions": ["weather"], // the weather tools and this conversation's notes
  draw: ["draw"], // the draw tool, then send
};

// Never offered to a group or a tenant, whatever capability she holds: they read or write the owner's mail, calendar, Notion, brief and setup.
export const PRIVATE_SKILLS: readonly string[] = ["daily-brief", "mailbird", "mailbird-troubleshooting", "gmail", "calendar", "notion-tasks", "meeting-prep", "setup", "radar", "follow-through"];

export const skillsFor = (caps: ReadonlySet<Capability>): string[] =>
  Object.entries(SHARED_SKILLS).filter(([, needs]) => needs.every((c) => caps.has(c))).map(([name]) => `${PLUGIN}:${name}`);
