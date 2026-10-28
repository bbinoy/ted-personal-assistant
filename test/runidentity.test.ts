import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { BROWSE_RUN, FRIEND_CHAT, FRIEND_LOOK, GROUP_CHAT, GROUP_LOOK, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

// Characterisation: what each kind of run (owner attended or not, a group, a friend, the browse worker) has and is allowed, pinned in test/fixtures/run-identity.json: its built
// options (built-in tools, skills, isolation, MCP servers) and the verdict of classify for every manifest tool and for the note and data paths, with and without the run's tool set.
// A refactor of how a run's identity is derived (capabilities, not "owner or isolated") must leave the fixture untouched. Regenerate on purpose: SNAPSHOT_WRITE=1 npm test.
process.env.INTAKE_BASE_URL = "";
const { classify } = await import("../src/policy/policy.ts");
const { buildOptions } = await import("../src/run/agentrun.ts");
const { allRows } = await import("../src/policy/toolmanifest.ts");
const { NOTES_DIR } = await import("../src/memory/notes.ts");
const { convPaths, OWNER_CONV, conversationsDir } = await import("../src/core/convpaths.ts");
const { capabilitiesOf, toolsFor, browseTools } = await import("../src/policy/capabilities.ts");

const FIXTURE = join(import.meta.dirname, "fixtures", "run-identity.json");
const KINDS = { OWNER_CHAT, OWNER_LOOK, GROUP_CHAT, GROUP_LOOK, FRIEND_CHAT, FRIEND_LOOK, BROWSE_RUN };
const GROUP_NOTES = "/nonexistent-group-notes";
const OTHER_NOTES = "/nonexistent-other-notes";

const toolNames = [...new Set([...allRows().map((r) => r.tool), "Bash", "Agent", "mcp__unknown__thing", "mcp__browser__browser_navigate", "mcp__claude_ai_Notion__notion-search", "mcp__mailbird__get_message"])].sort();
const runnable = (kind: (typeof KINDS)[keyof typeof KINDS]) => (kind.who === "browse" ? browseTools() : toolsFor(capabilitiesOf({ kind: kind.who === "owner" ? "owner" : "group" }), kind));

function describeAll() {
  const otherData = join(conversationsDir(), "some-friend", "messages.jsonl");
  for (const f of [convPaths(OWNER_CONV).messages, otherData]) (mkdirSync(dirname(f), { recursive: true }), writeFileSync(f, "x")); // (real files: a data path is judged by its real path)
  const paths = { ownerNote: join(NOTES_DIR, "a.md"), ownerIndex: join(NOTES_DIR, "MEMORY.md"), ownerData: convPaths(OWNER_CONV).messages, otherData, groupNote: join(GROUP_NOTES, "a.md"), otherNote: join(OTHER_NOTES, "a.md"), outside: "/etc/hosts", none: undefined };
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(KINDS)) {
    const dir = kind.who === "owner" ? NOTES_DIR : GROUP_NOTES;
    const built = buildOptions(async () => ({ approved: false }), { kind, systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1, memory: { dir, zone: "UTC" } }, undefined);
    const verdicts = (tools: ReadonlySet<string> | undefined, notes: string | undefined) => {
      const v: Record<string, string> = {};
      for (const t of toolNames) v[t] = classify(t, t === "WebFetch" ? { url: "https://example.com/" } : {}, kind, notes, tools);
      for (const t of ["Read", "Write", "Edit"]) for (const [p, path] of Object.entries(paths)) v[`${t}:${p}`] = classify(t, { file_path: path, content: "x", old_string: "a", new_string: "b" }, kind, notes, tools);
      return v;
    };
    out[name] = {
      tools: built.tools, skills: built.skills, strict: built.strictMcpConfig ?? null, settingSources: built.settingSources, hidden: built.disallowedTools === undefined ? null : built.disallowedTools.length > 0,
      mcp: Object.keys(built.mcpServers ?? {}).sort(),
      bare: verdicts(undefined, undefined), bareDir: verdicts(undefined, dir), withTools: verdicts(runnable(kind), dir), withToolsNoDir: verdicts(runnable(kind), undefined),
    };
  }
  return JSON.parse(JSON.stringify(out));
}

test("run identity: tools, skills, isolation and verdicts of every kind of run are pinned", () => {
  const now = describeAll();
  if (process.env.SNAPSHOT_WRITE) return void writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  assert.ok(existsSync(FIXTURE), "test/fixtures/run-identity.json is missing: regenerate it on purpose with SNAPSHOT_WRITE=1 npm test");
  assert.deepEqual(now, JSON.parse(readFileSync(FIXTURE, "utf8")));
});
