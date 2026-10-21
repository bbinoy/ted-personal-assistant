import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegationHook, expertSetup } from "../src/run/delegation.ts";
import { lookInstruction } from "../src/heartbeat/look.ts";
import { announceMemoryChanges, noteWritten } from "../src/memory/memorynotice.ts";
import { registered } from "../src/modules/index.ts";
import { categoryOf, MAX_NOTE_CHARS, readNotes } from "../src/memory/notes.ts";
import { classify } from "../src/policy/policy.ts";
import { preset } from "../src/core/preset.ts";
import { dreamScope } from "../src/modules/memory/dreamscope.ts";
import { ownerSkills, skillHint } from "../src/modules/skills.ts";
import { writeStatusNote } from "../src/modules/status/statusnote.ts";

// The daily brief is a skill the heartbeat run delegates to its expert; its state is the status-brief note (no code schedules or tracks the brief).

const signal = new AbortController().signal;

test("the bundled daily-brief and meeting-prep skills are heavy: the heartbeat run may not load them, its experts exist for them", async () => {
  assert.equal(skillHint("daily-brief").delegate, "sonnet");
  assert.equal(skillHint("meeting-prep").delegate, "sonnet");
  assert.equal(skillHint("calendar").delegate, undefined, "light skills have no hint");
  const set = expertSetup(ownerSkills(), "P");
  assert.ok(set.agents["expert-daily-brief"] && set.agents["expert-meeting-prep"] && set.agents.expert);
  assert.deepEqual([...set.delegated.keys()].sort(), ["daily-brief", "meeting-prep"]);
  const h = delegationHook(set, "background");
  const call = (tool_input: Record<string, unknown>, who: object = {}) => h.hook({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input, tool_use_id: "t", ...who } as never, "t", { signal });
  const denied = (await call({ skill: "ted-personal-assistant:daily-brief" })) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await call({ skill: "ted-personal-assistant:daily-brief" }, { agent_id: "a", agent_type: "expert-daily-brief" }), {}, "its expert loads it");
  assert.deepEqual(await call({ skill: "ted-personal-assistant:meeting-prep" }, { agent_id: "a", agent_type: "expert-daily-brief" }), {}, "and the sub-skill meeting-prep");
});

test("the heartbeat instruction carries the brief rules: usual time, overdue hour, the status-brief note, how to deliver", () => {
  const text = lookInstruction(new Date(2026, 9, 14, 8, 0), undefined);
  assert.match(text, /usual time is 07:30/);
  assert.match(text, /From 09:00 on it is overdue/);
  assert.match(text, /status-brief/);
  assert.match(text, /expert-daily-brief/);
  assert.match(text, /These skills are heavy: never load them yourself[^.]*ted-personal-assistant:daily-brief \(subagent_type "expert-daily-brief"\), ted-personal-assistant:meeting-prep/);
  assert.match(text, /send_self_briefing/);
});

test("the status note: written by the one narrow tool, status-<name>.md only, one note's worth, expiring tomorrow; the dream and the memory notices leave it alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  const now = new Date(2026, 9, 14, 9, 0);
  assert.deepEqual(writeStatusNote("brief", "2026-10-14\nstatus: started", now, dir), { ok: true, file: "status-brief.md" });
  assert.match(readFileSync(join(dir, "status-brief.md"), "utf8"), /^---\nexpires: 2026-10-15\nwritten: 2026-10-14T[\d:.]+Z\nattempts: 1\n---\n2026-10-14\nstatus: started\n$/);
  assert.equal(categoryOf("status-brief.md"), "status");
  assert.deepEqual(readNotes(now, dir).map((n) => [n.file, n.category, n.text]), [["status-brief.md", "status", "2026-10-14\nstatus: started"]]);
  assert.deepEqual(readNotes(new Date(2026, 9, 16, 9, 0), dir), [], "expired after tomorrow");
  // replaced by name
  writeStatusNote("brief", "2026-10-14\nstatus: delivered", now, dir);
  assert.equal(readdirSync(dir).length, 1);
  // refused: a path, a bad name, empty, too long. Nothing else is written.
  for (const name of ["../x", "Brief", "a/b", "", "x".repeat(41), "-x"]) assert.equal(writeStatusNote(name, "t", now, dir).ok, false, name);
  assert.equal(writeStatusNote("brief", "   ", now, dir).ok, false);
  const long = writeStatusNote("brief", "x".repeat(MAX_NOTE_CHARS + 1), now, dir);
  assert.ok(!long.ok && /too long/.test(long.error));
  assert.deepEqual(readdirSync(dir), ["status-brief.md"]);
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
  const c = (o: object) => ({ source: "background", browsing: false, mode: "owner", offers: () => true, browseRun: async () => ({}), ...o }) as never;
  const when = (o: object) => mod.connection.kind === "in-process" && mod.connection.when(c(o));
  assert.equal(when({}), true);
  assert.equal(when({ source: "chat", key: "owner" }), false);
  assert.equal(when({ source: "group", key: "g" }), false);
  assert.equal(when({ tenant: {} }), false);
  assert.equal(classify("mcp__status__write_status_note", { name: "brief", text: "t" }, "background"), "allow");
  for (const source of ["chat", "group", "handler"] as const) assert.equal(classify("mcp__status__write_status_note", { name: "brief", text: "t" }, source), "deny", source);
});
