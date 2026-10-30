import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Note } from "../src/memory/notes.ts";
import { missingSetup, setupItems } from "../src/modules/index.ts";
import { chatContext, chatSystem, expertSystem } from "../src/run/persona.ts";
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
  for (const s of ["daily-brief", "mail", "mailbird", "gmail", "calendar", "tasks", "meeting-prep", "setup"]) assert.ok(skills.includes(s), s);
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
  for (const [skill, note] of [["calendar", "setup-calendars"], ["meeting-prep", "setup-meetings"], ["mail", "voice-writing"]] as const) {
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
  assert.match(chatContext({ missing }, false)!, /You cannot ask anyone[\s\S]*message "set up"/);
  assert.ok(!chatSystem().includes("Not set up yet") && !chatContext({ missing: [] })?.includes("Not set up yet"));
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
  for (const p of [chatSystem(), expertSystem("")]) {
    assert.doesNotMatch(p, /Not connected right now/);
    assert.match(p, /not in your tool list, say plainly that it is not connected[\s\S]*never assume a connector is down when its tools are present/);
  }
  assert.equal(chatContext({}), undefined);
  assert.equal(NAMES.calendar, "Google Calendar");
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  assert.match(read("setup"), /do not\*\* ask them to type in what the connector/);
  for (const s of ["calendar", "meeting-prep"]) assert.match(read(s), /🔌/, `${s} reports a missing connector`);
});

test("daily-brief skill: one archive list read from the journal, no inbox sweep, no archiving of its own briefs, no model-written delivery time", () => {
  const s = readFileSync(join(skillsDir, "daily-brief", "SKILL.md"), "utf8");
  assert.match(s, /keep only today's daily brief in the inbox and archive the older ones/);
  assert.match(s, /"Daily brief", "Evening wrap" or "Weekly review", with or without/); // matched by subject, not by emoji
  assert.doesNotMatch(s, /never archive the assistant's own brief emails/);
  const read = (n: string) => readFileSync(join(skillsDir, n, "SKILL.md"), "utf8");
  assert.match(s, /use what the looks did[\s\S]*do \*\*not\*\* list or re-sweep the inbox/); // the looks are the only triage of new mail
  assert.doesNotMatch(s, /WHOLE inbox|archive_conversation/);
  assert.match(s, /triage notes win/);
  assert.match(s, /call the `journal` tool \*\*once, early\*\*/);
  assert.match(s, /Tidied tasks: closed/); // one line of what the looks tidied, from the journal
  assert.doesNotMatch(s, /Reconcile tasks|"Reconcile" section/);
  assert.doesNotMatch(s, /prep pages for meetings that need them/); // prep pages come from the timely prep only
  assert.match(read("evening-wrap"), /no inbox sweep/);
  assert.doesNotMatch(read("evening-wrap"), /snooze|Inbox sweep/);
  assert.match(s, /written: <now, exactly as the CURRENT TIME line gives it>/); // the time comes from the clock line, never computed
});

test("the weekly review has no inbox sweep: the looks own the whole inbox, in the mail skill", () => {
  const read = (n: string) => readFileSync(join(skillsDir, n, "SKILL.md"), "utf8");
  assert.doesNotMatch(read("weekly-review"), /inbox sweep/i);
  assert.doesNotMatch(read("mail"), /Inbox sweep/);
  assert.match(read("mail"), /## Keeping the whole inbox[\s\S]*List the WHOLE inbox[\s\S]*Inbox decisions so far[\s\S]*open selectively/);
  assert.match(read("mailbird"), /WITHOUT `unreadOnly`/);
});

test("mail skills and the look: archive unless the mail needs the owner, cold outreach archived, notes win, only today's brief kept", async () => {
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  const mb = read("mail");
  assert.match(mb, /Anything automated[\s\S]*is archived, from the row when it is clear[\s\S]*failing\s+its job/);
  assert.match(mb, /## For every run that handles mail[\s\S]*Today's daily brief stays in the inbox; every older brief, wrap and review\s+is archived/);
  assert.match(mb, /A real conversation stays, read or unread, however old/); // the sweep never archives a live thread with a person
  assert.match(mb, /Cold outreach is noise even when a named person wrote it/);
  assert.match(mb, /A completed task closes its mail/);
  assert.match(mb, /A series keeps only its newest mail/);
  assert.doesNotMatch(mb, /Old briefs are never archived/);
  assert.match(mb, /archive unless the mail needs the owner[\s\S]*next 7 days[\s\S]*For automated mail, unread is not a reason to keep/);
  assert.match(mb, /Cold outreach is noise even when a named person wrote it[\s\S]*"important" flag[\s\S]*open the mail \(a plain read, cheap\)\s+before deciding/);
  assert.match(mb, /triage notes win/);
  const hb = readFileSync(join(import.meta.dirname, "..", "assistants", "ted", "persona", "background.md"), "utf8");
  assert.match(hb, /Decision log: in the "triage" part of your final answer/); // the persona points at the skill; the rules live in the skill (asserted above)
  assert.match(mb, /Reading is a plain read: free, not judged, with no cap[\s\S]*not\s+confident, open the full mail[\s\S]*Never keep a mail\s+just because you did not read it/);
  assert.doesNotMatch(mb, /Do NOT open every email|archive newsletters unopened/);
  for (const provider of ["mailbird", "gmail"]) assert.ok(read(provider).split("\n").length < 90 && !/archive unless the mail needs the owner/.test(read(provider)), `${provider}: tools and quirks only, the rules are in the mail skill`);
});

test("a long overdue pile: the task skill snoozes the stale tail and says so in one line", () => {
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  assert.match(read("tasks"), /A long overdue pile[\s\S]*snooze_task[\s\S]*reopen[\s\S]*one line/);
  assert.doesNotMatch(read("daily-brief") + read("tasks"), /status-overdue-offer/);
});

test("task reconcile: defined once in the task skill; the brief and the weekly review point to it; the wrap does not", () => {
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  assert.match(read("tasks"), /## Reconcile[\s\S]*complete_task[\s\S]*Merge[\s\S]*Move[\s\S]*Drop[\s\S]*reopen/);
  assert.match(read("weekly-review"), /"Reconcile" section/);
  const bg = readFileSync(join(import.meta.dirname, "..", "assistants", "ted", "persona", "background.md"), "utf8");
  assert.match(bg, /continuously: apply the tasks skill's "Reconcile" section/); // the looks reconcile
  assert.doesNotMatch(read("weekly-review"), /finish no task/);
  assert.doesNotMatch(read("evening-wrap"), /Reconcile/);
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
  for (const s of ["calendar", "tasks"]) assert.match(readFileSync(join(skillsDir, s, "SKILL.md"), "utf8"), /ted-personal-assistant:follow-through/, s);
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
