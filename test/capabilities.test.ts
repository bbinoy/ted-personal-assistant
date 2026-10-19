import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Capabilities decide the tools and the skills of every isolated conversation (capabilities.ts, skills.ts): a group has a fixed set, a tenant her
// record's. The tables below are pinned; adding a capability to a record must change exactly its tools and skills and nothing else.
process.env.INTAKE_BASE_URL = "";
const { settings } = await import("../src/settings.ts");
const { CAPABILITIES } = await import("../src/tenants.ts");
type Capability = (typeof CAPABILITIES)[number];
const { groupCapabilities, groupTools, NEVER_FOR_ISOLATED, runCapabilities, tenantTools, toolsFor } = await import("../src/capabilities.ts");
const { privateSkills, sharedSkills, skillsFor } = await import("../src/skills.ts");
const PRIVATE_SKILLS = privateSkills();
const SHARED_SKILLS = sharedSkills();
const { classify } = await import("../src/policy.ts");
const MANIFEST = (await import("../src/toolmanifest.ts")).allRows();
const { buildOptions } = await import("../src/agentrun.ts");
const { offeredSkills } = await import("../src/profiles.ts");

const P = (s: string) => `ted-personal-assistant:${s}`;
const WEATHER = ["get_distance", "get_forecast", "get_marine_forecast", "get_spot_info", "search_places"].map((t) => `mcp__weather__${t}`);
const CHAT = ["Edit", "Read", "WebSearch", "Write", "mcp__memory__forget_note", "mcp__memory__search_logs", "mcp__send__send"];
const sorted = (s: Iterable<string>) => [...s].sort();
const tenant = (...capabilities: Capability[]) => ({ config: {}, capabilities });
const caps = (...c: Capability[]) => runCapabilities(c);

test("capabilities: what a group, a friend and a person with less have, pinned (tools and skills come from the same set)", () => {
  const full = sorted([...CHAT, "Skill", "mcp__browse__browse", "mcp__draw__draw", "mcp__memory__undo_dream", "mcp__voice__voice", ...WEATHER]);
  const shared = [P("research-booking"), P("surf-conditions"), P("draw")];
  assert.deepEqual(sorted(groupTools()), full);
  assert.deepEqual(skillsFor(groupCapabilities()), shared);
  // a new friend's record is the same set as a group's
  const friend = caps("chat", "browse", "voice", "heartbeat", "dream", "weather", "draw");
  assert.deepEqual(sorted(toolsFor(friend)), full);
  assert.deepEqual(skillsFor(friend), shared);
  // chat alone: the basics, no skill and so no Skill tool
  assert.deepEqual(sorted(toolsFor(caps("chat"))), CHAT);
  assert.deepEqual(skillsFor(caps("chat")), []);
  // no chat: no tools at all, whatever else she has (the basics are the capability chat)
  assert.deepEqual(sorted(toolsFor(caps("weather", "draw"))), sorted([...WEATHER, "mcp__draw__draw"]));
  assert.deepEqual(sorted(toolsFor(caps())), []);
  // weather without draw and browse
  assert.deepEqual(sorted(toolsFor(caps("chat", "weather"))), sorted([...CHAT, "Skill", ...WEATHER]));
  assert.deepEqual(skillsFor(caps("chat", "weather")), [P("surf-conditions")]);
});

