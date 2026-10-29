import type { AgentDefinition, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { type Source } from "../core/audit.ts";
import { emitRecord } from "../core/events.ts";
import { PLUGIN, preset } from "../core/preset.ts";
import { settings } from "../core/settings.ts";
import { skillHint, type SkillHint } from "../modules/skills.ts";

// Delegation, in EVERY run (a chat turn of the owner, a group or a friend, and a look alike): the run decides, a stronger model (an SDK subagent, the "expert") does the heavy work.
//   * Two general experts, the caller picks by agent type: `expert` (Sonnet, preset.json "expert") and `expert-opus` (OPUS_MODEL). Both have the preset's turn limit, persona/expert.md for
//     their words, and the run's whole tool set (a subagent with no `tools` inherits its parent's, and cannot call Agent itself). Every call it makes passes the same canUseTool as the run's own (floor, judge, phone) with
//     the same provenance and the same untrusted taint.
//   * A skill's frontmatter says `delegate: sonnet|opus` (a heavy skill: that is the model of its variant, Sonnet by default) and optionally `tools: [...]` (a lean tool set): such a skill gets a variant
//     `expert-<skill>` with the skill preloaded, on that model and with that tool set. The run itself may not load a `delegate:` skill (the Skill hook below).
//   * The hooks below are what ENFORCES it. The Agent call itself never reaches canUseTool, so a PreToolUse hook is the only place to refuse `general-purpose`, to
//     cap the number of delegations and to keep the depth at one.
//   * An expert always runs in the FOREGROUND: the SDK starts an Agent call in the background unless it says `run_in_background: false`, and a run ends at its
//     first result (agentrun.ts consume), which kills a background subagent mid-work (the daily brief of 22 Oct: the look ended "silent" seconds after it
//     delegated, the brief was never written). So the hook rewrites every accepted call to `run_in_background: false` (updatedInput), each agent is declared
//     `background: false`, and background tasks are off for every run (agentrun.ts env). The run then waits for its expert (a chat turn too: the reply comes after, typing keeps showing), bounded by the run's ceiling (RUN_MAX_MINUTES_CHAT) and budget (maxBudgetUsd covers subagents).

const EXPERT = "expert";
const OPUS_EXPERT = `${EXPERT}-opus`;
export const MAX_DELEGATIONS = 2; // per run
const AGENT_TOOLS = new Set(["Agent", "Task"]); // (the tool was called Task before the SDK renamed it)

const variantOf = (skill: string): string => `${EXPERT}-${skill}`;

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
  const general = { prompt, maxTurns: expert.maxTurns, background: false /* (see above: a background expert dies with the run) */, disallowedTools: ["Agent"] };
  const agents: Record<string, AgentDefinition> = {
    [EXPERT]: { ...general, model: expert.model, description: "A stronger model (Sonnet) for work that needs judgement: careful writing, research, many steps, reading a lot. Give it a self-contained brief; it delivers the result itself." },
    [OPUS_EXPERT]: { ...general, model: settings.opusModel, description: "The strongest model (Opus), only for hard reasoning or high-stakes writing; slower and dearer than expert. Give it a self-contained brief; it delivers the result itself." },
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
      model: hint.delegate === "opus" ? settings.opusModel : expert.model,
      maxTurns: expert.maxTurns,
      skills: [`${PLUGIN}:${name}`],
      ...(hint.tools ? { tools: [...hint.tools] } : {}),
      background: false,
      disallowedTools: ["Agent"],
    };
    if (hint.delegate) delegated.set(name, agent);
  }
  return { agents, delegated };
}

// What the heartbeat instruction says about the heavy skills: "<skill> (agent <name>)", or "" when there are none.
export const delegatedText = (setup: ExpertSetup): string => [...setup.delegated].map(([skill, agent]) => `${PLUGIN}:${skill} (subagent_type "${agent}")`).join(", ");

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
// The accepted Agent call as it must run: in the foreground (the run waits for it), never in a remote or other isolated place (a remote agent always runs in the background).
function foreground(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args, run_in_background: false };
  delete out.isolation;
  delete out.model; // (the agent type picks the model: expert or expert-opus, never a per-call override)
  return out;
}
const allowForeground = (args: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, updatedInput: foreground(args) } });

export interface Delegation {
  agent: string;
  brief: string; // the text the run wrote for the expert: its words, possibly steered by a mail it read
}

// The PreToolUse hook of a run (every run has experts). Called for every tool (the SDK's `matcher` is left out on purpose: it also learns the type of each subagent here).
//   Agent / Task   from the main run only (a subagent carries an `agent_id`), only `expert` or a variant of this run, at most MAX_DELEGATIONS; its brief is kept
//                  (`briefs`) for the approval judge, which reads it as derived data next to the run's provenance; it always runs in the foreground (foreground())
//   Skill          a `delegate:` skill is denied to the main run: it must go through its expert; the expert may load it
export function delegationHook(setup: ExpertSetup, source: Source, o: { max?: number; onDelegate?: (d: Delegation) => void; context?: () => string | undefined } = {}) {
  const max = o.max ?? MAX_DELEGATIONS;
  const delegations: Delegation[] = [];
  const types = new Map<string, string>(); // subagent id -> its agent type (the audit log gets it, permissions.ts)
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.agent_id && input.agent_type) types.set(input.agent_id, input.agent_type);
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    if (AGENT_TOOLS.has(input.tool_name)) {
      const agent = typeof args.subagent_type === "string" ? args.subagent_type : "";
      const refuse = (why: string, reason: string) => (emitRecord(input.tool_name, `deny-${why}`, source, { agent_type: agent || undefined }), deny(reason));
      if (input.agent_id) return refuse("nested", "An expert cannot delegate further: do the work yourself with your tools.");
      if (!Object.hasOwn(setup.agents, agent)) return refuse("agent", `Only ${Object.keys(setup.agents).map((a) => `"${a}"`).join(", ")} may be called (subagent_type); other agents do not exist here. Use one of them, or do the work yourself.`);
      if (delegations.length >= max) return refuse("cap", `You already delegated ${max} times in this run, the most there is. Do the rest yourself.`);
      const brief = typeof args.prompt === "string" ? args.prompt : "";
      const d = { agent, brief };
      delegations.push(d);
      emitRecord(input.tool_name, "delegate", source, { agent_type: agent, n: delegations.length, briefChars: brief.length, ...(args.run_in_background !== false ? { foreground: "forced" } : {}) });
      o.onDelegate?.(d);
      const context = o.context?.(); // code adds the conversation's context (facts, recent chat) to what the expert is told: the judge still reads only the look's own brief
      return allowForeground(context ? { ...args, prompt: `${brief}\n\n${context}` } : args); // (the Agent call is not asked about by canUseTool: the checks above are the whole gate; what the expert does is judged call by call)
    }
    if (input.tool_name === "Skill" && !input.agent_id) {
      const skill = String(args.skill ?? args.name ?? "").replace(`${PLUGIN}:`, "");
      const agent = setup.delegated.get(skill);
      if (agent) return (emitRecord("Skill", "deny-delegated", source, { skill }), deny(`The skill ${skill} is heavy work and is delegated: call the Agent tool with subagent_type "${agent}" and a self-contained brief instead of loading it yourself.`));
    }
    return {};
  };
  return { hook, delegations, agentTypeOf: (id: string | undefined): string | undefined => (id ? types.get(id) : undefined) };
}
