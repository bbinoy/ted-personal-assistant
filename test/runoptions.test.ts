import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The run options of the owner's chat, a group and a tenant, as the code builds them: pinned against test/fixtures/run-options.json, which was
// captured from the code as it was before the three paths became one builder. SNAPSHOT_WRITE=1 rewrites the fixture (the same switch as the prompts' fixture); do that only
// for a change that is meant to alter a run. A prompt is pinned as {key, sha}: a failure names the key that drifted. A second test pins what differs between the three (and only that).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "runoptions-"));
process.env.ANTHROPIC_API_KEY = "sk-" + "ant-api03-OWNEROWNEROWNEROWNEROWNER";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token";
const INSTANCE_KEY = "sk-" + "ant-api03-INSTANCEINSTANCEINSTANCE";
process.env.TENANT_ANTHROPIC_API_KEY = INSTANCE_KEY;

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants.ts");
const { buildOptions } = await import("../src/agentrun.ts");
const { runOptionsFor } = await import("../src/runoptions.ts");
const { group, owner, tenant } = await import("../src/conversation.ts");

const FIXTURE = new URL("./fixtures/run-options.json", import.meta.url);
const NOW = new Date("2026-10-19T09:00:00.000Z");
const STYLE = "- be brief";
const noop = async () => ({ approved: false });
const sha = (s: string) => createHash("sha256").update(s.replaceAll(settings.dataDir, "<data>").replaceAll(process.cwd(), "<repo>")).digest("hex").slice(0, 16); // (a prompt names the notes folder)
// A prompt in the fixture: its place (case.field) next to its hash, so that a drift says WHICH prompt changed, not just that a hash did.
const pinned = (key: string, text: string | undefined) => (text === undefined ? undefined : { key, sha: sha(text) });

const joinAs = (n: number, name: string) => T.tenantContext(T.redeemInvite(T.mintInvite()!.code, { aci: `00000000-0000-4000-8000-00000000000${n}`, name })!);
const ann = joinAs(1, "Ann"); // has not confirmed her age and region yet
const bea = joinAs(2, "Bea");
T.recordConsent(bea, "Germany");

type Run = Parameters<typeof buildOptions>[1];

// ---- the three paths, as they are built (the only part that changes when they become one) ----
const runs = {
  owner: (): Run => runOptionsFor(owner(), { notify: async () => {} }),
  group: (): Run => runOptionsFor(group("g-run-options"), { style: STYLE }),
  tenant: (ctx: ReturnType<typeof T.tenantContext>): Run => runOptionsFor(tenant(ctx.id), { apiKey: INSTANCE_KEY, now: NOW }),
};

// Normalises what is machine- or run-specific (the data folder, the checkout, ids); functions become "[fn]".
const scrub = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "function" ? "[fn]" : x))
      .replaceAll(INSTANCE_KEY, "<instance-key>")
      .replaceAll(settings.dataDir, "<data>")
      .replaceAll(process.cwd(), "<repo>")
      .replaceAll(ann.id, "<ann>")
      .replaceAll(bea.id, "<bea>"),
  );

function describeRun(name: string, run: Run): Record<string, any> {
  const o = buildOptions(noop, run, undefined);
  const system = o.systemPrompt as { type: string; preset?: string; append?: string; prompt?: string; snapshot?: boolean };
  const env = o.env as Record<string, string | undefined>;
  return scrub({
    run: { ...run, systemPrompt: pinned(`${name}.run.systemPrompt`, run.systemPrompt), tools: run.tools && [...run.tools].sort() },
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
    return { owner: describeRun("owner", runs.owner()), group: describeRun("group", runs.group()), tenantAskingConsent: describeRun("tenantAskingConsent", runs.tenant(ann)), tenant: describeRun("tenant", runs.tenant(bea)) };
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

test("run options: the owner's chat, a group and a tenant are built exactly as they always were", () => {
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
  if (process.env.RUN_OPTIONS_PRINT) console.log(JSON.stringify({ ownerGroup: differing(c.owner, c.group), groupTenant: differing(c.group, c.tenant), tenantConsent: differing(c.tenantAskingConsent, c.tenant) }, null, 1));
  // owner -> group: persona, limits, notes folder and session, the group's isolation (no user settings, no connectors, its capabilities' tools and shared skills (not the owner's), strict MCP)
  assert.deepEqual(differing(c.owner, c.group), [
    "disallowedTools", "maxBudgetUsd", "maxTurns", "run.maxBudgetUsd", "run.maxTurns", "run.memory",
    "run.sessionFile", "run.skills", "run.source", "run.systemPrompt", "run.tools", "settingSources", "settings.autoMemoryDirectory", "skills", "strictMcpConfig", "system.append", "tools",
  ]);
  // group -> tenant: her limits, notes, session and persona, her ledger and key; the instance key reaches her environment and the owner's logins leave it
  assert.deepEqual(differing(c.group, c.tenant), [
    "envChanged.ANTHROPIC_API_KEY", "envRemoved", "maxTurns", "run.maxTurns", "run.memory", "run.sessionFile", "run.systemPrompt", "run.tenant", "settings.autoMemoryDirectory", "system.append",
  ]);
  // before her consent: one MCP server, no built-in tool and no skill, her ledger and persona unchanged
  assert.deepEqual(differing(c.tenantAskingConsent, c.tenant), ["mcpServers", "plugins.path", "plugins.skipMcpDiscovery", "plugins.type", "run.memory", "run.sessionFile", "run.skills", "run.systemPrompt", "run.tenant", "run.tools", "settings.autoMemoryDirectory", "skills", "system.append", "tools"]);
  // the invariants the table above must not hide
  assert.deepEqual([c.owner.envChanged, c.owner.envRemoved, c.group.envChanged, c.group.envRemoved], [{}, [], {}, []], "the owner's and a group's environment is the process's, untouched");
  assert.equal(c.tenant.envChanged.ANTHROPIC_API_KEY, "<instance-key>");
  assert.ok(c.tenant.envRemoved.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.deepEqual([c.owner.run.tenant, c.group.run.tenant], [undefined, undefined]);
  assert.deepEqual(c.group.mcpServers, c.tenant.mcpServers, "a group and a tenant have the same servers (no connectors)");
  const shared = ["research-booking", "surf-conditions", "draw"].map((s) => `ted-personal-assistant:${s}`); // (never a private skill: no brief, mail, calendar, notion, setup, radar)
  assert.deepEqual([c.group.skills, c.tenant.skills, c.group.settingSources, c.tenant.settingSources], [shared, shared, [], []]);
  assert.equal(c.tenantAskingConsent.skills, undefined);
  assert.deepEqual(c.tenantAskingConsent.mcpServers, ["tenant"]);
});