test("capabilities: adding one capability to a record changes exactly its tools and its skills", () => {
  const base = caps("chat");
  const adds: Record<Capability, { tools: string[]; skills: string[] }> = {
    chat: { tools: [], skills: [] },
    browse: { tools: ["Skill", "mcp__browse__browse"], skills: [P("research-booking")] },
    voice: { tools: ["mcp__voice__voice"], skills: [] },
    heartbeat: { tools: [], skills: [] }, // a schedule, not a tool
    dream: { tools: ["mcp__memory__undo_dream"], skills: [] },
    wake: { tools: [], skills: [] },
    weather: { tools: ["Skill", ...WEATHER], skills: [P("surf-conditions")] },
    draw: { tools: ["Skill", "mcp__draw__draw"], skills: [P("draw")] },
    notes: { tools: [], skills: [] },
    intake: { tools: [], skills: [] }, // its tools also need INTAKE_BASE_URL and a purpose (below)
    // the owner's login and the admin's powers: never a tool or a skill of an isolated conversation, whatever a record lists
    mail: { tools: [], skills: [] },
    calendar: { tools: [], skills: [] },
    notion: { tools: [], skills: [] },
    google: { tools: [], skills: [] },
    profile: { tools: [], skills: [] },
    card: { tools: [], skills: [] },
    admin: { tools: [], skills: [] },
  };
  assert.deepEqual(Object.keys(adds).sort(), [...CAPABILITIES].sort(), "every capability is in the table");
  for (const c of CAPABILITIES) {
    const withIt = caps("chat", c);
    assert.deepEqual(sorted(toolsFor(withIt)).filter((t) => !toolsFor(base).has(t)), sorted(adds[c].tools), `${c}: tools`);
    assert.deepEqual(sorted(toolsFor(base)).filter((t) => !toolsFor(withIt).has(t)), [], `${c}: takes nothing away`);
    assert.deepEqual(skillsFor(withIt), adds[c].skills, `${c}: skills`);
  }
  // everything at once is still only the sum of the free ones
  assert.deepEqual(sorted(toolsFor(caps(...CAPABILITIES))), sorted(groupTools()));
  assert.deepEqual(skillsFor(caps(...CAPABILITIES)), skillsFor(groupCapabilities()));
});

test("capabilities: the intake tools need the capability, a purpose and a usable INTAKE_BASE_URL; nothing else changes", () => {
  const was = settings.intake.baseUrl;
  try {
    (settings.intake as { baseUrl: string }).baseUrl = "https://intake.example.test";
    const has = (...c: Capability[]) => sorted(tenantTools(tenant(...c))).filter((t) => t.startsWith("mcp__intake__"));
    assert.deepEqual(has("chat", "intake", "profile"), ["mcp__intake__get_setup_link", "mcp__intake__setup_status"]);
    assert.deepEqual(has("chat", "intake"), [], "no purpose");
    assert.deepEqual(has("chat", "profile"), [], "no intake capability");
    assert.deepEqual(sorted(tenantTools(tenant("chat", "intake", "profile"))).filter((t) => !t.startsWith("mcp__intake__")), CHAT, "and nothing of the profile itself");
    assert.deepEqual(groupTools().has("mcp__intake__get_setup_link"), false, "never a group's");
  } finally {
    (settings.intake as { baseUrl?: string }).baseUrl = was;
  }
});

test("capabilities: a feature switched off in .env, or by her own settings, takes its tools and skills away", () => {
  const f = settings as unknown as { weather: boolean; draw: boolean; browse: boolean };
  const was = { weather: f.weather, draw: f.draw, browse: f.browse };
  try {
    f.weather = false;
    assert.ok(![...groupTools()].some((t) => t.startsWith("mcp__weather__")));
    assert.ok(!skillsFor(groupCapabilities()).includes(P("surf-conditions")));
    f.weather = was.weather;
    f.draw = false;
    assert.ok(!groupTools().has("mcp__draw__draw") && !skillsFor(groupCapabilities()).includes(P("draw")));
    f.draw = was.draw;
    f.browse = false;
    assert.ok(!groupTools().has("mcp__browse__browse") && !skillsFor(groupCapabilities()).includes(P("research-booking")));
    assert.equal(classify("mcp__browse__browse", {}, "group"), "deny");
    f.browse = was.browse;
    const mine = { config: { browse: false, voice: false }, capabilities: ["chat", "browse", "voice"] as Capability[] };
    assert.deepEqual(sorted(tenantTools(mine)), CHAT, "her own settings only take away");
  } finally {
    Object.assign(f, was);
  }
});

