import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { classify } from "../src/policy/policy.ts";
import { settings } from "../src/core/settings.ts";
import { loaded, mailModule, mailProviders, mailSlot, registered } from "../src/modules/index.ts";
import { MAIL, RUNTIME, mailRuntime } from "../src/modules/runtime.ts";
import type { RunContext, ToolModule } from "../src/modules/types.ts";
import { INTAKE_LINK_TOOL } from "../src/intake/intakelinks.ts";
import { allRows, entryFor, manifest } from "../src/policy/toolmanifest.ts";
import { ownerSkills, privateSkills, sharedSkills, skillsFor } from "../src/modules/skills.ts";
import { CAPABILITIES } from "../src/tenants/tenants.ts";
import { capabilitiesOf, groupCapabilities, toolsFor } from "../src/policy/capabilities.ts";
import { BROWSE_RUN, GROUP_CHAT, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

// The tool modules (src/modules): what a module is, which are loaded, what central code reads from them. The set of rows itself is pinned in
// manifestrows.test.ts; the policy, the judge and the isolation are tested where they live.

const GM = "mcp__claude_ai_Gmail__";
const MB = "mcp__mailbird__";
const names = (ms: readonly ToolModule[]) => ms.map((m) => m.name);
const CORE = ["send", "weather", "draw", "tasks", "voice", "memory", "people", "seenmail", "meetings", "browse", "browser", "intake", "tenants", "builtin", "calendar", "notion", "drive", "docs", "claudedocs", "ibkr", "google", "notionhosted"];

test("modules: names are unique, a tool belongs to one module, and a row carries no approval flag", () => {
  const all = registered();
  assert.deepEqual(names(all).filter((n, i) => names(all).indexOf(n) !== i), []);
  const tools = allRows().map((e) => e.tool);
  assert.deepEqual(tools.filter((t, i) => tools.indexOf(t) !== i), []);
  for (const e of allRows()) assert.deepEqual(Object.keys(e).filter((k) => !["tool", "provider", "action", "cap", "attended", "who", "view"].includes(k)), [], e.tool);
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
  assert.equal(classify(`${GM}reply`, {}, OWNER_CHAT), "ask"); // the default provider is Mailbird: the Gmail connector's tools are unlisted
});

test("modules: a module's floor keeps restricting when it is not loaded (the Gmail rules under Mailbird)", () => {
  assert.equal(settings.mailProvider, "mailbird");
  assert.equal(classify(`${GM}apply_sensitive_message_label`, {}, OWNER_CHAT), "deny");
  assert.equal(classify(`${GM}get_attachment`, {}, OWNER_CHAT), "deny");
  assert.equal(classify(`${GM}unlabel_thread`, { threadId: "t", labelIds: ["INBOX"] }, OWNER_CHAT), "deny"); // an archive is the Gmail provider's: refused under Mailbird
});

test("modules: every module that names a server has its server in runtime.ts (RUNTIME, by the module's name), and runtime.ts has no entry for a module that does not exist", () => {
  const withServer = registered().filter((m) => m.connection.kind === "in-process" || m.connection.kind === "external");
  const servers = withServer.map((m) => (m.connection as { name: string }).name);
  for (const m of withServer) assert.equal(typeof RUNTIME[m.name]?.server, "function", `module ${m.name} has no server factory`);
  assert.deepEqual(withServer.map((m) => m.name).sort(), Object.entries(RUNTIME).filter(([, r]) => r.server).map(([name]) => name).sort(), "a server factory for no module");
  assert.deepEqual(Object.keys(RUNTIME).filter((name) => !registered().some((m) => m.name === name)), [], "a runtime entry for no module");
  for (const m of registered().filter((m) => RUNTIME[m.name]?.lifecycle)) assert.ok(m.connection.kind === "external", `${m.name}: only a separate server or connection outlives a run`);
  assert.deepEqual(Object.keys(MAIL).sort(), mailProviders().sort());
  assert.ok(mailRuntime("mailbird") && mailRuntime("gmail") && !mailRuntime("none"));
  // The order the run's servers are listed in is the module order (the run-options fixture pins it for the three conversations).
  assert.deepEqual(servers.filter((s) => s !== "browser"), ["send", "weather", "draw", "tasks", "voice", "memory", "people", "seenmail", "meetings", "browse", "intake", "tenants", "google", "notion"]);
});

// What a run offers: its conversation's capabilities, less what attendance removes (capabilities.ts toolsFor), as buildOptions hands it to the modules.
const offersOf = (run: typeof OWNER_CHAT): RunContext["offers"] => {
  const tools = toolsFor(run.who === "owner" ? capabilitiesOf({ kind: "owner" }) : groupCapabilities(), run);
  return (t) => tools.has(t);
};
const ctx = (over: Partial<RunContext> = {}): RunContext => ({ kind: OWNER_CHAT, browsing: false, key: "owner", mode: "owner", offers: offersOf(over.kind ?? OWNER_CHAT), browseRun: async () => ({ text: "", costUsd: 0 }), ...over });
const when = (m: ToolModule, c: RunContext): boolean => {
  const k = m.connection;
  return k.kind === "in-process" || k.kind === "external" ? k.when(c) : false;
};
const module = (name: string) => registered().find((m) => m.name === name)!;

test("modules: each module decides from the run whether it has a server (a conversation to send to, notes, a tenant, the browse run)", () => {
  const chat = ctx({ memory: { dir: "/n" } });
  assert.equal(when(module("send"), chat), true);
  assert.equal(when(module("send"), ctx({ kind: OWNER_LOOK })), true, "the owner's look speaks in her chat, like any conversation's");
  assert.equal(when(module("send"), ctx({ kind: OWNER_LOOK, key: undefined })), false, "no conversation, no send");
  assert.equal(when(module("seenmail"), ctx({ kind: OWNER_LOOK })), false, "no tracker, no seen_mail");
  assert.equal(when(module("seenmail"), ctx({ kind: OWNER_LOOK, seenMail: {} as never })), true, "a heartbeat run of a conversation with mail");
  assert.equal(when(module("send"), ctx({ kind: GROUP_CHAT, key: "g", offers: (t) => t !== "mcp__send__send" })), false, "a group whose capability set lacks it");
  assert.equal(when(module("memory"), chat), true);
  assert.equal(when(module("memory"), ctx({ kind: OWNER_LOOK })), false, "no notes of its own, no memory server");
  assert.equal(when(module("memory"), ctx({ kind: OWNER_LOOK, memory: { dir: "/n" } })), true, "a look has the same memory server as a chat turn");
  assert.equal(when(module("browse"), ctx({ kind: OWNER_LOOK })), true, "a look may browse; its worker never has the owner's card or saved details (browse.ts), and nothing is asked");
  assert.equal(when(module("tenants"), ctx({ kind: GROUP_CHAT, key: "g" })), false, "the tenant administration is the owner's chat only");
  assert.equal(when(module("tenants"), ctx({ kind: OWNER_LOOK })), false, "and not her look");
  assert.equal(when(module("intake"), chat), false, "intake is a tenant's");
  assert.equal(when(module("browser"), chat), false, "the browser belongs to the browse run");
  assert.equal(when(module("browser"), ctx({ kind: BROWSE_RUN, browsing: true })), false, "and needs the guard");
  // Intake asks the capability set for the tool named by the intake module itself.
  const asked: string[] = [];
  when(module("intake"), ctx({ kind: GROUP_CHAT, key: "tenant:x", tenant: {} as never, offers: (t) => (asked.push(t), true) }));
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
    assert.equal(when(ctx({ kind: GROUP_CHAT, key: "g", mode: "group", offers: () => true })), false, `${name}: a group never has it`);
    assert.equal(when(ctx({ kind: GROUP_CHAT, tenant: {} as never, offers: () => false })), false, `${name}: a friend whose set offers none of its tools`);
    assert.equal(when(ctx({ kind: GROUP_CHAT, tenant: {} as never, offers: (t) => t === tool })), true, `${name}: a friend whose set offers one`);
  }
});

