import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@ted-assistant/messenger/testing";

// A tenant is a "group" run with one person in it and a folder of her own. What this pins: her file tools reach her notes and nothing else (not
// another tenant's, not the owner's, through "..", an absolute path or a symlink); the owner's chat does not read hers; her tool set has none of the
// owner's connectors, no payment and no saved profile; her run is on her own key and her own ledger; a group she is in stays the group's.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "tenant-isolation-"));
process.env.ANTHROPIC_API_KEY = "sk-" + "ant-api03-OWNEROWNEROWNEROWNEROWNER"; // the instance's own, which a tenant's run must never carry
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token";
const INSTANCE_KEY = "sk-" + "ant-api03-INSTANCEINSTANCEINSTANCE"; // TENANT_ANTHROPIC_API_KEY: the shared key tenants run on, in .env
process.env.TENANT_ANTHROPIC_API_KEY = INSTANCE_KEY;

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { resolveCapabilities, toolsFor: toolsForCaps } = await import("../src/policy/capabilities.ts");
const tenantCapabilities = (ctx: { config: any; capabilities: readonly any[] }) => resolveCapabilities(ctx.capabilities, { own: ctx.config }); // (a context not in the registry: the pure step of capabilitiesOf)
const tenantTools = (ctx: { config: any; capabilities: readonly any[] }) => toolsForCaps(tenantCapabilities(ctx));
const NEVER_FOR_ISOLATED: readonly RegExp[] = [/^mcp__mailbird__/, /^mcp__claude_ai_/, /^mcp__tenants__/, /^mcp__browser__/, /^WebFetch$/, /^Bash/, /card|payment|profile/i]; // (written out by hand, apart from the modules' `ownerOnly`)
const { classify, isReadableData, hiddenTools } = await import("../src/policy/policy.ts");
const { NOTES_DIR } = await import("../src/notes.ts");
const MANIFEST = (await import("../src/policy/toolmanifest.ts")).allRows();
const { searchLogs } = await import("../src/logsearch.ts");
const { searchHistoryFile, groupDir, groupNotesDir, GROUPS_DIR } = await import("../src/groupstore.ts");
const { runConversation } = await import("../src/agent.ts");
const askTenant = (ctx: { id: string }, apiKey: string, prompt: string, _pictures: unknown[], hooks: { firstOutput: () => void } | undefined, _documents: unknown[], io: { query?: never }) => runConversation(tenant(ctx.id), { apiKey }, () => ({ prompt }), hooks?.firstOutput, io);
const { runOptionsFor } = await import("../src/runoptions.ts");
const tenantRunOptions = (ctx: { id: string }, apiKey: string, now?: Date) => runOptionsFor(tenant(ctx.id), { apiKey, now });
const { browseRunOptions, buildOptions } = await import("../src/agentrun.ts");
const { BrowseGuard } = await import("../src/modules/browse/browseguard.ts");
const { browse, startRefusal } = await import("../src/modules/browse/browse.ts");
const { tenantEnv, createTenantServer } = await import("../src/tenants/tenanttools.ts");
const { coolingDown, resetCooldown } = await import("../src/cooldown.ts");
const { InstanceKeyError } = await import("../src/errors.ts");
const { INSTANCE_KEY_COOLDOWN } = await import("../src/payer.ts");
const { spentToday } = await import("../src/budget.ts");
const { createPipeline, group, owner, tenant } = await import("../src/conversation.ts");
const { speaker } = await import("../src/group.ts");
const { createOutbound } = await import("../src/outbound.ts");
const { toPerson } = await import("@ted-assistant/signal");

const CANARY_OWNER = "CANARY-OWNER-4711";
const CANARY_B = "CANARY-BEA-0815";
const KEY = "sk-" + "ant-api03-ANNANNANNANNANNANNANNANN";
let n = 0;
const join_ = (name: string): import("../src/tenants/tenants.ts").TenantRecord => {
  const made = T.mintInvite()!;
  const rec = T.redeemInvite(made.code, { aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name });
  assert.ok(rec);
  return rec;
};

