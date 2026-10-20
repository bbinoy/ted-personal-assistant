import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { missingSetup, setupItems, type Note } from "../src/notes.ts";
import { briefSystem, chatSystem, handlerSystem } from "../src/persona.ts";
import { settings } from "../src/settings.ts";

const skillsDir = join(settings.pluginDir, "skills");
const skills = readdirSync(skillsDir);

test("plugin: manifest is valid and every skill has a name and description matching its folder", () => {
  const manifest = JSON.parse(readFileSync(join(settings.pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "ted-personal-assistant");
  for (const s of skills) {
    const text = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
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
  for (const [skill, note] of [["calendar", "setup-calendars"], ["notion-tasks", "setup-tasks"], ["meeting-prep", "setup-meetings"], ["mailbird", "voice-writing"]] as const) {
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
  assert.match(chatSystem(undefined, new Date("2026-10-12T09:00:00"), missing), /ted-personal-assistant:setup skill\. For the Notion task list and meeting notes, find them yourself and save them, and ask .* only if you find nothing or several candidates/);
  assert.match(briefSystem("", missing), /You cannot ask anyone[\s\S]*message "set up"/);
  assert.match(handlerSystem("", { missing }), /Not set up yet/);
  assert.ok(!chatSystem(undefined, new Date(), []).includes("Not set up yet"));
});

test("setup: Notion tasks and meetings are found by the agent, saved, and only asked about when nothing or several are found; background runs never edit an unconfirmed page", () => {
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  const setup = read("setup");
  assert.match(setup, /Exactly one clear match/);
  assert.match(setup, /Several plausible matches/);
  assert.match(setup, /Nothing found/);
  for (const s of ["notion-tasks", "meeting-prep"]) {
    assert.match(read(s), /find it yourself and save it/, `${s}: discovers in chat`);
    assert.match(read(s), /(do not edit a page\s+nobody has confirmed|create no\s+pages)/, `${s}: no edits to an unconfirmed page when unattended`);
  }
});

test("connectors: detected from the tools a run saw; a missing one is reported as not connected, not as not set up", async () => {
  const { detect, disconnected, NAMES } = await import("../src/connectors.ts");
  const all = ["mcp__claude_ai_Notion__notion-fetch", "mcp__claude_ai_Google_Calendar__list_events", "mcp__mailbird__get_message"];
  assert.deepEqual(disconnected(detect(all)), []);
  assert.deepEqual(disconnected(detect(["mcp__mailbird__get_message"])), ["notion", "calendar"]);
  assert.deepEqual(disconnected(detect(all.slice(1))), ["notion"]);
  assert.deepEqual(disconnected(undefined), []); // nothing recorded yet: say nothing
  // setup items that depend on a down connector are not listed as "missing"
  const base = missingSetup([]);
  assert.equal(missingSetup([], ["calendar"]).length, base.length - 1);
  assert.equal(missingSetup([], ["notion", "calendar"]).length, base.length - 3);
  const chat = chatSystem(undefined, new Date("2026-10-12T09:00:00"), [], ["notion"]);
  assert.match(chat, /Not connected right now[\s\S]*Notion[\s\S]*Do not ask them to type in/);
  assert.match(briefSystem("", [], ["notion", "calendar"]), /🔌 Notion and Google Calendar aren't connected/);
  assert.ok(!chatSystem(undefined, new Date(), [], []).includes("Not connected"));
  assert.equal(NAMES.calendar, "Google Calendar");
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  assert.match(read("setup"), /do not\*\* ask them to type in what the connector/);
  for (const s of ["calendar", "notion-tasks", "meeting-prep"]) assert.match(read(s), /🔌/, `${s} reports a missing connector`);
});

test("connectors: judged by the server status in the start-up message, so a slow connector is not reported as missing", async () => {
  const { detect, disconnected } = await import("../src/connectors.ts");
  const server = (name: string, status: string) => ({ name, status });
  const all = [server("mailbird", "connected"), server("claude.ai Notion", "connected"), server("claude.ai Google Calendar", "connected")];
  assert.deepEqual(disconnected(detect([], all)), []); // hidden or not yet listed tools do not matter
  assert.deepEqual(disconnected(detect([], [server("mailbird", "pending"), server("claude.ai Notion", "pending"), server("claude.ai Google Calendar", "connected")])), []); // still connecting
  assert.deepEqual(disconnected(detect([], [server("claude.ai Notion", "needs-auth"), server("claude.ai Google Calendar", "failed")])), ["notion", "calendar"]);
  assert.deepEqual(disconnected(detect([], [server("mailbird", "connected"), server("claude.ai Gmail", "connected")])), ["notion", "calendar"]); // never added
});

test("plugin: follow-through is a private skill the calendar and task skills and the mail handler point to", async () => {
  const { handlerPrompt } = await import("../src/handler.ts");
  const { privateSkills } = await import("../src/skills.ts");
  assert.ok(privateSkills().includes("follow-through"));
  for (const s of ["calendar", "notion-tasks"]) assert.match(readFileSync(join(skillsDir, s, "SKILL.md"), "utf8"), /ted-personal-assistant:follow-through/, s);
  assert.match(handlerPrompt([]), /ted-personal-assistant:follow-through/);
});