test("capabilities: classify follows the set: the same probes for the owner, a group, a friend and a person with chat only", () => {
  const notes = "/nonexistent-notes";
  const probes: [string, Record<string, unknown>][] = [
    ["WebSearch", { query: "x" }],
    ["WebFetch", { url: "https://example.com" }],
    ["Skill", {}],
    ["Read", { file_path: `${notes}/x.md` }],
    ["mcp__memory__forget_note", {}],
    ["mcp__memory__undo_dream", {}],
    ["mcp__send__send", {}],
    ["mcp__voice__voice", {}],
    ["mcp__draw__draw", {}],
    ["mcp__weather__get_forecast", {}],
    ["mcp__weather__set_alert", {}],
    ["mcp__browse__browse", {}],
    ["mcp__browser__browser_click", {}],
    ["mcp__mailbird__get_message", {}],
    ["mcp__mailbird__send_message_now", {}],
    ["mcp__claude_ai_Google_Calendar__list_events", {}],
    ["mcp__claude_ai_Notion__notion-fetch", {}],
    ["mcp__claude_ai_Google_Drive__search_files", {}],
    ["mcp__claude_ai_Interactive_Brokers__create_order_instruction", {}],
    ["mcp__tenants__list_tenants", {}],
    ["mcp__intake__get_setup_link", {}],
    ["mcp__card__pay", {}],
    ["Bash", {}],
    ["mcp__something__unknown", {}],
  ];
  const owner = (t: string, i: Record<string, unknown>) => classify(t, i, "chat");
  const group = (t: string, i: Record<string, unknown>) => classify(t, i, "group", notes);
  const friend = (t: string, i: Record<string, unknown>) => classify(t, i, "group", notes, tenantTools(tenant("chat", "browse", "voice", "heartbeat", "dream", "weather", "draw")));
  const bare = (t: string, i: Record<string, unknown>) => classify(t, i, "group", notes, tenantTools(tenant("chat")));
  const all = (t: string, i: Record<string, unknown>) => classify(t, i, "group", notes, tenantTools(tenant(...CAPABILITIES)));
  const row = (who: typeof owner) => probes.map(([t, i]) => who(t, i));
  const A = "allow";
  const D = "deny";
  assert.deepEqual(row(owner), [A, "ask", A, D, A, A, A, A, A, A, "ask", "ask", D, A, "ask", A, A, A, D, A, D, "ask", "ask", "ask"], "owner");
  const g = [A, D, A, A, A, A, A, A, A, A, D, A, D, D, D, D, D, D, D, D, D, D, D, D];
  assert.deepEqual(row(group), g, "group");
  assert.deepEqual(row(friend), g, "friend (the default record)");
  assert.deepEqual(row(bare), [A, D, D, A, A, D, A, D, D, D, D, D, D, D, D, D, D, D, D, D, D, D, D, D], "chat only");
  assert.deepEqual(row(all), g, "every capability at once is still a group's set, not the owner's");
});

test("capabilities: no private skill and no tool of the owner's login is ever offered, by any set or any name", () => {
  const everything = runCapabilities([...CAPABILITIES]);
  for (const set of [everything, groupCapabilities(), caps("chat")]) {
    const skills = skillsFor(set).map((s) => s.slice(s.indexOf(":") + 1));
    assert.deepEqual(skills.filter((s) => PRIVATE_SKILLS.includes(s)), []);
    for (const t of toolsFor(set)) assert.ok(!NEVER_FOR_ISOLATED.some((re) => re.test(t)), t);
  }
  // every folder of plugin/skills is one or the other: a new skill must be placed on purpose
  const folders = readdirSync(join(settings.pluginDir, "skills")).sort();
  assert.deepEqual([...Object.keys(SHARED_SKILLS), ...PRIVATE_SKILLS].sort(), folders);
  // the owner's list is the whole plugin; the private skills are only there
  assert.deepEqual(offeredSkills(true).filter((s) => !skillsFor(everything).includes(s)).map((s) => s.slice(s.indexOf(":") + 1)).sort(), PRIVATE_SKILLS.filter((s) => offeredSkills(true).includes(P(s))).sort());
  // the run's own options carry exactly the shared list, whatever a caller passes in the skills of a run it did not build
  const run = buildOptions(async () => ({ approved: false }), { source: "group", systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1, memory: { dir: "/nonexistent-notes" } }, undefined);
  assert.deepEqual(run.skills, skillsFor(groupCapabilities()));
  assert.deepEqual([run.settingSources, run.strictMcpConfig], [[], true]);
  assert.ok(!(run.skills ?? []).some((s) => PRIVATE_SKILLS.some((p) => s.endsWith(`:${p}`))));
});

test("capabilities: every manifest row names its capability, and a group never has a row of a connector or of the admin", () => {
  for (const e of MANIFEST) assert.ok((CAPABILITIES as readonly string[]).includes(e.cap), e.tool);
  const GROUP_ONLY_CAPS = new Set<string>(groupCapabilities());
  for (const e of MANIFEST.filter((x) => ["mail", "calendar", "notion", "google", "admin", "profile", "card"].includes(x.cap))) {
    assert.ok(!GROUP_ONLY_CAPS.has(e.cap), e.tool);
    assert.ok(!groupTools().has(e.tool), e.tool);
    assert.equal(classify(e.tool, {}, "group"), "deny", e.tool);
  }
});