const ann = T.tenantContext(join_("Ann"));
const bea = T.tenantContext(join_("Bea"));
const tools = tenantTools(ann);

// the owner's things, and Bea's
mkdirSync(NOTES_DIR, { recursive: true });
writeFileSync(join(NOTES_DIR, "context-secret.md"), `owner secret ${CANARY_OWNER}`);
mkdirSync(settings.logsDir, { recursive: true });
writeFileSync(join(settings.logsDir, "audit.jsonl"), `{"tool":"mail","detail":"${CANARY_OWNER}"}\n`);
writeFileSync(join(bea.notesDir, "context-secret.md"), `bea secret ${CANARY_B}`);
writeFileSync(bea.logFile, `{"ts":1,"at":"2026-10-17T10:00:00.000Z","kind":"owner","text":"${CANARY_B}"}\n`);
writeFileSync(join(ann.notesDir, "people-eve.md"), "Eve is Ann's sister");
writeFileSync(ann.logFile, `{"ts":2,"at":"2026-10-17T10:00:00.000Z","kind":"owner","text":"Ann likes tea"}\n`);

const asTenant = (tool: string, input: Record<string, unknown>) => classify(tool, input, "group", ann.notesDir, tools);

beforeEach(() => resetCooldown());

test("tenant files: her tools reach her own notes and nothing else", () => {
  for (const tool of ["Read", "Write", "Edit"]) {
    assert.equal(asTenant(tool, { file_path: join(ann.notesDir, "people-eve.md") }), "allow", tool);
    assert.equal(asTenant(tool, { file_path: join(ann.notesDir, "context-new.md") }), "allow", `${tool}: a new note`);
    assert.equal(asTenant(tool, { file_path: join(bea.notesDir, "context-secret.md") }), "deny", `${tool}: another tenant's note`);
    assert.equal(asTenant(tool, { file_path: join(NOTES_DIR, "context-secret.md") }), "deny", `${tool}: the owner's note`);
    assert.equal(asTenant(tool, { file_path: join(settings.logsDir, "audit.jsonl") }), "deny", `${tool}: the owner's logs`);
    assert.equal(asTenant(tool, { file_path: bea.logFile }), "deny", `${tool}: another tenant's history`);
    assert.equal(asTenant(tool, { file_path: ann.logFile }), "deny", `${tool}: even her own history is not a file she edits`);
    assert.equal(asTenant(tool, { file_path: join(ann.notesDir, "..", "..", bea.id, "notes", "context-secret.md") }), "deny", `${tool}: through ..`);
    assert.equal(asTenant(tool, { file_path: join(ann.notesDir, "..", "tenant.json") }), "deny", `${tool}: her own settings`);
    assert.equal(asTenant(tool, { file_path: `${ann.notesDir}/../../../memory/notes/context-secret.md` }), "deny", `${tool}: out to the owner's notes`);
    assert.equal(asTenant(tool, { file_path: ann.notesDir }), "deny", `${tool}: the folder itself`);
    assert.equal(asTenant(tool, { file_path: "context-secret.md" }), "deny", `${tool}: a relative path`);
    assert.equal(asTenant(tool, { file_path: join(ann.notesDir, "x\0y") }), "deny", `${tool}: a NUL`);
    assert.equal(asTenant(tool, {}), "deny", `${tool}: no path`);
  }
});

test("tenant files: a symlink inside her notes cannot lead out of them", () => {
  symlinkSync(bea.notesDir, join(ann.notesDir, "to-bea"));
  symlinkSync(NOTES_DIR, join(ann.notesDir, "to-owner"));
  symlinkSync(join(settings.logsDir, "audit.jsonl"), join(ann.notesDir, "context-audit.md"));
  for (const tool of ["Read", "Write", "Edit"]) {
    assert.equal(asTenant(tool, { file_path: join(ann.notesDir, "to-bea", "context-secret.md") }), "deny", tool);
    assert.equal(asTenant(tool, { file_path: join(ann.notesDir, "to-owner", "context-secret.md") }), "deny", tool);
    assert.equal(asTenant(tool, { file_path: join(ann.notesDir, "context-audit.md") }), "deny", `${tool}: a link to a file`);
  }
});

