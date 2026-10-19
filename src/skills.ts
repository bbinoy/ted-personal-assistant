import { loaded, registered } from "./modules/index.ts";
import type { ModuleSkill, ToolModule } from "./modules/types.ts";
import { PLUGIN, preset } from "./preset.ts";
import { settings } from "./settings.ts";
import type { Capability } from "./tenants.ts";

// Which bundled skills (plugin/skills/) a conversation may load. A skill comes from a tool module (the calendar module brings `calendar`, a mail module its
// mail skill, weather `surf-conditions`, draw `draw`, browse `research-booking`) or is the assistant's own (CORE_SKILLS: the brief, the radar, setup...).
// The owner loads the whole plugin (offeredSkills, profiles.ts); a group or a tenant loads only the shared skills whose capabilities its set holds (skillsFor),
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