test("modules: the mail slot answers for the provider, so central code never asks for its name", () => {
  assert.match(mailSlot("mailbird")?.brief.how() ?? "", /send_self_briefing/);
  assert.equal(mailSlot("mailbird")?.chat.skill, "ted-personal-assistant:mailbird");
  assert.equal(mailSlot("gmail")?.chat.skill, "ted-personal-assistant:gmail");
  for (const m of registered().filter((x) => x.slot === "mail")) {
    for (const e of m.rows.filter((r) => r.view)) assert.ok(m.mail?.views[e.view!], `${m.name}: ${e.tool} has a view`);
    assert.ok(m.rows.every((r) => r.cap === "mail"), `${m.name}: its tools are the mail capability`);
  }
});

test("modules: skills come from the loaded modules, in the order the owner's list always had; shared ones need a capability", () => {
  const P = (s: string) => `ted-personal-assistant:${s}`;
  const mailbird = ["daily-brief", "mail", "mailbird", "calendar", "tasks", "meeting-prep", "research-booking", "web-research", "follow-through", "stay-in-touch", "setup", "surf-conditions", "draw", "evening-wrap", "weekly-review"].map(P);
  if (settings.weather && settings.draw) assert.deepEqual(ownerSkills(true, "mailbird"), mailbird);
  assert.deepEqual(ownerSkills(true, "gmail").filter((s) => /mail/.test(s)), [P("mail"), P("gmail")]);
  assert.ok(!ownerSkills(true, "gmail").includes(P("mailbird")));
  assert.deepEqual(ownerSkills(false, "mailbird").filter((s) => /mail/.test(s)), []);
  assert.deepEqual(ownerSkills(true, "none").filter((s) => /mail/.test(s)), []);
  assert.deepEqual(ownerSkills(true, "mailbird", { required: true }), ["daily-brief", "mail", "mailbird", "calendar", "tasks", "meeting-prep", "setup"]);
  assert.deepEqual(sharedSkills(), { "web-research": ["chat"], "research-booking": ["browse"], "surf-conditions": ["weather"], draw: ["draw"] });
  assert.deepEqual(skillsFor(new Set(["browse", "draw"] as const)), [P("research-booking"), P("draw")]);
  assert.deepEqual(skillsFor(new Set(["mail", "calendar", "notion", "chat"] as const)), [P("web-research")]);
  for (const s of [...Object.keys(sharedSkills()), ...privateSkills()]) assert.ok(existsSync(`${settings.pluginDir}/skills/${s}/SKILL.md`), s);
});