test("tenant history: search_logs reads the history file it was built with and no other", () => {
  assert.match(searchHistoryFile(ann.logFile, { query: "tea" }), /Ann likes tea/);
  assert.equal(searchHistoryFile(ann.logFile, { query: CANARY_B }), "No matching messages.");
  assert.equal(searchHistoryFile(ann.logFile, { query: CANARY_OWNER }), "No matching messages.");
});

test("the owner's chat: no tenant's notes, history or secret store, but its own data as always", () => {
  mkdirSync(join(settings.stateDir, "openbao", "tls"), { recursive: true });
  writeFileSync(join(settings.stateDir, "openbao", "tls", "key.pem"), "private");
  writeFileSync(join(settings.stateDir, "invites.json"), "{}");
  writeFileSync(join(settings.stateDir, "cost.json"), "{}");
  mkdirSync(settings.memoryDir, { recursive: true });
  assert.equal(isReadableData(join(settings.logsDir, "audit.jsonl")), true);
  assert.equal(isReadableData(join(settings.stateDir, "cost.json")), true);
  assert.equal(isReadableData(join(NOTES_DIR, "context-secret.md")), true);
  assert.equal(isReadableData(join(settings.stateDir, "tenants.json")), true, "the registry: ids, account ids, status; no key, no words");
  assert.equal(isReadableData(join(bea.notesDir, "context-secret.md")), false);
  assert.equal(isReadableData(bea.logFile), false);
  assert.equal(isReadableData(join(ann.dir, "consent.json")), false);
  assert.equal(isReadableData(join(settings.stateDir, "openbao", "tls", "key.pem")), false);
  assert.equal(isReadableData(join(settings.stateDir, "invites.json")), false);
  symlinkSync(bea.notesDir, join(settings.memoryDir, "sneaky")); // a link from a readable folder into hers
  assert.equal(isReadableData(join(settings.memoryDir, "sneaky", "context-secret.md")), false);
  for (const tool of ["Read"]) {
    assert.equal(classify(tool, { file_path: join(bea.notesDir, "context-secret.md") }, "chat"), "deny");
    assert.equal(classify(tool, { file_path: bea.logFile }, "chat"), "deny");
    assert.equal(classify(tool, { file_path: join(NOTES_DIR, "context-secret.md") }, "chat"), "allow");
  }
  assert.equal(classify("Write", { file_path: join(bea.notesDir, "context-x.md") }, "chat"), "deny");
  // search_logs of the owner reads logs/ only: her history is not in it
  assert.doesNotMatch(searchLogs(settings.logsDir, { query: CANARY_B }), new RegExp(CANARY_B));
  assert.match(searchLogs(settings.logsDir, { query: CANARY_OWNER }), new RegExp(CANARY_OWNER));
});

