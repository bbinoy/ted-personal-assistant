import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSISTANTS_DIR, loadPreset, parseTemplate, presetFor, PROMPTS, render } from "../src/preset.ts";
import { chatSystem, dreamSystem, groupSystem, PERSONALITY } from "../src/persona.ts";
import { PROFILES } from "../src/profiles.ts";
import { CATEGORIES } from "../src/notes.ts";
import { settings } from "../src/settings.ts";

// The assistant preset (assistants/<name>/, src/preset.ts): what makes the harness "Ted" is data. It loads and is checked, a broken one says what is
// wrong, the prompts built from it are the stored ones, and a second preset changes the personality and the rhythm without touching code.

const TED = join(ASSISTANTS_DIR, "ted");
const scratch = mkdtempSync(join(tmpdir(), "preset-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

// A copy of ted's preset that a test may break.
function copyOfTed(change: (dir: string, json: Record<string, any>) => void): string {
  const dir = join(scratch, `p${n++}`);
  cpSync(TED, dir, { recursive: true });
  const json = JSON.parse(readFileSync(join(dir, "preset.json"), "utf8"));
  change(dir, json);
  writeFileSync(join(dir, "preset.json"), JSON.stringify(json));
  return dir;
}

test("ted's preset loads: the rhythm, the note categories, the profile limits, the skills and a text for every prompt", () => {
  const p = loadPreset(TED);
  assert.equal(p.name, "ted");
  assert.deepEqual(p.rhythm, {
    heartbeat: { everyMinutes: 15, quietFromHour: 22, quietToHour: 7 },
    brief: { skill: "daily-brief", startHour: 7, backstopHour: 9, maxAttempts: 3 },
    radar: { skill: "radar", enabled: true, everyMinutes: 180 },
    dream: { enabled: true, minNewLines: { direct: 1, group: 3 }, maxGroupsPerNight: 5 },
  });
  assert.deepEqual(p.notes.categories, ["triage", "people", "scheduling", "context", "brief", "style", "setup", "voice"]);
  assert.deepEqual(Object.keys(p.profiles).sort(), ["background", "brief", "chat", "group", "handler", "radar"]);
  assert.deepEqual(Object.keys(p.persona).sort(), Object.keys(PROMPTS).sort());
  assert.deepEqual(p.skills.core.map((s) => s.name), ["daily-brief", "meeting-prep", "follow-through", "setup", "radar"]);
  assert.strictEqual(presetFor({}), presetFor({ ASSISTANT_PRESET: "ted" }), "ted is the default, loaded once");
});

test("the code reads the preset: settings defaults, profiles, note categories", () => {
  const p = presetFor();
  assert.deepEqual([settings.briefStartHour, settings.briefBackstopHour, settings.briefMaxAttempts, settings.radarMinutes, settings.heartbeatMinutes, settings.quietStartHour, settings.quietEndHour],
    [p.rhythm.brief.startHour, p.rhythm.brief.backstopHour, p.rhythm.brief.maxAttempts, p.rhythm.radar.everyMinutes, p.rhythm.heartbeat.everyMinutes, p.rhythm.heartbeat.quietFromHour, p.rhythm.heartbeat.quietToHour]);
  for (const k of ["brief", "radar", "background", "group"] as const) assert.deepEqual([PROFILES[k].maxTurns, PROFILES[k].maxBudgetUsd, PROFILES[k].notes], [p.profiles[k].maxTurns, p.profiles[k].maxBudgetUsd, p.profiles[k].notes]);
  assert.deepEqual(CATEGORIES, p.notes.categories);
});

test("the prompts built from the preset are the stored ones (test/fixtures/default-prompts.json)", () => {
  const stored = JSON.parse(readFileSync(new URL("./fixtures/default-prompts.json", import.meta.url), "utf8")) as Record<string, string>;
  const portable = (s: string) => s.replaceAll(settings.dataDir, "<data>");
  const account = process.env.SIGNAL_ACCOUNT;
  delete process.env.SIGNAL_ACCOUNT;
  try {
    assert.equal(portable(chatSystem("yesterday's brief", new Date("2026-10-12T09:00:00"), [], [], ["10:00 an alert"])), stored.chat);
    assert.equal(portable(groupSystem()), stored.group);
  } finally {
    if (account !== undefined) process.env.SIGNAL_ACCOUNT = account;
  }
  assert.ok(dreamSystem({ subject: settings.owner, kind: "owner", categories: presetFor().notes.dream }).startsWith(`You keep the memory notes about ${settings.owner} for their personal assistant.`));
});

test("templates: variables, flags and their opposite, nesting", () => {
  const t = parseTemplate("a {{x}} {{#on}}yes {{#deep}}deep{{/deep}}{{/on}}{{^on}}no{{/on}}.", "t");
  assert.equal(render(t, { x: "1", on: true, deep: true }), "a 1 yes deep.");
  assert.equal(render(t, { x: "1", on: true, deep: false }), "a 1 yes .");
  assert.equal(render(t, { x: "", on: false, deep: true }), "a  no.");
  assert.throws(() => render(t, { x: "1" }), /\{\{on\}\} has no value/);
});

test("a malformed preset fails with a message that names the file and the problem", () => {
  const broken = (change: Parameters<typeof copyOfTed>[0]) => () => loadPreset(copyOfTed(change));
  assert.throws(() => loadPreset(join(scratch, "nothing-here")), /has no preset\.json/);
  const garbled = join(scratch, "garbled");
  mkdirSync(garbled);
  writeFileSync(join(garbled, "preset.json"), "{ nope");
  assert.throws(() => loadPreset(garbled), /preset\.json is not valid JSON/);
  assert.throws(broken((d) => rmSync(join(d, "persona", "chat.md"))), /persona\/chat\.md is missing/);
  assert.throws(broken((d) => writeFileSync(join(d, "persona", "personality.md"), "Hello {{mood}}")), /personality\.md: \{\{mood\}\} is not available here/);
  assert.throws(broken((d) => writeFileSync(join(d, "persona", "chat.md"), "{{#mail}}never closed")), /chat\.md: \{\{#mail\}\} is never closed/);
  assert.throws(broken((d) => writeFileSync(join(d, "persona", "chat.md"), "closes {{/mail}}")), /chat\.md: \{\{\/mail\}\} closes nothing/);
  assert.throws(broken((d) => writeFileSync(join(d, "persona", "chat.md"), "a stray {{ brace")), /chat\.md: a stray/);
  assert.throws(broken((_d, j) => { j.rhythm.brief.startHour = 25; }), /rhythm\.brief\.startHour: must be a whole number from 0 to 23 \(got 25\)/);
  assert.throws(broken((_d, j) => { j.rhythm.radar.everyMinutes = 5; }), /rhythm\.radar\.everyMinutes: must be a whole number from 30 to 720/);
  assert.throws(broken((_d, j) => { j.rhythm.dream.enabled = "yes"; }), /rhythm\.dream\.enabled: must be true or false/);
  assert.throws(broken((_d, j) => { delete j.profiles.radar; }), /profiles\.radar: must be an object/);
  assert.throws(broken((_d, j) => { j.profiles.brief.notes = ["gossip"]; }), /profiles\.brief\.notes: "gossip" is not one of notes\.categories/);
  assert.throws(broken((_d, j) => { j.rhythm.brief.skill = "weekly-review"; }), /the skill "weekly-review" is not in skills\.core/);
  assert.throws(broken((_d, j) => { j.skills.core = "daily-brief"; }), /skills\.core: must be a list/);
  assert.throws(broken((_d, j) => { j.name = "Ted Lasso"; }), /"name" must be a lower-case word/);
  assert.throws(broken((_d, j) => { j.extends = "../../etc"; }), /"extends" must be the name of another preset/);
  assert.throws(() => presetFor({ ASSISTANT_PRESET: "../escape" }), /ASSISTANT_PRESET is the name of a folder in assistants\//);
});

// A second assistant in a few lines of data: it starts from ted, speaks differently and wakes up on another rhythm. Run in a child process
// the way a real start is (ASSISTANT_PRESET is read once, at start-up), with no code changed.
test("a second preset changes the persona, the rhythm and the limits without touching code", () => {
  const dir = join(scratch, "coach");
  mkdirSync(join(dir, "persona"), { recursive: true });
  writeFileSync(join(dir, "preset.json"), JSON.stringify({
    extends: "ted",
    name: "coach",
    rhythm: { brief: { startHour: 6, backstopHour: 8 }, radar: { enabled: false }, heartbeat: { everyMinutes: 30 } },
    notes: { categories: ["goals", "people", "style"], dream: ["goals", "people"], group: ["people"], tenant: ["people", "style"] },
    profiles: { brief: { maxTurns: 40, notes: ["goals", "style"] }, radar: { notes: ["goals"] }, background: { notes: ["goals"] }, handler: { notes: ["people", "style"] } },
  }));
  writeFileSync(join(dir, "persona", "personality.md"), "You talk like a calm, no-nonsense running coach: short sentences, one clear next step.\n");
  writeFileSync(join(dir, "persona", "radar.md"), "You are {{assistant}}, {{owner}}'s coach, checking in. Load the {{skill}} skill.\n");
  const probe = join(scratch, "probe.ts");
  const src = new URL("../src/", import.meta.url).pathname;
  writeFileSync(probe, `
    const { chatSystem, radarSystem, PERSONALITY } = await import(${JSON.stringify(src + "persona.ts")});
    const { PROFILES } = await import(${JSON.stringify(src + "profiles.ts")});
    const { CATEGORIES, categoryOf } = await import(${JSON.stringify(src + "notes.ts")});
    const { settings } = await import(${JSON.stringify(src + "settings.ts")});
    console.log(JSON.stringify({ chat: chatSystem(undefined, new Date("2026-10-12T09:00:00")), radar: radarSystem(""), personality: PERSONALITY, categories: CATEGORIES,
      cat: [categoryOf("goals-run.md"), categoryOf("triage-x.md")], brief: PROFILES.brief, radarProfile: PROFILES.radar.notes,
      rhythm: [settings.briefStartHour, settings.briefBackstopHour, settings.proactive, settings.heartbeatMinutes, settings.radarMinutes] }));
  `);
  const run = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ["--conditions=workspace-source", probe], {
    env: { ...process.env, HARNESS_DATA_DIR: join(scratch, "data"), OWNER_NAME: "Alex", ASSISTANT_NAME: "Coach", ...env }, encoding: "utf8",
  }));
  const coach = run({ ASSISTANT_PRESET: dir });
  assert.match(coach.chat, /You are Coach, personal assistant to Alex\. You talk like a calm, no-nonsense running coach/);
  assert.ok(!coach.chat.includes("Ted Lasso"));
  assert.equal(coach.radar.split("\n\n")[0], "You are Coach, Alex's coach, checking in. Load the ted-personal-assistant:radar skill.");
  assert.deepEqual(coach.categories, ["goals", "people", "style"]);
  assert.deepEqual(coach.cat, ["goals", null]); // "triage" is not this assistant's category
  assert.deepEqual([coach.brief.maxTurns, coach.brief.maxBudgetUsd, coach.brief.notes], [40, 5, ["goals", "style"]]);
  assert.deepEqual(coach.rhythm, [6, 8, false, 30, 180]);
  // An environment variable still beats the preset's default.
  assert.equal(run({ ASSISTANT_PRESET: dir, BRIEF_START_HOUR: "5", PROACTIVE: "on" }).rhythm[0], 5);
  // Without the variable it is Ted again, and this process's own prompts are Ted's.
  const ted = run({});
  assert.ok(ted.chat.includes("Ted Lasso") && ted.personality === PERSONALITY);
  assert.deepEqual(ted.rhythm, [7, 9, true, 15, 180]);
});
