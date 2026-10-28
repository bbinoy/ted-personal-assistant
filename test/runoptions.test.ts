import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The run options of the owner's chat, a group and a tenant, for a message and for a look, as the ONE builder makes them (runoptions.ts runFor): pinned against
// test/fixtures/run-options.json, which was captured from the three chat paths before they became one builder and regenerated on purpose when the looks joined them. SNAPSHOT_WRITE=1 rewrites the fixture (the same switch as the prompts' fixture); do that only
// for a change that is meant to alter a run. A prompt is pinned as {key, sha}: a failure names the key that drifted. A second test pins what differs between the three (and only that).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "runoptions-"));
process.env.ANTHROPIC_API_KEY = "sk-" + "ant-api03-OWNEROWNEROWNEROWNEROWNER";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token";
const INSTANCE_KEY = "sk-" + "ant-api03-INSTANCEINSTANCEINSTANCE";
process.env.TENANT_ANTHROPIC_API_KEY = INSTANCE_KEY;

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { buildOptions } = await import("../src/run/agentrun.ts");
const { runFor, turnContext } = await import("../src/run/runoptions.ts");
const { FIRST_CONTACT } = await import("../src/run/persona.ts");
const { allRows } = await import("../src/policy/toolmanifest.ts");
const { group, owner, tenant } = await import("../src/conversation/conversation.ts");

const FIXTURE = new URL("./fixtures/run-options.json", import.meta.url);
const NOW = new Date("2026-10-19T09:00:00.000Z");
const STYLE = "- be brief";
const noop = async () => ({ approved: false });
const sha = (s: string) => createHash("sha256").update(s.replaceAll(settings.dataDir, "<data>").replaceAll(process.cwd(), "<repo>")).digest("hex").slice(0, 16); // (a prompt names the notes folder)
// A prompt in the fixture: its place (case.field) next to its hash, so that a drift says WHICH prompt changed, not just that a hash did.
const pinned = (key: string, text: string | undefined) => (text === undefined ? undefined : { key, sha: sha(text) });

const joinAs = (n: number, name: string) => T.tenantContext(T.addTenant({ aci: `00000000-0000-4000-8000-00000000000${n}`, name })!);
const bea = joinAs(2, "Bea");

type Run = Parameters<typeof buildOptions>[1];

// ---- the conversations, as they are built, for a message and for a look ----
const runs = {
  owner: (): Run => runFor(owner(), "message", {}),
  group: (): Run => runFor(group("g-run-options"), "message", { style: STYLE }),
  tenant: (ctx: ReturnType<typeof T.tenantContext>): Run => runFor(tenant(ctx.id), "message", { apiKey: INSTANCE_KEY, now: NOW }),
  ownerLook: (): Run => runFor(owner(), "look", { now: NOW }),
  groupLook: (): Run => runFor(group("g-run-options"), "look", { style: STYLE, now: NOW }),
  tenantLook: (ctx: ReturnType<typeof T.tenantContext>): Run => runFor(tenant(ctx.id), "look", { apiKey: INSTANCE_KEY, now: NOW }),
};

// Normalises what is machine- or run-specific (the data folder, the checkout, ids); functions become "[fn]".
const scrub = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "function" ? "[fn]" : x))
      .replaceAll(INSTANCE_KEY, "<instance-key>")
      .replaceAll(settings.dataDir, "<data>")
      .replaceAll(process.cwd(), "<repo>")
      .replaceAll(bea.id, "<bea>"),
  );

function describeRun(name: string, run: Run): Record<string, any> {
  const o = buildOptions(noop, run, undefined);
  const system = o.systemPrompt as { type: string; preset?: string; append?: string; prompt?: string; snapshot?: boolean };
  const env = o.env as Record<string, string | undefined>;
  return scrub({
    run: { ...run, systemPrompt: pinned(`${name}.run.systemPrompt`, run.systemPrompt), tools: run.tools && [...run.tools].sort(), experts: run.experts && Object.keys(run.experts.setup.agents).sort(), outputFormat: run.outputFormat && "[schema]" },
    model: o.model,
    system: { ...system, append: pinned(`${name}.system.append`, system.append), prompt: pinned(`${name}.system.prompt`, system.prompt) },
    settings: o.settings,
    mcpServers: o.mcpServers ? Object.keys(o.mcpServers) : null,
    strictMcpConfig: o.strictMcpConfig,
    persistSession: o.persistSession,
    tools: o.tools,
    settingSources: o.settingSources,
    plugins: o.plugins,
    skills: o.skills,
    disallowedTools: o.disallowedTools,
    permissionMode: o.permissionMode,
    maxTurns: o.maxTurns,
    maxBudgetUsd: o.maxBudgetUsd,
    envChanged: Object.fromEntries(Object.entries(env).filter(([k, v]) => process.env[k] !== v && k !== "MCP_CONNECTION_NONBLOCKING")),
    envRemoved: Object.keys(process.env).filter((k) => !(k in env)),
    hooks: Object.keys(o.hooks ?? {}),
    canUseTool: typeof o.canUseTool,
  }) as Record<string, any>;
}