test("tenant tools: nothing of the owner's, no payment, no saved profile; only what her capabilities give", () => {
  const allowed = [...tools].sort();
  assert.ok(["Read", "Write", "Edit", "WebSearch", "Skill", "mcp__memory__forget_note", "mcp__memory__search_logs", "mcp__send__send", "mcp__weather__get_forecast", "mcp__draw__draw"].every((t) => tools.has(t)));
  for (const t of tools) assert.ok(!NEVER_FOR_ISOLATED.some((re) => re.test(t)), t);
  const seen = ["Bash", "Glob", "Grep", "NotebookEdit", "WebFetch", "mcp__browser__browser_click", "mcp__claude_ai_Interactive_Brokers__create_order_instruction", "mcp__tenants__create_invite", "mcp__tenants__remove_tenant", "mcp__mailbird__send_message_now", "mcp__claude_ai_Notion__notion-search", "mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Google_Calendar__create_event", "mcp__card__pay", "mcp__profile__fill", "mcp__something__unknown"];
  for (const t of [...MANIFEST.map((e) => e.tool), ...seen]) {
    if (tools.has(t)) continue;
    assert.equal(asTenant(t, { file_path: join(ann.notesDir, "x.md") }), "deny", t);
  }
  // her own settings can only take tools away
  assert.ok(!tenantTools({ config: { browse: false }, capabilities: ann.capabilities }).has("mcp__browse__browse"));
  assert.ok(!tenantTools({ config: { voice: false }, capabilities: ann.capabilities }).has("mcp__voice__voice"));
  assert.deepEqual([...tenantTools({ config: { connectors: ["gmail"] }, capabilities: ann.capabilities })].sort(), allowed, "listing a connector adds nothing in this phase");
  assert.deepEqual([...tenantTools({ config: { connectors: ["gmail"] }, capabilities: ann.capabilities })].sort(), allowed.filter((t) => t !== "mcp__voice__voice" || true).sort(), "listing a connector adds nothing in this phase");
  // and the owner-only admin tools are the owner's chat's, not hidden away from it
  assert.ok(!hiddenTools(["mcp__tenants__create_invite", "mcp__tenants__remove_tenant"]).some((t) => t.startsWith("mcp__tenants")));
  assert.equal(classify("mcp__tenants__create_invite", {}, "chat"), "allow");
  assert.equal(classify("mcp__tenants__list_tenants", {}, "chat"), "allow");
  assert.equal(classify("mcp__tenants__suspend_tenant", { id: "x" }, "chat"), "ask");
  assert.equal(classify("mcp__tenants__remove_tenant", { id: "x" }, "chat"), "ask");
  for (const source of ["group", "background", "brief", "handler", "radar", "browse", "dream", "heartbeat"] as const) assert.equal(classify("mcp__tenants__create_invite", {}, source), "deny", source);
});

test("tenant browse: the worker gets no saved profile and no card, whatever is offered, and asks her own budget", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "tbrowse-"));
  let guard: InstanceType<typeof BrowseGuard> | undefined;
  const fakeCard = { ledger: { recover: () => {} } } as never;
  const fakeProfile = { entries: [{ key: "email", kind: "email", value: "x@example.com" }] } as never;
  await browse({ mode: "group", key: `tenant:${ann.id}`, run: async (_p, g) => ((guard = g), { text: "", structured: { status: "done", answer: "ok", sources: [] } }) }, "look up opening hours", { status: { ok: true, cli: "cli.js", exe: "chrome" }, card: fakeCard, profile: fakeProfile, resolver: async () => ["93.184.216.34"] });
  assert.ok(guard);
  assert.equal(guard.cardInfo(), undefined);
  assert.deepEqual(guard.profileKeys(), []);
  assert.match(startRefusal({ mode: "group", spent: () => true }, Date.now(), { ok: true, cli: "cli.js", exe: "chrome" })!, /daily spend limit/);
  assert.equal(startRefusal({ mode: "group", spent: () => false }, Date.now(), { ok: true, cli: "cli.js", exe: "chrome" }), undefined, "her ledger decides, not the instance's");
  const run = tenantRunOptions(ann, KEY).tenant!;
  assert.equal(browseRunOptions(new BrowseGuard({ mode: "group", task: "x", outDir }), run).tenant, run, "her browse worker runs on her key too");
  assert.equal(browseRunOptions(new BrowseGuard({ mode: "owner", task: "x", outDir })).tenant, undefined);
});

