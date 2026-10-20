import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { profileOptions } from "../src/agent.ts";
import { buildOptions } from "../src/agentrun.ts";
import { hiddenOutside } from "../src/profiletools.ts";
import { PROFILES, RADAR_SKILLS } from "../src/profiles.ts";
import { allRows } from "../src/policy/toolmanifest.ts";

const SKILL = readFileSync(new URL("../plugin/skills/radar/SKILL.md", import.meta.url), "utf8");
const CAL = "mcp__claude_ai_Google_Calendar__";
const NOTION = "mcp__claude_ai_Notion__";

test("radar: it keeps what its skill uses (calendar reads, Notion reads and the prep page) and nothing of the mail client, drawing, weather, voice or browsing", () => {
  const tools = PROFILES.radar.mcpTools!;
  for (const t of ["list_events", "list_calendars", "get_event"]) assert.ok(tools.has(CAL + t), t);
  for (const t of ["notion-fetch", "notion-search", "notion-create-pages"]) assert.ok(tools.has(NOTION + t), t);
  for (const t of tools) assert.ok(/^mcp__claude_ai_(Google_Calendar|Notion)__/.test(t), `unexpected tool ${t}`);
  for (const t of [CAL + "create_event", CAL + "update_event", CAL + "delete_event", CAL + "respond_to_event"]) assert.ok(!tools.has(t), t);
});

test("radar: every tool and skill its skill names is in the allowlists", () => {
  const tools = PROFILES.radar.mcpTools!;
  const short = new Map(allRows().filter((r) => r.tool.startsWith("mcp__")).map((r) => [r.tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ""), r.tool] as const));
  const named = [...SKILL.matchAll(/`([a-z][a-z_-]+)`/g)].map((m) => m[1]!).filter((n) => short.has(n));
  assert.ok(named.includes("list_events"), "the skill names list_events");
  for (const n of named) assert.ok(tools.has(short.get(n)!), `${n} is named by the radar skill`);
  const skills = [...SKILL.matchAll(/ted-personal-assistant:([a-z-]+)/g)].map((m) => m[1]!);
  assert.ok(skills.length > 0);
  for (const s of skills) assert.ok((RADAR_SKILLS as readonly string[]).includes(s), `${s} is named by the radar skill`);
  assert.deepEqual(PROFILES.radar.skills.map((s) => s.split(":")[1]).sort(), [...RADAR_SKILLS].sort());
});

test("radar: its run options hide the mail client whole, the calendar writes and any other connector tool, and offer no draw, weather or voice skill", () => {
  const run = profileOptions("radar");
  const o = buildOptions(async () => ({ approved: false }) as never, run, undefined);
  const off = o.disallowedTools ?? [];
  assert.ok(off.includes("mcp__mailbird"), "the mail client is out of view whole");
  assert.ok(off.includes(CAL + "create_event") && off.includes(CAL + "delete_event"));
  assert.ok(!off.includes(CAL + "list_events") && !off.includes(NOTION + "notion-fetch"));
  assert.ok(off.includes(NOTION + "notion-update-data-source"), "the rest of Notion stays hidden");
  assert.ok(!([o.skills].flat() as string[]).some((s) => /draw|surf-conditions|mailbird|gmail/.test(s)));
  assert.ok(!o.mcpServers || !Object.keys(o.mcpServers).some((k) => /^(send|voice|draw|weather|browse)$/.test(k)), "no server of the chat's extras");
  // the other unattended runs keep the owner's whole set
  const brief = buildOptions(async () => ({ approved: false }) as never, profileOptions("brief"), undefined);
  assert.ok(!(brief.disallowedTools ?? []).includes(CAL + "create_event"));
});

test("hiddenOutside: a connector without an allowed tool is hidden whole; a tool seen later is hidden by name", () => {
  const off = hiddenOutside(new Set([CAL + "list_events"]), [CAL + "brand_new", "Skill"]);
  assert.ok(off.includes("mcp__claude_ai_Notion") && off.includes("mcp__mailbird"));
  assert.ok(off.includes(CAL + "brand_new") && off.includes(CAL + "create_event"));
  assert.ok(!off.includes(CAL + "list_events") && !off.includes("Skill") && !off.includes("mcp__claude_ai_Google_Calendar"));
});