function cases(): Record<string, Record<string, any>> {
  mock.timers.enable({ apis: ["Date"], now: NOW }); // the prompts carry the clock
  try {
    return {
      owner: describeRun("owner", runs.owner()),
      group: describeRun("group", runs.group()),
      tenant: describeRun("tenant", runs.tenant(bea)),
      ownerLook: describeRun("ownerLook", runs.ownerLook()),
      groupLook: describeRun("groupLook", runs.groupLook()),
      tenantLook: describeRun("tenantLook", runs.tenantLook(bea)),
    };
  } finally {
    mock.timers.reset();
  }
}

// Every leaf of a value as path -> JSON, and the paths where two values are not the same.
const leaves = (v: unknown, path = ""): Record<string, string> =>
  v && typeof v === "object" ? Object.assign({}, ...Object.entries(v).map(([k, x]) => leaves(x, path ? `${path}.${k}` : k))) : { [path]: JSON.stringify(v) };
const differing = (a: unknown, b: unknown): string[] => {
  const x = leaves(a);
  const y = leaves(b);
  const paths = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => x[k] !== y[k]);
  return [...new Set(paths.map((p) => p.split(".").filter((s) => !/^\d+$/.test(s)).slice(0, 2).join(".")))].sort(); // (a list is one entry; two levels are enough to say what)
};

test("run options: the owner's chat, a group and a tenant, for a message and for a look, are built as recorded", () => {
  const got = cases();
  if (process.env.SNAPSHOT_WRITE) return void writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
  assert.ok(existsSync(FIXTURE), "test/fixtures/run-options.json is missing: regenerate it on purpose with SNAPSHOT_WRITE=1 npm test");
  const stored = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const x = leaves(got);
  const y = leaves(stored);
  const drifted = Object.keys({ ...x, ...y }).filter((k) => x[k] !== y[k]).map((k) => k.replace(/\.(key|sha)$/, "")); // (a prompt is {key, sha}: name the key)
  assert.deepEqual(got, stored, `run options drifted from test/fixtures/run-options.json at: ${[...new Set(drifted)].join(", ")} (a deliberate change: SNAPSHOT_WRITE=1 npm test)`);
});

test("run options: what differs between the owner, a group and a tenant, and only that", () => {
  const c = cases();
  if (process.env.RUN_OPTIONS_PRINT) console.log(JSON.stringify({ ownerGroup: differing(c.owner, c.group), groupTenant: differing(c.group, c.tenant), ownerLook: differing(c.owner, c.ownerLook), groupLook: differing(c.group, c.groupLook), tenantLook: differing(c.tenant, c.tenantLook), lookOwnerGroup: differing(c.ownerLook, c.groupLook) }, null, 1));
  // owner -> group: persona, notes folder and session, the group's isolation (no user settings, no connectors, its capabilities' tools and shared skills (not the owner's), strict MCP)
  assert.deepEqual(differing(c.owner, c.group), [
    "disallowedTools", "mcpServers", "run.conversation", "run.experts", "run.groupId", "run.kind", "run.memory",
    "run.sessionConv", "run.skills", "run.stopScope", "run.systemPrompt", "run.tools", "settingSources", "settings.autoMemoryDirectory", "skills", "strictMcpConfig", "system.append",
  ]);
  // group -> tenant: notes, session and persona, her ledger and key; the instance key reaches her environment and the owner's logins leave it
  assert.deepEqual(differing(c.group, c.tenant), [
    "envChanged.ANTHROPIC_API_KEY", "envRemoved", "run.conversation", "run.groupId", "run.kind", "run.memory", "run.sessionConv", "run.stopScope", "run.systemPrompt", "run.tenant", "settings.autoMemoryDirectory", "system.append",
  ]);
  // the invariants the table above must not hide
  const bg = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }; // (every run: an expert never runs in the background, delegation.ts)
  assert.deepEqual([c.owner.envChanged, c.owner.envRemoved, c.group.envChanged, c.group.envRemoved], [bg, [], bg, []], "the owner's and a group's environment is the process's, untouched but for no background tasks");
  assert.equal(c.tenant.envChanged.ANTHROPIC_API_KEY, "<instance-key>");
  assert.ok(c.tenant.envRemoved.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.deepEqual([c.owner.run.tenant, c.group.run.tenant], [undefined, undefined]);
  assert.deepEqual(c.group.mcpServers, c.tenant.mcpServers, "a group and a tenant have the same servers (no connectors)");
  const shared = ["research-booking", "surf-conditions", "draw"].map((s) => `ted-personal-assistant:${s}`); // (never a private skill: no brief, mail, calendar, notion, setup, radar)
  assert.deepEqual([c.group.skills, c.tenant.skills, c.group.settingSources, c.tenant.settingSources], [shared, shared, [], []]);
});