test("connectors: which are reported down comes from the loaded modules' connections (key, label, skipped), not from a list in connectors.ts", async () => {
  const { detect, disconnected, reportable, NAMES, SKIPPED } = await import("../src/modules/connectors.ts");
  const keys = () => reportable().map((r) => r.key);
  assert.deepEqual(keys(), ["notion", "calendar", "drive", "docs"], "under Mailbird: the two the owner has always been told about, then Drive and Docs (visible by default); Gmail's connector is not loaded");
  const s = settings as unknown as Record<string, unknown>;
  const was = { mailProvider: s.mailProvider, hiddenConnectors: s.hiddenConnectors };
  try {
    s.mailProvider = "gmail";
    assert.deepEqual(keys(), ["notion", "calendar", "drive", "docs", "gmail"]);
    const up = (name: string) => ({ name: `claude.ai ${name}`, status: "connected" });
    assert.deepEqual(disconnected(detect([], [up("Notion"), up("Google Calendar"), up("Google Drive"), up("Google Docs")])), ["gmail"], "a Gmail outage reaches the prompts and the brief");
    assert.deepEqual(disconnected(detect([], [up("Notion"), up("Google Calendar"), up("Google Drive"), up("Google Docs"), up("Gmail")])), []);
    assert.equal(NAMES.gmail, "Gmail");
    assert.match(SKIPPED.gmail!, /mail pass/);
    const mixed = detect([], [up("Notion"), up("Google Calendar"), up("Gmail"), up("Google Docs")]);
    assert.deepEqual(disconnected(mixed, []), [], "optional Drive was never seen working: silently absent");
    assert.deepEqual(disconnected(mixed, ["drive", "docs"]), ["drive"], "Drive was seen working before and is down now; Docs is up");
    s.hiddenConnectors = [...(s.hiddenConnectors as string[]), "mcp__claude_ai_Google_Drive", "mcp__claude_ai_Google_Docs"]; // the owner hid Drive and Docs again
    assert.deepEqual(keys(), ["notion", "calendar", "gmail"], "a hidden connector is no outage to talk about");
  } finally {
    Object.assign(s, was);
  }
  // Every connector module that is reported says what it is called and what is lost.
  for (const m of registered()) if (m.connection.kind === "connector" && m.connection.skipped) assert.ok(m.connection.key && m.connection.label, `${m.name}: key and label`);
});
