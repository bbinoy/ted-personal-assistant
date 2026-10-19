// The words of the daily brief's preset that the mail modules (src/modules) and brief.ts share; a leaf (it reads only the assistant preset's skill name) so that both can read it.
import { wakeSkill } from "./preset.ts";

// The skill the daily brief follows (the preset's rhythm), as the model names it.
export const BRIEF_SKILL = wakeSkill("brief");

export const BRIEF_TOOL = "mcp__mailbird__send_self_briefing"; // the agent emails the brief with this (Mailbird; each mail module says what its provider's brief send is)
export const DONE_MARKER = "ROUTINE_COMPLETE";

// The brief preset's instructions (tasks.ts): the skill, and how a run ends. These are Mailbird's (the default mail provider); the Gmail module has its own.
export const BRIEF_INSTRUCTIONS = `Load the '${BRIEF_SKILL}' skill with the Skill tool and follow it exactly. After ${BRIEF_TOOL.split("__").pop()} succeeds, print the exact line ${DONE_MARKER}. If the mail tools are unreachable, send the brief anyway saying so, do the task and calendar parts if you can, and do NOT print ${DONE_MARKER}.`;

// Without mail (MAIL_PROVIDER=none) there is no tool to email the brief with: the run's final answer IS the brief, and the
// marker on its last line says it is whole. The skill still describes the mail steps, so this overrides them.
export const BRIEF_INSTRUCTIONS_NO_MAIL = `Load the '${BRIEF_SKILL}' skill with the Skill tool and follow it, with these changes because there is no email in this setup: skip the email pass (step 1) and the newsletter radar, never load a mail skill or call a mail tool, and do not deliver by email (step 6). Your final answer is the brief itself, in the skill's format (Markdown, the sections in its order), with nothing before it, and then one last line with the exact text ${DONE_MARKER}. If you cannot do the calendar, task and meeting parts at all, say so in the brief and do NOT print ${DONE_MARKER}.`;