// THE table of runoptions.ts TRIGGERS, seen from the options: what a look has that a message of the same conversation does not, and nothing else.
test("run options: a look is its conversation's message run but for the trigger table: model, session, answer, attended and its limits", () => {
  const c = cases();
  const TABLE = new Set([
    "model", "run.model", "run.effort", "run.outputFormat", // the model and the answer
    // (no limits: a look has the same turn cap, budget, ceiling and gate place as a message)
    "run.freshSession", // the session: a look keeps none
    "run.kind", "run.tools", "tools", "mcpServers", "run.memory", "settings.autoMemoryDirectory", "settings.autoMemoryEnabled", "system.append", "system.preset", "system.prompt", "system.type", // attended: the tools it removes or adds, and the notes' way in
    "run.experts", "hooks", // the look adds its delegation callbacks
    "run.systemPrompt", // (the pin's key names the case: the hash is compared below)
  ]);
  const attendedRows = new Set(allRows().filter((r) => r.attended !== undefined).map((r) => r.tool));
  for (const [msg, look] of [["owner", "ownerLook"], ["group", "groupLook"], ["tenant", "tenantLook"]] as const) {
    assert.equal(c[msg]!.run.systemPrompt.sha, c[look]!.run.systemPrompt.sha, `${msg}: ONE system prompt, whatever starts the run`);
    assert.deepEqual(differing(c[msg], c[look]).filter((k) => !TABLE.has(k)), [], `${msg}: only the trigger table differs`);
    const [m, l] = [new Set<string>(c[msg]!.run.tools), new Set<string>(c[look]!.run.tools)];
    const changed = [...m].filter((t) => !l.has(t)).concat([...l].filter((t) => !m.has(t)));
    assert.ok(changed.every((t) => attendedRows.has(t)), `${msg}: attendance changes only rows that say so: ${changed.filter((t) => !attendedRows.has(t)).join(", ")}`);
    assert.deepEqual([c[look]!.run.kind.attended, c[msg]!.run.kind.attended, c[look]!.run.kind.who], [false, true, c[msg]!.run.kind.who]);
  }
  // draw, voice and the web follow the capabilities, in a look as in a chat: the owner's look has them like a group's
  for (const t of ["mcp__draw__draw", "mcp__voice__voice", "mcp__send__send", "mcp__tasks__add_task", "mcp__weather__get_forecast", "WebSearch", "WebFetch"]) {
    assert.ok(new Set<string>(c.ownerLook!.run.tools).has(t) === new Set<string>(c.owner!.run.tools).has(t), t);
    assert.ok(new Set<string>(c.groupLook!.run.tools).has(t) === new Set<string>(c.group!.run.tools).has(t), t);
  }
});

test("first contact: a friend's first turn carries the hint for Ted to greet her in his own voice (AI, may be wrong, private from users and admin, the honest limit); never again", () => {
  const rec = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000a1", name: "Cal" })!;
  assert.equal(rec.status, "active", "no age or region question: she is active at once");
  assert.equal(turnContext(tenant(rec.id)), FIRST_CONTACT);
  for (const part of [/\bAI\b/, /may be wrong/, /private from other users and from the admin/, /could technically still read the files/, /own voice/]) assert.match(FIRST_CONTACT, part);
  T.markDisclosed(T.tenantContext(rec));
  assert.equal(turnContext(tenant(rec.id)), undefined);
});
