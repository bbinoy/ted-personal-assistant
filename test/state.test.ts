import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { overBudget, recordCost, spentToday } from "../src/budget.ts";
import { loadSettings, settings, signalIdentity } from "../src/settings.ts";
import { checkHideSettings, registered } from "../src/modules/index.ts";
import { appendLine, dataPath, readJson, readText, secureDataDirs, writeJson, writeText } from "../src/state.ts";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

test("tests run against a throwaway data directory, never the real one", () => {
  assert.ok(process.env.HARNESS_DATA_DIR, "npm test sets HARNESS_DATA_DIR");
  assert.equal(settings.dataDir, resolve(process.env.HARNESS_DATA_DIR!));
  assert.ok(!existsSync(join(settings.dataDir, "src")), "the data root is not the repo");
});

test("settings: three folders under HARNESS_DATA_DIR, default is the repo root", () => {
  const s = loadSettings({ HARNESS_DATA_DIR: "/tmp/x-data" });
  assert.deepEqual([s.dataDir, s.stateDir, s.logsDir, s.memoryDir], ["/tmp/x-data", "/tmp/x-data/state", "/tmp/x-data/logs", "/tmp/x-data/memory"]);
  const d = loadSettings({});
  assert.ok(!d.dataDir.endsWith("/src") && d.stateDir === join(d.dataDir, "state"));
  assert.ok(existsSync(join(d.dataDir, "src")), "default data root is the parent of src/");
});

test("settings: chat session rules are validated", () => {
  const d = loadSettings({});
  assert.equal(d.chatCompactTokens, 150_000);
  assert.throws(() => loadSettings({ CHAT_COMPACT_TOKENS: "9999" }), /CHAT_COMPACT_TOKENS/);
  assert.throws(() => loadSettings({ CHAT_COMPACT_TOKENS: "500001" }), /CHAT_COMPACT_TOKENS/);
  assert.equal(loadSettings({ CHAT_COMPACT_TOKENS: "10000" }).chatCompactTokens, 10_000);
});

