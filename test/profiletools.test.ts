import { test } from "node:test";
import assert from "node:assert/strict";
import { profileOptions } from "../src/agent.ts";
import { buildOptions } from "../src/agentrun.ts";
import { hiddenOutside, toolsFor } from "../src/profiletools.ts";
import { PROFILES } from "../src/profiles.ts";
import { classify } from "../src/policy/policy.ts";

const CAL = "mcp__claude_ai_Google_Calendar__";
const NOTION = "mcp__claude_ai_Notion__";
const refuse = async () => ({ approved: false }) as never;

test("a job's own list of connector tools hides everything else (the mechanism a profile uses to stay lean)", () => {
  const tools = toolsFor(["calendar:read", "notion:read"]);
  assert.ok(tools.has(CAL + "list_events") && tools.has(NOTION + "notion-fetch"));
  assert.ok(!tools.has(CAL + "create_event") && !tools.has(NOTION + "notion-create-pages"));
  const o = buildOptions(refuse, { ...profileOptions("background"), mcpTools: tools }, undefined);
  const off = o.disallowedTools ?? [];
  assert.ok(off.includes("mcp__mailbird"), "the mail client is out of view whole");
  assert.ok(off.includes(CAL + "create_event") && off.includes(CAL + "delete_event"));
  assert.ok(!off.includes(CAL + "list_events") && !off.includes(NOTION + "notion-fetch"));
});

test("heartbeat run: it is offered the owner's whole set of tools and skills, on its own model, and writes still ask", () => {
  const run = profileOptions("heartbeat");
  assert.equal(run.mcpTools, undefined, "no job-specific hiding: mail, calendar and Notion reads AND writes are there");
  assert.equal(run.source, "background");
  assert.equal(run.model, PROFILES.heartbeat.model);
  assert.ok(run.outputFormat, "it answers in constrained JSON");
  const o = buildOptions(refuse, run, undefined);
  assert.equal(o.model, PROFILES.heartbeat.model);
  assert.ok(!(o.disallowedTools ?? []).includes(CAL + "list_events"));
  assert.ok(!(o.disallowedTools ?? []).includes(CAL + "create_event"), "the calendar write is offered");
  // offered, but judged: the floor still asks for every write, and reads are free
  assert.equal(classify(CAL + "list_events", {}, "background"), "allow");
  assert.equal(classify(CAL + "create_event", {}, "background"), "ask");
  assert.equal(classify(NOTION + "notion-create-pages", {}, "background"), "ask");
  // the other unattended runs keep the owner's whole set too
  const background = buildOptions(refuse, profileOptions("background"), undefined);
  assert.ok(!(background.disallowedTools ?? []).includes(CAL + "create_event"));
});

test("hiddenOutside: a connector without an allowed tool is hidden whole; a tool seen later is hidden by name", () => {
  const off = hiddenOutside(new Set([CAL + "list_events"]), [CAL + "brand_new", "Skill"]);
  assert.ok(off.includes("mcp__claude_ai_Notion") && off.includes("mcp__mailbird"));
  assert.ok(off.includes(CAL + "brand_new") && off.includes(CAL + "create_event"));
  assert.ok(!off.includes(CAL + "list_events") && !off.includes("Skill") && !off.includes("mcp__claude_ai_Google_Calendar"));
});