test("tenant key: her run's environment carries HER key and none of the instance's logins", () => {
  const env = tenantEnv({ ...process.env, ANTHROPIC_BASE_URL: "http://proxy", PATH: "/bin" }, KEY);
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.PATH, "/bin");
  assert.throws(() => tenantEnv({}, ""), /instance API key/);
  T.recordConsent(ann, "Germany"); // (her age and region are confirmed: the full tool set)
  const noop = async () => ({ approved: false });
  const o = buildOptions(noop, tenantRunOptions(ann, KEY), undefined);
  assert.equal(o.env!.ANTHROPIC_API_KEY, KEY);
  assert.equal(o.env!.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.permissionMode, "default");
  assert.deepEqual(o.tools, ["Skill", "Read", "Write", "Edit", "WebSearch"]);
  assert.deepEqual(Object.keys(o.mcpServers as object).sort(), ["memory", "send", "weather", "draw", ...(settings.browse ? ["browse"] : []), ...(settings.tts.provider === "qwen" ? ["voice"] : [])].sort());
  assert.equal((o.settings as { autoMemoryDirectory: string }).autoMemoryDirectory, ann.notesDir);
  // the owner's chat is as it was: the process environment, no key injected, and no tenant tools without TENANTS
  const ownerOpts = { source: "chat" as const, systemPrompt: "x", sessionFile: "state/session.json", memory: { dir: NOTES_DIR }, maxTurns: 3, maxBudgetUsd: 1 };
  const off = buildOptions(noop, ownerOpts, undefined);
  assert.equal(off.env!.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY);
  assert.ok(!("tenants" in (off.mcpServers as object)));
  (settings as unknown as { tenants: boolean }).tenants = true;
  try {
    assert.ok("tenants" in (buildOptions(noop, ownerOpts, undefined).mcpServers as object), "the owner's tenant tools exist with TENANTS=on");
    assert.ok(!("tenants" in (o.mcpServers as object)));
  } finally {
    (settings as unknown as { tenants: boolean }).tenants = false;
  }
});

test("consent first: until her age and region are confirmed her run has one tool and no built-ins", async () => {
  const ctx = T.tenantContext(join_("Cleo"));
  const o = buildOptions(async () => ({ approved: false }), tenantRunOptions(ctx, KEY), undefined);
  assert.deepEqual(o.tools, []);
  assert.deepEqual(Object.keys(o.mcpServers as object), ["tenant"]);
  const gate = async (tool: string, input: Record<string, unknown>) => (await o.canUseTool!(tool, input, { signal: new AbortController().signal } as never)) as { behavior: string };
  assert.equal((await gate(T.TENANT_CONSENT_TOOL, { ageConfirmed: true, region: "Germany" })).behavior, "allow");
  for (const [tool, input] of [["Read", { file_path: join(ctx.notesDir, "x.md") }], ["WebSearch", { query: "x" }], ["mcp__send__send", { text: "x" }], ["mcp__browse__browse", { task: "xxxxxx" }]] as const) assert.equal((await gate(tool, input)).behavior, "deny", tool);
  const after = tenantRunOptions(ctx, KEY);
  assert.equal(after.tenant!.consented, false);
  T.recordConsent(ctx, "Germany");
  const done = tenantRunOptions(ctx, KEY);
  assert.equal(done.tenant!.consented, true);
  assert.ok(!done.tools!.has(T.TENANT_CONSENT_TOOL));
  assert.notEqual(done.systemPrompt, after.systemPrompt);
  assert.ok(createTenantServer({ id: ctx.id, consentFile: ctx.consentFile }));
});

// ---- a run against a fake SDK ----

type Msg = Record<string, unknown>;
const fakeQuery = (messages: Msg[], seen: { options?: Record<string, unknown> }) => ((arg: { options: Record<string, unknown> }) => {
  seen.options = arg.options;
  return (async function* () {
    for (const m of messages) yield m;
  })();
}) as never;
const ok: Msg[] = [
  { type: "assistant", message: { usage: { input_tokens: 10 } }, parent_tool_use_id: null },
  { type: "result", subtype: "success", is_error: false, result: "hi Ann", total_cost_usd: 0.05, session_id: "sess-ann" },
];