test("state: JSON round-trips, owner-only, no temp files left behind", () => {
  writeJson("state/t.json", { a: 1 });
  assert.deepEqual(readJson("state/t.json", null), { a: 1 });
  assert.equal(statSync(dataPath("state/t.json")).mode & 0o777, 0o600);
  assert.equal(readdirSync(settings.stateDir).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("state: all three folders are 700 and their files 600; paths outside them are refused", () => {
  writeText("logs/t.log", "x");
  appendLine("logs/t.log", "y");
  writeText("memory/t.md", "x");
  chmodSync(dataPath("memory/t.md"), 0o644);
  mkdirSync(join(settings.memoryDir, "sub"), { recursive: true }); // a folder inside is left to its owner, only files are tightened
  secureDataDirs();
  for (const d of [settings.stateDir, settings.logsDir, settings.memoryDir]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  assert.equal(statSync(dataPath("memory/t.md")).mode & 0o777, 0o600);
  assert.equal(readText("logs/t.log"), "xy\n");
  // a group's session pointer lives in its own folder: an absolute path is fine inside the data root, never outside
  writeJson(join(settings.memoryDir, "groups", "k", "session.json"), { a: 1 });
  assert.deepEqual(readJson(join(settings.memoryDir, "groups", "k", "session.json"), {}), { a: 1 });
  assert.throws(() => dataPath(join(settings.dataDir, "..", "elsewhere.json")), /not a path/);
  assert.throws(() => dataPath("/etc/passwd"), /not a path/);
  for (const bad of ["seen.json", "other/x.json", "state/../x", "state/.hidden", "state/a/b"]) assert.throws(() => dataPath(bad), /not a path/, bad);
});

test("state: a missing or corrupt file falls back to the default", () => {
  assert.deepEqual(readJson("state/missing.json", { d: true }), { d: true });
  writeText("state/bad.json", "{not json");
  assert.deepEqual(readJson("state/bad.json", { d: true }), { d: true });
});

test("budget: costs accumulate and the over-budget notice fires once", () => {
  const start = spentToday();
  recordCost(1.25);
  recordCost(0.75);
  recordCost(-5); // ignored
  assert.equal(spentToday(), start + 2);
  recordCost(settings.dailyBudgetUsd);
  assert.deepEqual([overBudget().over, overBudget().firstTime], [true, false]); // first call consumed the notice
});

test("settings: defaults, and typos fail loudly instead of becoming NaN", () => {
  const d = loadSettings({});
  assert.equal(d.heartbeatMinutes, 5);
  assert.deepEqual([d.heartbeatModel, d.heartbeatDayMinutes], ["haiku", 30]);
  assert.equal(loadSettings({ HEARTBEAT_MODEL: "sonnet" }).heartbeatModel, "sonnet");
  assert.equal(d.signalHost, "127.0.0.1");
  assert.throws(() => loadSettings({ HEARTBEAT_MINUTES: "abc" }), /HEARTBEAT_MINUTES/);
  assert.throws(() => loadSettings({ HEARTBEAT_MINUTES: "0" }), /HEARTBEAT_MINUTES/);
  assert.throws(() => loadSettings({ QUIET_START_HOUR: "24" }), /QUIET_START_HOUR/);
  // the archive switch and its three older forms are gone: archiving is always live, and a line left in .env stops the agent instead of silently ending a trial week
  for (const old of ["ARCHIVE", "HEARTBEAT_ACTIONS", "GMAIL_ARCHIVE_LIVE", "GOOGLE_ARCHIVE_LIVE"]) assert.throws(() => loadSettings({ [old]: "log" }), new RegExp(`${old} is gone: archiving is always live`));
});

test("settings: the tool-hiding lists have safe defaults and reject typos", () => {
  const d = loadSettings({});
  assert.ok(d.hiddenConnectors.includes("mcp__claude_ai_Interactive_Brokers_IBKR"));
  assert.deepEqual(d.visibleTools, {}, "the defaults are the modules' own (their `hide.visible`)");
  assert.deepEqual(registered().find((m) => m.name === "notion")!.hide!.visible, ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"]);
  assert.deepEqual(loadSettings({ NOTION_TOOLS: "notion-fetch, notion-search" }).visibleTools, { notion: ["notion-fetch", "notion-search"] });
  const mb = registered().find((m) => m.name === "mailbird")!.hide!.visible;
  assert.ok(mb.includes("get_message") && !mb.includes("snooze_conversation"));
  // one <MODULE>_TOOLS setting per module, named after it, checked against the module's own pattern
  assert.throws(() => loadSettings({ MAILBIRD_TOOLS: "Get-Message" }), /MAILBIRD_TOOLS/);
  assert.throws(() => checkHideSettings(loadSettings({ NOTION_TOOLS: "fetch" }).visibleTools), /NOTION_TOOLS: "fetch" is not a Notion tool name/);
  assert.throws(() => checkHideSettings(loadSettings({ GMAIL_TOOLS: "Get_Thread" }).visibleTools), /GMAIL_TOOLS/);
  assert.doesNotThrow(() => checkHideSettings(loadSettings({ GMAIL_TOOLS: "get_thread", SOME_OTHER_TOOLS: "x" }).visibleTools));
  assert.throws(() => loadSettings({ HIDDEN_CONNECTORS: "Gmail" }), /HIDDEN_CONNECTORS/);
});

test("settings: the credential mode and the Signal identity are settings too (the old config module is gone)", () => {
  assert.equal(loadSettings({}).credential, "login");
  assert.equal(loadSettings({ HARNESS_AUTH: "token", CLAUDE_CODE_OAUTH_TOKEN: "t" }).credential, "token");
  assert.throws(() => loadSettings({ HARNESS_AUTH: "token" }), /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.throws(() => loadSettings({ HARNESS_AUTH: "api-key" }), /ANTHROPIC_API_KEY/);
  assert.throws(() => loadSettings({ HARNESS_AUTH: "magic" }), /HARNESS_AUTH must be one of login, token, api-key/);
  assert.throws(() => signalIdentity(loadSettings({})), /SIGNAL_OWNER_NUMBER/);
  assert.deepEqual(signalIdentity(loadSettings({ SIGNAL_OWNER_NUMBER: "+10000000001" })), { ownerNumber: "+10000000001", account: "+10000000001", ownerAci: undefined });
  const own = signalIdentity(loadSettings({ SIGNAL_OWNER_NUMBER: "+10000000001", SIGNAL_ACCOUNT: " +10000000002 ", SIGNAL_OWNER_ACI: "x" }));
  assert.deepEqual([own.account, own.ownerAci], ["+10000000002", "x"]);
});
