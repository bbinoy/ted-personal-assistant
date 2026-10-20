import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { classify } from "../src/policy/policy.ts";
import { settings } from "../src/settings.ts";
import { loaded, mailModule, mailProviders, mailSlot, registered } from "../src/modules/index.ts";
import { MAIL, SERVERS, mailRuntime } from "../src/modules/runtime.ts";
import type { RunContext, ToolModule } from "../src/modules/types.ts";
import { INTAKE_LINK_TOOL } from "../src/intakelinks.ts";
import { allRows, entryFor, manifest } from "../src/policy/toolmanifest.ts";
import { ownerSkills, privateSkills, sharedSkills, skillsFor } from "../src/skills.ts";
import { CAPABILITIES } from "../src/tenants.ts";

// The tool modules (src/modules): what a module is, which are loaded, what central code reads from them. The set of rows itself is pinned in
// manifestrows.test.ts; the policy, the judge and the isolation are tested where they live.

const GM = "mcp__claude_ai_Gmail__";
const MB = "mcp__mailbird__";
const names = (ms: readonly ToolModule[]) => ms.map((m) => m.name);
const CORE = ["send", "weather", "draw", "voice", "memory", "browse", "browser", "intake", "tenants", "builtin", "calendar", "notion", "drive", "docs", "claudedocs", "ibkr", "google", "notionhosted"];

test("modules: names are unique, a tool belongs to one module, and a row carries no approval flag", () => {
  const all = registered();
  assert.deepEqual(names(all).filter((n, i) => names(all).indexOf(n) !== i), []);
  const tools = allRows().map((e) => e.tool);
  assert.deepEqual(tools.filter((t, i) => tools.indexOf(t) !== i), []);
  for (const e of allRows()) assert.deepEqual(Object.keys(e).filter((k) => !["tool", "provider", "action", "cap", "only", "view", "offeredTo"].includes(k)), [], e.tool);
  for (const e of allRows()) assert.ok((CAPABILITIES as readonly string[]).includes(e.cap), `${e.tool}: ${e.cap} is a capability`);
});

test("modules: every module but the mail providers is always loaded; in the mail slot only the one MAIL_PROVIDER names, none for none", () => {
  for (const provider of ["mailbird", "gmail", "none"]) {
    const l = names(loaded(provider));
    assert.deepEqual(l.filter((n) => !mailProviders().includes(n)), CORE, provider);
    assert.deepEqual(l.filter((n) => mailProviders().includes(n)), provider === "none" ? [] : [provider], provider);
  }
  assert.deepEqual(mailProviders(), ["mailbird", "gmail"]);
  assert.equal(mailModule("none"), undefined);
  assert.equal(mailSlot("none"), undefined);
  assert.equal(mailModule("gmail")?.name, "gmail");
});

test("modules: the manifest is the rows of the loaded modules; a provider that is not loaded has no rows, so its tools are unknown (ask)", () => {
  assert.equal(entryFor(`${GM}reply`, "mailbird"), undefined);
  assert.equal(entryFor(`${MB}get_message`, "gmail"), undefined);
  assert.equal(entryFor(`${MB}get_message`, "none"), undefined);
  assert.ok(entryFor(`${GM}reply`, "gmail"));
  assert.deepEqual(manifest("none").filter((e) => e.provider === "mailbird" || e.provider === "gmail"), []);
  assert.equal(manifest("mailbird").length + allRows().filter((e) => e.provider === "gmail").length, allRows().length);
  assert.equal(classify(`${GM}reply`, {}, "chat"), "ask"); // the default provider is Mailbird: the Gmail connector's tools are unlisted
});

test("modules: a module's floor keeps restricting when it is not loaded (the Gmail rules under Mailbird)", () => {
  assert.equal(settings.mailProvider, "mailbird");
  assert.equal(classify(`${GM}apply_sensitive_message_label`, {}, "chat"), "deny");
  assert.equal(classify(`${GM}get_attachment`, {}, "chat"), "deny");
  assert.equal(classify(`${GM}unlabel_thread`, { threadId: "t", labelIds: ["INBOX"] }, "chat"), "deny"); // archiving is log-only unless the Gmail provider is live
});

test("modules: every server a module names is built under that name in runtime.ts, and runtime.ts builds no other", () => {
  const servers = registered().flatMap((m) => (m.connection.kind === "in-process" || m.connection.kind === "external" ? [m.connection.name] : []));
  assert.deepEqual([...servers].sort(), Object.keys(SERVERS).sort());
  assert.deepEqual(Object.keys(MAIL).sort(), mailProviders().sort());
  assert.ok(mailRuntime("mailbird") && mailRuntime("gmail") && !mailRuntime("none"));
  // The order the run's servers are listed in is the module order (the run-options fixture pins it for the three conversations).
  assert.deepEqual(servers.filter((s) => s !== "browser"), ["send", "weather", "draw", "voice", "memory", "browse", "intake", "tenants", "google", "notion"]);
});

const ctx = (over: Partial<RunContext> = {}): RunContext => ({ source: "chat", browsing: false, key: "owner", mode: "owner", offers: () => true, browseRun: async () => ({ text: "", costUsd: 0 }), ...over });
const when = (m: ToolModule, c: RunContext): boolean => {
  const k = m.connection;
  return k.kind === "in-process" || k.kind === "external" ? k.when(c) : false;
};
const module = (name: string) => registered().find((m) => m.name === name)!;

