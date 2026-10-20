import type { AgentDefinition, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "../core/audit.ts";
import { PLUGIN, preset } from "../core/preset.ts";
import { skillHint, type SkillHint } from "../modules/skills.ts";

// Delegation in the owner's heartbeat run: a cheap model decides, a stronger one (an SDK subagent, the "expert") does the heavy work.
//   * ONE general expert, `expert`: the preset's model and turn limit (preset.json "expert"), persona/expert.md for its words, and the run's whole tool set (a subagent
//     with no `tools` inherits its parent's, and cannot call Agent itself). Every call it makes passes the same canUseTool as the run's own (floor, judge, phone) with
//     the same provenance and the same untrusted taint.
//   * A skill's frontmatter says `delegate: sonnet|opus` (a heavy skill) and optionally `tools: [...]` (a lean tool set): such a skill gets a variant
//     `expert-<skill>` with the skill preloaded, on that model and with that tool set. The run itself may not load a `delegate:` skill (the Skill hook below).
//   * The hooks below are what ENFORCES it. The Agent call itself never reaches canUseTool, so a PreToolUse hook is the only place to refuse `general-purpose`, to
//     cap the number of delegations and to keep the depth at one.

export const EXPERT = "expert";
export const MAX_DELEGATIONS = 2; // per look
const AGENT_TOOLS = new Set(["Agent", "Task"]); // (the tool was called Task before the SDK renamed it)

export const variantOf = (skill: string): string => `${EXPERT}-${skill}`;

// A skill that has a variant: it is heavy (`delegate`) or has a lean tool set (`tools`).
const hasVariant = (h: SkillHint): boolean => !!h.delegate || !!h.tools;

export interface ExpertSetup {
  agents: Record<string, AgentDefinition>; // for the SDK's `agents` option
  delegated: ReadonlyMap<string, string>; // skill (plain name) -> the agent that runs it: the skills the run itself may not load
}

// Pure but for the skill files it reads: the experts of a run with these skills (plugin-qualified names, as profiles.ts holds them). `prompt`: the expert's whole system
// text (persona.ts expertSystem). `hints`: tests.
export function expertSetup(skills: readonly string[], prompt: string, hints: (name: string) => SkillHint = skillHint): ExpertSetup {
  const { expert } = preset();
  const agents: Record<string, AgentDefinition> = {
    [EXPERT]: {
      description: "A stronger model for heavy work: careful writing, research, many steps or deep reasoning. Give it a self-contained brief; it delivers the result itself.",
      prompt,
      model: expert.model,
      maxTurns: expert.maxTurns,
      disallowedTools: ["Agent"],
    },
  };
  const delegated = new Map<string, string>();
  for (const q of skills) {
    const name = q.startsWith(`${PLUGIN}:`) ? q.slice(PLUGIN.length + 1) : q;
    const hint = hints(name);
    if (!hasVariant(hint)) continue;
    const agent = variantOf(name);
    agents[agent] = {
      description: `The expert for the ${name} skill: it has the skill loaded and only the tools it needs. Give it a self-contained brief.`,
      prompt: `${prompt}\n\nYour brief is for the skill ${PLUGIN}:${name}: load it and follow it.`,
      model: hint.delegate ?? expert.model,
      maxTurns: expert.maxTurns,
      skills: [`${PLUGIN}:${name}`],
      ...(hint.tools ? { tools: [...hint.tools] } : {}),
      disallowedTools: ["Agent"],
    };
    if (hint.delegate) delegated.set(name, agent);
  }
  return { agents, delegated };
}

// What the heartbeat instruction says about the heavy skills: "<skill> (agent <name>)", or "" when there are none.
export const delegatedText = (setup: ExpertSetup): string => [...setup.delegated].map(([skill, agent]) => `${PLUGIN}:${skill} (subagent_type "${agent}")`).join(", ");

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
const allow = { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } };

export interface Delegation {
  agent: string;
  brief: string; // the text the run wrote for the expert: its words, possibly steered by a mail it read
}

// The PreToolUse hook of a run with experts. Called for every tool (the SDK's `matcher` is left out on purpose: it also learns the type of each subagent here).
//   Agent / Task   from the main run only (a subagent carries an `agent_id`), only `expert` or a variant of this run, at most MAX_DELEGATIONS; its brief is kept
//                  (`briefs`) for the approval judge, which reads it as derived data next to the run's provenance
//   Skill          a `delegate:` skill is denied to the main run: it must go through its expert; the expert may load it
export function delegationHook(setup: ExpertSetup, source: Source, o: { max?: number; onDelegate?: (d: Delegation) => void } = {}) {
  const max = o.max ?? MAX_DELEGATIONS;
  const delegations: Delegation[] = [];
  const types = new Map<string, string>(); // subagent id -> its agent type (the audit log gets it, permissions.ts)
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.agent_id && input.agent_type) types.set(input.agent_id, input.agent_type);
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    if (AGENT_TOOLS.has(input.tool_name)) {
      const agent = typeof args.subagent_type === "string" ? args.subagent_type : "";
      const refuse = (why: string, reason: string) => (audit(input.tool_name, `deny-${why}`, source, { agent_type: agent || undefined }), deny(reason));
      if (input.agent_id) return refuse("nested", "An expert cannot delegate further: do the work yourself with your tools.");
      if (!Object.hasOwn(setup.agents, agent)) return refuse("agent", `Only ${Object.keys(setup.agents).map((a) => `"${a}"`).join(", ")} may be called (subagent_type); other agents do not exist here. Use one of them, or do the work yourself.`);
      if (delegations.length >= max) return refuse("cap", `You already delegated ${max} times in this look, the most there is. Do the rest yourself or leave it for the next look.`);
      const brief = typeof args.prompt === "string" ? args.prompt : "";
      const d = { agent, brief };
      delegations.push(d);
      audit(input.tool_name, "delegate", source, { agent_type: agent, n: delegations.length, briefChars: brief.length });
      o.onDelegate?.(d);
      return allow; // (the Agent call is not asked about by canUseTool: the checks above are the whole gate; what the expert does is judged call by call)
    }
    if (input.tool_name === "Skill" && !input.agent_id) {
      const skill = String(args.skill ?? args.name ?? "").replace(`${PLUGIN}:`, "");
      const agent = setup.delegated.get(skill);
      if (agent) return (audit("Skill", "deny-delegated", source, { skill }), deny(`The skill ${skill} is heavy work and is delegated: call the Agent tool with subagent_type "${agent}" and a self-contained brief instead of loading it yourself.`));
    }
    return {};
  };
  return { hook, delegations, agentTypeOf: (id: string | undefined): string | undefined => (id ? types.get(id) : undefined) };
}
