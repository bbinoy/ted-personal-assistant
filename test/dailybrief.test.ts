import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegationHook, expertSetup } from "../src/run/delegation.ts";
import { lookInstruction } from "../src/heartbeat/look.ts";
import { chatSystem } from "../src/run/persona.ts";
import { announceMemoryChanges, noteWritten } from "../src/memory/memorynotice.ts";
import { categoryOf, indexOf, NOTES_DIR, readNotes } from "../src/memory/notes.ts";
import { journalable } from "../src/approvals/journalrender.ts";
import { settings } from "../src/core/settings.ts";
import { classify } from "../src/policy/policy.ts";
import { preset } from "../src/core/preset.ts";
import { dreamScope } from "../src/modules/memory/dreamscope.ts";
import { ownerSkills, skillHint } from "../src/modules/skills.ts";
import { OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";
import { capabilitiesOf, toolsFor } from "../src/policy/capabilities.ts";

// The daily brief is a skill the heartbeat run delegates to its expert; code schedules and records it like the other routines (routine_runs); the status-brief note is only its content for the next brief.

const signal = new AbortController().signal;

test("the bundled daily-brief and meeting-prep skills are heavy: the heartbeat run may not load them, its experts exist for them", async () => {
  assert.equal(skillHint("daily-brief").delegate, "sonnet");
  assert.equal(skillHint("meeting-prep").delegate, "sonnet");
  assert.equal(skillHint("calendar").delegate, undefined, "light skills have no hint");
  const set = expertSetup(ownerSkills(), "P");
  assert.ok(set.agents["expert-daily-brief"] && set.agents["expert-meeting-prep"] && set.agents.expert);
  assert.deepEqual([...set.delegated.keys()].sort(), ["daily-brief", "evening-wrap", "meeting-prep", "weekly-review"]);
  const h = delegationHook(set, "background");
  const call = (tool_input: Record<string, unknown>, who: object = {}) => h.hook({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input, tool_use_id: "t", ...who } as never, "t", { signal });
  const denied = (await call({ skill: "ted-personal-assistant:daily-brief" })) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await call({ skill: "ted-personal-assistant:daily-brief" }, { agent_id: "a", agent_type: "expert-daily-brief" }), {}, "its expert loads it");
  assert.deepEqual(await call({ skill: "ted-personal-assistant:meeting-prep" }, { agent_id: "a", agent_type: "expert-daily-brief" }), {}, "and the sub-skill meeting-prep");
});

test("the prompt names the heavy skills and the routines; the routine fact (time, state, how to deliver) is code's line in the check's message", () => {
  const prompt = chatSystem(new Date(2026, 9, 14, 8, 0));
  assert.match(prompt, /These skills are heavy: never load them yourself[^.]*ted-personal-assistant:daily-brief \(subagent_type "expert-daily-brief"\), ted-personal-assistant:meeting-prep/);
  assert.match(prompt, /Routines are things that happen at a set time/);
  const text = lookInstruction(new Date(2026, 9, 14, 8, 0), undefined);
  assert.doesNotMatch(text + prompt, /status-brief|overdue/, "no brief timing or state in the words: the routine line carries it");
  assert.match(lookInstruction(new Date(2026, 9, 14, 8, 0), undefined, undefined, "daily-brief: due now (every day at 07:30)."), /daily-brief: due now \(every day at 07:30\)\./);
});

test("the status notes are ordinary notes the skills write with Write: expiring, outside the index, the dream and the notices, and not in the journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  const now = new Date(2026, 9, 14, 9, 0);
  // what the daily-brief skill writes (and what the owner's older, code-stamped note looks like: the same shape)
  writeFileSync(join(dir, "status-brief.md"), "---\nexpires: 2026-10-15\nwritten: 2026-10-14T09:00:00\n---\n2026-10-14\nHeadlines\n");
  writeFileSync(join(dir, "status-overdue-offer.md"), "---\nexpires: 2026-11-13\n---\n2026-10-14 clean-up offered\n");
  writeFileSync(join(dir, "people-anna.md"), "---\ndescription: Anna\n---\nAnna lives in Lisbon\n");
  assert.equal(categoryOf("status-brief.md"), "status");
  assert.deepEqual(readNotes(now, dir).map((n) => n.file).sort(), ["people-anna.md", "status-brief.md", "status-overdue-offer.md"]);
  assert.deepEqual(readNotes(new Date(2026, 9, 16, 9, 0), dir).map((n) => n.file).sort(), ["people-anna.md", "status-overdue-offer.md"], "the brief's note expires after tomorrow, the offer's after 30 days");
  assert.doesNotMatch(indexOf(readNotes(now, dir)), /status-/, "not in MEMORY.md");
  assert.ok(preset().notes.categories.includes("status") && !preset().notes.dream.includes("status"));
  assert.ok(!dreamScope({ kind: "owner" }).categories.includes("status"));
  const shown: string[] = [];
  noteWritten("Write", { file_path: join(dir, "status-brief.md"), content: "x" });
  announceMemoryChanges(async (t) => void shown.push(t), "");
  assert.deepEqual(shown, [], "a status note is not the owner's memory: no notice");
  assert.equal(journalable("Write", { file_path: join(dir, "status-brief.md") }), false, "plumbing, not an action");
  assert.equal(journalable("Write", { file_path: join(dir, "people-anna.md") }), true, "any other note write is");
  // the tool is gone; the owner's look and a chat turn write the note with Write
  assert.equal(toolsFor(capabilitiesOf({ kind: "owner" }), OWNER_LOOK).has("mcp__status__write_status_note"), false);
  const path = join(NOTES_DIR, "status-brief.md");
  for (const run of [OWNER_LOOK, OWNER_CHAT]) assert.equal(classify("Write", { file_path: path, content: "x" }, run), "allow", run.who);
});

test("the daily-brief skill writes status-brief.md and status-overdue-offer.md itself, with an expiry; no tool, no state", () => {
  const skill = readFileSync(join(settings.pluginDir, "skills", "daily-brief", "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /write_status_note/);
  assert.match(skill, /`status-brief\.md`[^\n]*written with `Write`/);
  assert.match(skill, /expires: <tomorrow, YYYY-MM-DD>/);
  assert.match(skill, /status-overdue-offer\.md` with `Write` \(front matter `expires:` 30 days/);
});