test("modules: each module decides from the run whether it has a server (a conversation to send to, notes, a tenant, the browse run)", () => {
  const chat = ctx({ memory: { dir: "/n" } });
  assert.equal(when(module("send"), chat), true);
  assert.equal(when(module("send"), ctx({ source: "background", key: undefined })), false, "no conversation, no send");
  assert.equal(when(module("send"), ctx({ source: "group", key: "g", offers: (t) => t !== "mcp__send__send" })), false, "a group whose capability set lacks it");
  assert.equal(when(module("memory"), chat), true);
  assert.equal(when(module("memory"), ctx({ source: "background", key: undefined })), false);
  assert.equal(when(module("browse"), ctx({ source: "brief", key: undefined })), false, "the unattended mail runs never browse");
  assert.equal(when(module("tenants"), ctx({ source: "group", key: "g" })), false, "the tenant administration is the owner's chat only");
  assert.equal(when(module("intake"), chat), false, "intake is a tenant's");
  assert.equal(when(module("browser"), chat), false, "the browser belongs to the browse run");
  assert.equal(when(module("browser"), ctx({ source: "browse", browsing: true })), false, "and needs the guard");
  // Intake asks the capability set for the tool named by the intake module itself.
  const asked: string[] = [];
  when(module("intake"), ctx({ source: "group", key: "tenant:x", tenant: {} as never, offers: (t) => (asked.push(t), true) }));
  assert.deepEqual(asked, [INTAKE_LINK_TOOL]);
  assert.ok(module("intake").rows.some((e) => e.tool === INTAKE_LINK_TOOL));
});

test("modules: a friend's own connection exists for a tenant run whose capability set offers one of the module's tools, and for nobody else", () => {
  for (const name of ["google", "notionhosted"]) {
    const m = module(name);
    const c = m.connection;
    assert.ok(c.kind === "external");
    const when = c.when;
    const tool = m.rows[0]!.tool;
    assert.equal(when(ctx({ offers: () => true })), false, `${name}: the owner's chat never has it`);
    assert.equal(when(ctx({ source: "group", key: "g", mode: "group", offers: () => true })), false, `${name}: a group never has it`);
    assert.equal(when(ctx({ source: "group", tenant: {} as never, offers: () => false })), false, `${name}: a friend whose set offers none of its tools`);
    assert.equal(when(ctx({ source: "group", tenant: {} as never, offers: (t) => t === tool })), true, `${name}: a friend whose set offers one`);
  }
});

test("modules: the mail slot answers for the provider, so central code never asks for its name", () => {
  assert.equal(typeof mailSlot("mailbird")?.handlerTask, "function"); // a provider has a handler when it says what the handler's task is
  assert.equal(typeof mailSlot("gmail")?.handlerTask, "function");
  assert.equal(mailSlot("mailbird")?.brief.delivery(), "email");
  assert.equal(mailSlot("mailbird")?.chat.skill, "ted-personal-assistant:mailbird");
  assert.equal(mailSlot("gmail")?.chat.skill, "ted-personal-assistant:gmail");
  for (const m of registered().filter((x) => x.slot === "mail")) {
    for (const e of m.rows.filter((r) => r.view)) assert.ok(m.mail?.views[e.view!], `${m.name}: ${e.tool} has a view`);
    assert.ok(m.rows.every((r) => r.cap === "mail"), `${m.name}: its tools are the mail capability`);
  }
});

test("modules: skills come from the loaded modules, in the order the owner's list always had; shared ones need a capability", () => {
  const P = (s: string) => `ted-personal-assistant:${s}`;
  const mailbird = ["daily-brief", "mailbird", "mailbird-troubleshooting", "calendar", "notion-tasks", "meeting-prep", "research-booking", "follow-through", "setup", "radar", "surf-conditions", "draw"].map(P);
  if (settings.weather && settings.draw) assert.deepEqual(ownerSkills(true, "mailbird"), mailbird);
  assert.deepEqual(ownerSkills(true, "gmail").filter((s) => /mail/.test(s)), [P("gmail")]);
  assert.ok(!ownerSkills(true, "gmail").includes(P("mailbird")));
  assert.deepEqual(ownerSkills(false, "mailbird").filter((s) => /mail/.test(s)), []);
  assert.deepEqual(ownerSkills(true, "none").filter((s) => /mail/.test(s)), []);
  assert.deepEqual(ownerSkills(true, "mailbird", { required: true }), ["daily-brief", "mailbird", "calendar", "notion-tasks", "meeting-prep", "setup"]);
  assert.deepEqual(sharedSkills(), { "research-booking": ["browse"], "surf-conditions": ["weather"], draw: ["draw"] });
  assert.deepEqual(skillsFor(new Set(["browse", "draw"] as const)), [P("research-booking"), P("draw")]);
  assert.deepEqual(skillsFor(new Set(["mail", "calendar", "notion", "chat"] as const)), []);
  for (const s of [...Object.keys(sharedSkills()), ...privateSkills()]) assert.ok(existsSync(`${settings.pluginDir}/skills/${s}/SKILL.md`), s);
});