test("a tenant's run: her key in the environment, her cost on her ledger, her session in her folder; the instance's are untouched", async () => {
  const seen: { options?: Record<string, unknown> } = {};
  const before = spentToday();
  const r = await askTenant(ann, KEY, "hello", [], undefined, [], { query: fakeQuery(ok, seen) });
  assert.equal(r.text, "hi Ann");
  assert.equal((seen.options!.env as Record<string, string>).ANTHROPIC_API_KEY, KEY);
  assert.equal((seen.options!.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(spentToday(ann.costFile), 0.05);
  assert.equal(spentToday(), before, "the instance's daily guard did not move");
  assert.equal(JSON.parse(readFileSync(ann.sessionFile, "utf8")).sessionId, "sess-ann");
  assert.equal(existsSync(join(settings.stateDir, "session.json")), false);
});

test("the instance key: read into settings, gone from the process environment, in a tenant run's env only, never in a log or an audit row", async () => {
  assert.equal(settings.tenantApiKey, INSTANCE_KEY);
  assert.equal(process.env.TENANT_ANTHROPIC_API_KEY, undefined, "no child process (Claude Code, MCP servers, the owner's runs) inherits it");
  const noop = async () => ({ approved: false });
  const ownerOpts = { source: "chat" as const, systemPrompt: "x", sessionFile: "state/session.json", memory: { dir: NOTES_DIR }, maxTurns: 3, maxBudgetUsd: 1 };
  const owners = buildOptions(noop, ownerOpts, undefined);
  assert.ok(!JSON.stringify(owners.env).includes(INSTANCE_KEY), "the owner's run never carries it");
  const logged: string[] = [];
  const spies = (["log", "error", "warn"] as const).map((k) => [k, console[k]] as const);
  for (const [k] of spies) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  const seen: { options?: Record<string, unknown> } = {};
  try {
    await askTenant(ann, settings.tenantApiKey!, "hello", [], undefined, [], { query: fakeQuery(ok, seen) });
  } finally {
    for (const [k, f] of spies) console[k] = f;
  }
  assert.equal((seen.options!.env as Record<string, string>).ANTHROPIC_API_KEY, INSTANCE_KEY, "the tenant's run has it as ANTHROPIC_API_KEY");
  assert.equal((seen.options!.env as Record<string, string>).TENANT_ANTHROPIC_API_KEY, undefined);
  const written = [logged.join("\n"), ...["logs/audit.jsonl", "logs/agent.log"].map((f) => (existsSync(join(settings.dataDir, f)) ? readFileSync(join(settings.dataDir, f), "utf8") : ""))];
  for (const text of written) assert.ok(!text.includes(INSTANCE_KEY) && !text.includes("INSTANCEINSTANCE"), "not in a log or an audit row");
  assert.ok(!JSON.stringify(tenantRunOptions(ann, INSTANCE_KEY, new Date()).systemPrompt).includes("INSTANCEINSTANCE"), "nor in the prompt");
});

test("a tenant's run that fails on the instance key pauses the key (every friend), never the owner's login", async () => {
  const seen: { options?: Record<string, unknown> } = {};
  const bad: Msg[] = [
    { type: "assistant", error: "billing_error", message: { usage: {} }, parent_tool_use_id: null },
    { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0, session_id: "s" },
  ];
  await assert.rejects(askTenant(bea, KEY, "hello", [], undefined, [], { query: fakeQuery(bad, seen) }), (e) => e instanceof InstanceKeyError && e.why === "billing");
  assert.equal(coolingDown(Date.now() + 1000, INSTANCE_KEY_COOLDOWN), true);
  assert.equal(coolingDown(Date.now() + 1000), false);
  resetCooldown();
  const r = await askTenant(ann, KEY, "hello", [], undefined, [], { query: fakeQuery(ok, seen) });
  assert.equal(r.text, "hi Ann", "another tenant's run goes on once the key is accepted again");
});

// ---- the pipeline ----

function rig() {
  const sent: { text: string; groupId?: string }[] = [];
  const typing: { stop: boolean; groupId?: string }[] = [];
  const reads: { ts: number; from?: string }[] = [];
  const records: { target?: string; kind: string; text: string }[] = [];
  const ran = { tenant: [] as string[], owner: [] as string[], group: [] as string[] };
  let ts = 9000;
  const messenger = {
    name: "fake",
    summary: "fake",
    self: "+10000000001",
    capabilities: FULL_CAPABILITIES,
    react: async () => {},
    typing: async (groupId: string | undefined, on: boolean) => void typing.push({ stop: !on, groupId }),
    markRead: async (_target: string | undefined, m: { timestamp: number; author?: string }) => void reads.push({ ts: m.timestamp, from: m.author }),
    send: async (groupId: string | undefined, m: { text: string }) => (sent.push({ text: m.text, groupId }), ++ts),
  };
  const record = (target: string | undefined, kind: string, _t: number, text: string) => void records.push({ target, kind, text });
  const out = createOutbound(messenger, (kind, t, text, target) => record(target, kind, t, text));
  const pipeline = createPipeline({
    messenger,
    out,
    record,
    run: async (conv, prompt) => (conv.kind === "tenant" ? (ran.tenant.push(`${conv.key}: ${prompt}`), { text: "tenant ok" }) : (ran.owner.push(prompt), { text: "owner ok" })),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => "voice",
    speech: { ready: () => false, synth: async () => "", foreign: async () => undefined },
    approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: (w) => w.from === "+10000000000",
    admitGroup: async (conv, m) => void ran.group.push(`${conv.key}: ${m.text}`),
    wait: async () => {},
  });
  return { sent, typing, reads, records, ran, pipeline };
}

const aciOf = (c: { target?: string }) => c.target!.slice(3);

test("pipeline: a tenant's chat answers her, to her, logs to her, and is not the owner's chat", async () => {
  const { sent, typing, reads, records, ran, pipeline } = rig();
  const conv = tenant(ann.id);
  assert.deepEqual([conv.kind, conv.source, conv.direct, conv.gate, conv.groupId, conv.target], ["tenant", "group", true, false, undefined, toPerson(aciOf(ann))]);
  assert.equal(conv.notesDir, ann.notesDir);
  assert.equal(conv.logFile, ann.logFile);
  assert.notEqual(conv.key, owner().key);
  await pipeline.handleIncoming(conv, { type: "message", m: { from: "", fromUuid: aciOf(ann), text: "card off", timestamp: 500, direct: false, other: true } });
  assert.deepEqual(ran.tenant, [`tenant:${ann.id}: card off`], "the owner's card kill switch is not hers to throw, and it is not an owner message");
  assert.deepEqual(ran.owner, []);
  assert.deepEqual(sent, [{ text: "tenant ok", groupId: toPerson(aciOf(ann)) }]);
  assert.deepEqual(reads, [{ ts: 500, from: aciOf(ann) }]);
  assert.deepEqual(typing.map((t) => t.groupId), [toPerson(aciOf(ann)), toPerson(aciOf(ann))]);
  assert.deepEqual(records.map((r) => [r.target, r.kind]), [[toPerson(aciOf(ann)), "owner"], [toPerson(aciOf(ann)), "chat"]]);
});

test("pipeline: the owner's own chat is untouched, and the card switch is still the owner's", async () => {
  const { sent, ran, pipeline } = rig();
  await pipeline.handleIncoming(owner(), { type: "message", m: { from: "+10000000000", text: "hello", timestamp: 600, direct: true } });
  assert.deepEqual(ran.owner, ["hello"]);
  assert.deepEqual(sent.map((s) => s.groupId), [undefined]);
  assert.equal(owner().target, undefined);
  assert.equal(owner().direct, true);
});

test("group + tenant: a tenant in a group is a member of that group; the group's memory stays the group's", async () => {
  const { sent, ran, records, pipeline } = rig();
  const g = group("signal-group-1");
  assert.equal(g.kind, "group");
  assert.equal(g.notesDir, groupNotesDir("signal-group-1"));
  assert.ok(g.notesDir.startsWith(GROUPS_DIR) && !g.notesDir.startsWith(settings.tenantsDir));
  assert.ok(!g.logFile.includes(ann.id) && g.logFile.startsWith("logs/group-"));
  await pipeline.handleIncoming(g, { type: "message", m: { from: "", fromUuid: aciOf(ann), fromName: "Ann", text: "hello group", timestamp: 700, direct: false, group: { id: "signal-group-1" }, addressedToMe: true } });
  assert.deepEqual(ran.group, ["signal-group-1: hello group"], "the group path, as for any member");
  assert.deepEqual(ran.tenant, [], "no private run for a group message");
  assert.deepEqual(sent, []);
  assert.ok(records.every((r) => r.target === undefined || r.target === "signal-group-1"), "nothing goes to her private history");
  assert.equal(readFileSync(ann.logFile, "utf8").includes("hello group"), false);
  assert.equal(speaker({ fromName: "Ann", isOwner: false }), "Ann (a member)");
  assert.ok(existsSync(groupDir("signal-group-1")));
});
