import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Note } from "../src/memory/notes.ts";
import { missingSetup, setupItems } from "../src/modules/index.ts";
import { chatContext, chatSystem, expertSystem, heartbeatSystem } from "../src/run/persona.ts";
import { settings } from "../src/core/settings.ts";

const skillsDir = join(settings.pluginDir, "skills");
const skills = readdirSync(skillsDir);

test("plugin: manifest is valid and every skill has a name and description matching its folder", () => {
  const manifest = JSON.parse(readFileSync(join(settings.pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "ted-personal-assistant");
  for (const s of skills) {
    const text = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
    const front = /^---\nname: (.+)\ndescription: (.+)\n(?:[a-z-]+: .*\n)*---\n/.exec(text);
    assert.ok(front, `${s}: front matter`);
    assert.equal(front![1], s, `${s}: name matches folder`);
  }
  for (const s of ["daily-brief", "mailbird", "mailbird-troubleshooting", "calendar", "notion-tasks", "meeting-prep", "setup"]) assert.ok(skills.includes(s), s);
});

test("plugin: skills hold no personal details, only references to the owner's notes", () => {
  for (const s of skills) {
    const text = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /TODO\(owner\)/, `${s}: unfilled template marker`);
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, `${s}: an email address`);
    assert.doesNotMatch(text, /notion\.(com|so)\/[\w-]*[0-9a-f]{20,}/i, `${s}: a Notion page id`);
    assert.doesNotMatch(text, /\[\[/, `${s}: wiki-link instead of a namespaced skill name`);
  }
});

test("plugin: every skill that needs setup names the note it reads, and setup saves under those names", () => {
  const setup = readFileSync(join(skillsDir, "setup", "SKILL.md"), "utf8");
  for (const item of setupItems()) assert.ok(setup.includes(item.file), `setup skill saves ${item.file}`);
  for (const [skill, note] of [["calendar", "setup-calendars"], ["task-import", "setup-tasks"], ["meeting-prep", "setup-meetings"], ["mailbird", "voice-writing"]] as const) {
    assert.ok(readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8").includes(note), `${skill} reads ${note}`);
  }
  assert.ok(existsSync(join(settings.pluginDir, ".claude-plugin", "plugin.json")));
});

test("setup: missing items are listed, in prompts as an offer in chat and a skip-and-say elsewhere", () => {
  const note = (file: string): Note => ({ file, category: file.startsWith("voice") ? "voice" : "setup", text: "x" });
  assert.equal(missingSetup([]).length, setupItems().length);
  assert.deepEqual(missingSetup(setupItems().map((i) => note(i.file))), []);
  assert.equal(missingSetup([note("setup-calendars.md")]).length, setupItems().length - 1);
  const missing = missingSetup([]);
  assert.match(chatContext({ missing })!, /ted-personal-assistant:setup skill\. For the meeting notes, find them yourself and save them, and ask .* only if you find nothing or several candidates/);
  assert.match(heartbeatSystem("", { missing }), /You cannot ask anyone[\s\S]*message "set up"/);
  assert.ok(!chatSystem(new Date()).includes("Not set up yet") && !chatContext({ missing: [] })?.includes("Not set up yet"));
});

test("setup: Notion tasks and meetings are found by the agent, saved, and only asked about when nothing or several are found; background runs never edit an unconfirmed page", () => {
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  const setup = read("setup");
  assert.match(setup, /Exactly one clear match/);
  assert.match(setup, /Several plausible matches/);
  assert.match(setup, /Nothing found/);
  for (const s of ["meeting-prep"]) {
    assert.match(read(s), /find it yourself and save it/, `${s}: discovers in chat`);
    assert.match(read(s), /(do not edit a page\s+nobody has confirmed|create no\s+pages)/, `${s}: no edits to an unconfirmed page when unattended`);
  }
});

test("connectors: detected from the tools a run saw; a missing one is reported as not connected, not as not set up", async () => {
  const { detect, disconnected, NAMES } = await import("../src/modules/connectors.ts");
  const all = ["mcp__claude_ai_Notion__notion-fetch", "mcp__claude_ai_Google_Calendar__list_events", "mcp__mailbird__get_message", "mcp__claude_ai_Google_Drive__search_files", "mcp__claude_ai_Google_Docs__read_doc"];
  assert.deepEqual(disconnected(detect(all)), []);
  assert.deepEqual(disconnected(detect(["mcp__mailbird__get_message"])), ["notion", "calendar"]); // (Drive and Docs are optional: never seen working, never reported down)
  assert.deepEqual(disconnected(detect(all.slice(1))), ["notion"]);
  assert.deepEqual(disconnected(undefined), []); // nothing recorded yet: say nothing
  // setup items that depend on a down connector are not listed as "missing"
  const base = missingSetup([]);
  assert.equal(missingSetup([], ["calendar"]).length, base.length - 1);
  assert.equal(missingSetup([], ["notion", "calendar"]).length, base.length - 2);
  // the recorded state never reaches a prompt (it can be stale): the run is told to trust its own tool list
  for (const p of [chatSystem(new Date()), heartbeatSystem(""), expertSystem("")]) {
    assert.doesNotMatch(p, /Not connected right now/);
    assert.match(p, /not in your tool list, say plainly that it is not connected[\s\S]*never assume a connector is down when its tools are present/);
  }
  assert.equal(chatContext({}), undefined);
  assert.equal(NAMES.calendar, "Google Calendar");
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  assert.match(read("setup"), /do not\*\* ask them to type in what the connector/);
  for (const s of ["calendar", "meeting-prep"]) assert.match(read(s), /🔌/, `${s} reports a missing connector`);
});

test("daily-brief skill: one archive list read after the sweep, no archiving of its own briefs, no model-written delivery time", () => {
  const s = readFileSync(join(skillsDir, "daily-brief", "SKILL.md"), "utf8");
  assert.match(s, /never archive the assistant's own brief emails/);
  assert.match(s, /after the email sweep, just before you write the brief\*\*, so the list includes what this very run archived/);
  assert.match(s, /no time of your own: the code stamps the real write time/);
});

test("a long overdue pile: the brief offers a clean-up once (remembered in the status note), the task skill says how", () => {
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  assert.match(read("notion-tasks"), /A long overdue pile[\s\S]*\*\*once\*\*[\s\S]*reschedule, drop or keep[\s\S]*Nothing is dropped without their word/);
  assert.match(read("daily-brief"), /A long overdue pile[\s\S]*status-overdue-offer[\s\S]*name `overdue-offer`, `days` 30/);
});

test("connectors: a run that started without a network records nothing", async () => {
  const { recordConnectors, readConnectors, offline } = await import("../src/modules/connectors.ts");
  const server = (name: string, status: string) => ({ name, status });
  recordConnectors([], [server("claude.ai Notion", "connected"), server("claude.ai Google Calendar", "connected")]);
  const before = readConnectors();
  assert.equal(before?.notion, true);
  const woken = [server("mailbird", "connected"), server("claude.ai Notion", "failed"), server("claude.ai Google Calendar", "failed")];
  assert.equal(offline(woken), true);
  recordConnectors([], woken);
  assert.deepEqual(readConnectors(), before, "everything failed together: the Mac was offline, the record stays");
  assert.equal(offline([server("claude.ai Notion", "needs-auth"), server("claude.ai Google Calendar", "failed")]), false, "one needs sign-in: a real problem");
  recordConnectors([], [server("claude.ai Notion", "needs-auth"), server("claude.ai Google Calendar", "connected")]);
  assert.equal(readConnectors()?.notion, false);
});

test("connectors: judged by the server status in the start-up message, so a slow connector is not reported as missing", async () => {
  const { detect, disconnected } = await import("../src/modules/connectors.ts");
  const server = (name: string, status: string) => ({ name, status });
  const drive = [server("claude.ai Google Drive", "connected"), server("claude.ai Google Docs", "connected")];
  const all = [server("mailbird", "connected"), server("claude.ai Notion", "connected"), server("claude.ai Google Calendar", "connected"), ...drive];
  assert.deepEqual(disconnected(detect([], all)), []); // hidden or not yet listed tools do not matter
  assert.deepEqual(disconnected(detect([], [server("mailbird", "pending"), server("claude.ai Notion", "pending"), server("claude.ai Google Calendar", "connected"), ...drive])), []); // still connecting
  assert.deepEqual(disconnected(detect([], [server("claude.ai Notion", "needs-auth"), server("claude.ai Google Calendar", "failed"), ...drive])), ["notion", "calendar"]);
  assert.deepEqual(disconnected(detect([], [server("mailbird", "connected"), server("claude.ai Gmail", "connected"), ...drive])), ["notion", "calendar"]); // never added
});

test("plugin: follow-through is a private skill the calendar and task skills point to", async () => {
  const { privateSkills } = await import("../src/modules/skills.ts");
  assert.ok(privateSkills().includes("follow-through"));
  for (const s of ["calendar", "notion-tasks"]) assert.match(readFileSync(join(skillsDir, s, "SKILL.md"), "utf8"), /ted-personal-assistant:follow-through/, s);
});

test("connectors: an optional connector (Drive, Docs) is down only after a run saw it working; the doctor's seen list is recorded by recordConnectors", async () => {
  const { detect, disconnected, recordConnectors, readSeen } = await import("../src/modules/connectors.ts");
  const none = detect([], [{ name: "claude.ai Notion", status: "connected" }, { name: "claude.ai Google Calendar", status: "connected" }]);
  assert.deepEqual(disconnected(none, []), [], "never connected: nothing to nag about");
  assert.deepEqual(disconnected(none, ["drive", "docs"]), ["drive", "docs"], "it worked once and is gone: reported");
  const calendarGone = detect([], [{ name: "claude.ai Notion", status: "connected" }]);
  assert.deepEqual(disconnected(calendarGone, []), ["calendar"], "Notion and Calendar keep reporting as before");
  recordConnectors([], [{ name: "claude.ai Google Drive", status: "connected" }]);
  assert.ok(readSeen().includes("drive") && !readSeen().includes("docs"));
});
