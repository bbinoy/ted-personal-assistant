import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegationHook, expertSetup } from "../src/run/delegation.ts";
import { lookInstruction } from "../src/heartbeat/look.ts";
import { chatSystem } from "../src/run/persona.ts";
import { announceMemoryChanges, noteWritten } from "../src/memory/memorynotice.ts";
import { registered } from "../src/modules/index.ts";
import { categoryOf, MAX_STATUS_CHARS, readNotes } from "../src/memory/notes.ts";
import { classify } from "../src/policy/policy.ts";
import { preset } from "../src/core/preset.ts";
import { dreamScope } from "../src/modules/memory/dreamscope.ts";
import { ownerSkills, skillHint } from "../src/modules/skills.ts";
import { writeStatusNote } from "../src/modules/status/statusnote.ts";
import { GROUP_CHAT, GROUP_LOOK, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";
import { capabilitiesOf, groupCapabilities, toolsFor } from "../src/policy/capabilities.ts";

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

test("the status note: written by the one narrow tool, status-<name>.md only, one note's worth, expiring tomorrow; the dream and the memory notices leave it alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  const now = new Date(2026, 9, 14, 9, 0);
  assert.deepEqual(writeStatusNote("brief", "2026-10-14\nstatus: started", now, dir), { ok: true, file: "status-brief.md" });
  assert.match(readFileSync(join(dir, "status-brief.md"), "utf8"), /^---\nexpires: 2026-10-15\nwritten: 2026-10-14T[\d:.]+Z\n---\n2026-10-14\nstatus: started\n$/);
  assert.equal(categoryOf("status-brief.md"), "status");
  assert.deepEqual(readNotes(now, dir).map((n) => [n.file, n.category, n.text]), [["status-brief.md", "status", "2026-10-14\nstatus: started"]]);
  assert.deepEqual(readNotes(new Date(2026, 9, 16, 9, 0), dir), [], "expired after tomorrow");
  // replaced by name
  writeStatusNote("brief", "2026-10-14\nstatus: delivered", now, dir);
  assert.equal(readdirSync(dir).length, 1);
  // refused: a path, a bad name, empty, too long. Nothing else is written.
  for (const name of ["../x", "Brief", "a/b", "", "x".repeat(41), "-x"]) assert.equal(writeStatusNote(name, "t", now, dir).ok, false, name);
  assert.equal(writeStatusNote("brief", "   ", now, dir).ok, false);
  const long = writeStatusNote("brief", "x".repeat(MAX_STATUS_CHARS + 1), now, dir);
  assert.ok(!long.ok && /too long/.test(long.error));
  assert.deepEqual(readdirSync(dir), ["status-brief.md"]);
  // `days`: a record that outlasts the day (the clean-up offer), bounded 1 to 30, the narrow name and the length cap unchanged
  assert.deepEqual(writeStatusNote("overdue-offer", "2026-10-14\noffered", now, dir, 30), { ok: true, file: "status-overdue-offer.md" });
  assert.match(readFileSync(join(dir, "status-overdue-offer.md"), "utf8"), /^---\nexpires: 2026-11-13\n/);
  for (const days of [0, 31, 1.5, -1, NaN]) assert.equal(writeStatusNote("overdue-offer", "x", now, dir, days).ok, false, String(days));
  assert.equal(writeStatusNote("x/y", "x", now, dir, 30).ok, false);
  assert.equal(writeStatusNote("overdue-offer", "x".repeat(MAX_STATUS_CHARS + 1), now, dir, 30).ok, false);
  rmSync(join(dir, "status-overdue-offer.md"));
  // protected from the dream (its categories), and never announced as a memory change
  assert.ok(preset().notes.categories.includes("status") && !preset().notes.dream.includes("status"));
  assert.ok(!dreamScope({ kind: "owner" }).categories.includes("status"));
  const shown: string[] = [];
  noteWritten("Write", { file_path: join(dir, "status-brief.md"), content: "x" });
  announceMemoryChanges(async (t) => void shown.push(t), "");
  assert.deepEqual(shown, [], "a status note is not the owner's memory: no notice");
});

test("the status tool: only an unattended owner run has it, and it is free for them; chat, groups and friends do not", () => {
  const mod = registered().find((m) => m.name === "status")!;
  const TOOL = "mcp__status__write_status_note";
  const offers = (caps: ReadonlySet<never>, run: typeof OWNER_LOOK) => { const tools = toolsFor(caps, run); return (t: string) => tools.has(t); };
  const c = (o: object) => ({ kind: OWNER_LOOK, browsing: false, mode: "owner", key: "owner", offers: offers(capabilitiesOf({ kind: "owner" }) as never, OWNER_LOOK), browseRun: async () => ({}), ...o }) as never;
  const when = (o: object) => mod.connection.kind === "in-process" && mod.connection.when(c(o));
  assert.equal(when({}), true);
  assert.equal(when({ kind: OWNER_CHAT, offers: offers(capabilitiesOf({ kind: "owner" }) as never, OWNER_CHAT) }), false, "not in her chat");
  assert.equal(when({ kind: GROUP_LOOK, key: "g", offers: offers(groupCapabilities() as never, GROUP_LOOK) }), false);
  assert.equal(classify(TOOL, { name: "brief", text: "t" }, OWNER_LOOK), "allow");
  for (const run of [OWNER_CHAT, GROUP_CHAT, GROUP_LOOK]) assert.equal(classify(TOOL, { name: "brief", text: "t" }, run), "deny", run.who);
});
