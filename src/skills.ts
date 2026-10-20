import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loaded, registered } from "./modules/index.ts";
import type { ModuleSkill, ToolModule } from "./modules/types.ts";
import { PLUGIN, preset } from "./preset.ts";
import { settings } from "./settings.ts";
import type { Capability } from "./tenants/tenants.ts";

// Which bundled skills (plugin/skills/) a conversation may load. A skill comes from a tool module (the calendar module brings `calendar`, a mail module its
// mail skill, weather `surf-conditions`, draw `draw`, browse `research-booking`) or is the assistant's own (CORE_SKILLS: the brief, the radar, setup...).
// The owner loads the whole plugin (ownerSkills); a group or a tenant loads only the shared skills whose capabilities its set holds (skillsFor),
// through the same plugin, with the SDK's skills allowlist as the gate. A skill that is neither shared nor private is a mistake: the test names every folder
// of plugin/skills.
export { PLUGIN };

// The assistant's own skills, not tied to one tool, and the order of the owner's list are the assistant preset's (assistants/<name>/preset.json "skills").
// All private: they read or write the owner's mail, calendar, Notion, brief and setup.
const CORE_SKILLS: readonly ModuleSkill[] = preset().skills.core;

// The order the owner's list has always had (the default-prompts snapshot pins it); a skill not named here goes last.
const ORDER = preset().skills.order;
const rank = (s: ModuleSkill) => (ORDER.includes(s.name) ? ORDER.indexOf(s.name) : ORDER.length);
const inOrder = (skills: readonly ModuleSkill[]): ModuleSkill[] => skills.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s);

const skillsOf = (modules: readonly ToolModule[]): ModuleSkill[] => inOrder([...CORE_SKILLS, ...modules.flatMap((m) => m.skills ?? [])]);
const withPlugin = (name: string) => `${PLUGIN}:${name}`;

// Every skill that may be shared with a group or a tenant, with the capabilities it needs; every module in the code counts, loaded or not.
export const sharedSkills = (): Readonly<Record<string, readonly Capability[]>> => Object.fromEntries(skillsOf(registered()).flatMap((s) => (s.shared ? [[s.name, s.shared] as const] : [])));

// Never offered to a group or a tenant, whatever capability she holds: they read or write the owner's mail, calendar, Notion, brief and setup.
export const privateSkills = (): string[] => skillsOf(registered()).filter((s) => !s.shared).map((s) => s.name);

// The skills of a run with these capabilities: the shared ones of the loaded modules whose capabilities the set holds.
export const skillsFor = (caps: ReadonlySet<Capability>): string[] => skillsOf(loaded()).filter((s) => s.shared?.every((c) => caps.has(c))).map((s) => withPlugin(s.name));

// The owner's: the whole plugin as far as the loaded modules go. `mail`: false offers no mail skill, as if there were no mail provider. `required`: only the
// skills the doctor checks are there.
export function ownerSkills(mail: boolean = settings.mail, provider: string = settings.mailProvider, o: { required?: boolean } = {}): string[] {
  return skillsOf(loaded(mail ? provider : "none"))
    .filter((s) => (!s.when || s.when()) && (!o.required || s.required))
    .map((s) => (o.required ? s.name : withPlugin(s.name)));
}

// ---- hints in a skill's frontmatter (plugin/skills/<name>/SKILL.md) ----
// `delegate: sonnet|opus`: a heavy skill. The owner's heartbeat run (a cheap model) never runs it itself: it hands it to an expert subagent on that model
// (heartbeat/delegation.ts). Absent: a light skill, the run does it itself.
// `tools: [mcp__calendar__*, mcp__send__send, Skill]`: optional, the lean tool set of that skill's expert (tool names as the SDK writes them; `mcp__server__*` is every
// tool of a server). Absent: the expert has the run's whole tool set.
export interface SkillHint {
  readonly delegate?: "sonnet" | "opus";
  readonly tools?: readonly string[];
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*(\*|__\*)?$/;

// Pure: the hints in one SKILL.md's text. A typo fails loudly (a skill file is code): an unknown model or a malformed tool name throws.
export function parseHint(text: string, where = "skill"): SkillHint {
  const front = FRONT.exec(text)?.[1] ?? "";
  const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(front)?.[1]?.trim();
  const delegate = field("delegate");
  if (delegate !== undefined && delegate !== "sonnet" && delegate !== "opus") throw new Error(`${where}: delegate must be sonnet or opus (got "${delegate}")`);
  const rawTools = field("tools");
  const tools = rawTools === undefined ? undefined : rawTools.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
  for (const t of tools ?? []) if (!TOOL_NAME.test(t)) throw new Error(`${where}: tools has "${t}", which is not a tool name`);
  return { ...(delegate ? { delegate } : {}), ...(tools?.length ? { tools } : {}) };
}

// The hints of a bundled skill (by its plain name, without the plugin prefix); none when it has no file or declares nothing.
export function skillHint(name: string, dir: string = settings.pluginDir): SkillHint {
  const file = join(dir, "skills", name, "SKILL.md");
  return existsSync(file) ? parseHint(readFileSync(file, "utf8"), `skills/${name}/SKILL.md`) : {};
}
