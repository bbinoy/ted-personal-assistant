import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSISTANTS_DIR, loadPreset, parseTemplate, presetFor, PROMPTS, render } from "../src/core/preset.ts";
import { dreamSystem, PERSONALITY } from "../src/run/persona.ts";
import { CATEGORIES } from "../src/memory/notes.ts";
import { settings } from "../src/core/settings.ts";

// The assistant preset (assistants/<name>/, src/core/preset.ts): what makes the harness "Ted" is data. It loads and is checked, a broken one says what is
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

test("ted's preset loads: the rhythm, the note categories, the run limits, the skills and a text for every prompt", () => {
  const p = loadPreset(TED);
  assert.equal(p.name, "ted");
  assert.deepEqual(p.rhythm, {
    heartbeat: { everyMinutes: 5, dayMinutes: 30 },
    dream: { hour: 4, minNewLines: { direct: 1, group: 3 }, maxGroupsPerNight: 5 },
  });
  assert.deepEqual(p.notes.categories, ["triage", "people", "scheduling", "context", "brief", "style", "setup", "voice", "status", "routine"]);
  assert.deepEqual(p.limits, { maxTurns: 40, maxBudgetUsd: 2 });
  assert.deepEqual(Object.keys(p.persona).sort(), Object.keys(PROMPTS).sort());
  assert.deepEqual(p.skills.core.map((s) => s.name), ["daily-brief", "meeting-prep", "follow-through", "stay-in-touch", "evening-wrap", "weekly-review", "setup"]);
  assert.deepEqual(p.expert, { model: "sonnet", maxTurns: 40 });
  assert.strictEqual(presetFor({}), presetFor({ ASSISTANT_PRESET: "ted" }), "ted is the default, loaded once");
});

test("the code reads the preset: settings defaults, note categories", () => {
  const p = presetFor();
  assert.deepEqual([settings.heartbeatDayMinutes, settings.heartbeatMinutes, settings.quietStartHour, settings.quietEndHour],
    [p.rhythm.heartbeat.dayMinutes, p.rhythm.heartbeat.everyMinutes, 22, 7]); // (the quiet hours are not the preset's: they differ per install, QUIET_HOURS)
  assert.deepEqual(CATEGORIES, p.notes.categories);
});

// (The prompts built from the preset being the stored ones is test/default-prompts.test.ts, the one place that reads test/fixtures/default-prompts.json.)
test("the dream prompt names the owner whose memory it keeps", () => {
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
  assert.throws(broken((_d, j) => { delete j.expert; }), /expert: must be an object/);
  assert.throws(broken((_d, j) => { j.rhythm.heartbeat.dayMinutes = 5; }), /rhythm\.heartbeat\.dayMinutes: must be a whole number from 10 to 120/);
  assert.throws(broken((_d, j) => { j.profiles = {}; }), /"profiles" is gone: use one "limits"/);
  assert.throws(broken((_d, j) => { delete j.limits; }), /limits: must be an object/);
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
    rhythm: { heartbeat: { everyMinutes: 30, dayMinutes: 45 } },
    notes: { categories: ["goals", "people", "style"], dream: ["goals", "people"], others: ["people", "style"] },
    limits: { maxTurns: 25 },
  }));
  writeFileSync(join(dir, "persona", "personality.md"), "You talk like a calm, no-nonsense running coach: short sentences, one clear next step.\n");
  writeFileSync(join(dir, "persona", "background.md"), "Checking in as {{assistant}}, {{who}}'s coach.\n");
  const probe = join(scratch, "probe.ts");
  const src = new URL("../src/", import.meta.url).pathname;
  writeFileSync(probe, `
    const { chatSystem, PERSONALITY } = await import(${JSON.stringify(src + "run/persona.ts")});
    const { preset } = await import(${JSON.stringify(src + "core/preset.ts")});
    const { CATEGORIES, categoryOf } = await import(${JSON.stringify(src + "memory/notes.ts")});
    const { settings } = await import(${JSON.stringify(src + "core/settings.ts")});
    console.log(JSON.stringify({ chat: chatSystem(new Date("2026-10-12T09:00:00")), personality: PERSONALITY, categories: CATEGORIES,
      cat: [categoryOf("goals-run.md"), categoryOf("triage-x.md")], groupTurns: preset().limits.maxTurns,
      rhythm: [settings.heartbeatMinutes, settings.heartbeatDayMinutes] }));
  `);
  const run = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ["--conditions=workspace-source", probe], {
    env: { ...process.env, HARNESS_DATA_DIR: join(scratch, "data"), OWNER_NAME: "Alex", ASSISTANT_NAME: "Coach", ...env }, encoding: "utf8",
  }));
  const coach = run({ ASSISTANT_PRESET: dir });
  assert.match(coach.chat, /You are Coach, personal assistant to Alex\. You talk like a calm, no-nonsense running coach/);
  assert.ok(!coach.chat.includes("Ted Lasso"));
  assert.match(coach.chat, /Checking in as Coach, Alex's coach\./, "the standing instruction for a background check is a persona file too, in every conversation's prompt");
  assert.deepEqual(coach.categories, ["goals", "people", "style"]);
  assert.deepEqual(coach.cat, ["goals", null]); // "triage" is not this assistant's category
  assert.equal(coach.groupTurns, 25);
  assert.deepEqual(coach.rhythm, [30, 45]);
  // Without the variable it is Ted again, and this process's own prompts are Ted's.
  const ted = run({});
  assert.ok(ted.chat.includes("Ted Lasso") && ted.personality === PERSONALITY);
  assert.deepEqual(ted.rhythm, [5, 30]);
});

// Every run's options built under a second preset whose categories are not Ted's: nothing in code may still name triage, scheduling, context or brief as a
// category of a conversation. (The words of the persona files are the preset's, and the categories in them are filled in from it.)
test("a second preset's note categories reach every run: chat, group, friend, heartbeat, dream and the gates", () => {
  const dir = join(scratch, "coach2");
  mkdirSync(join(dir, "persona"), { recursive: true });
  writeFileSync(join(dir, "preset.json"), JSON.stringify({
    extends: "ted",
    name: "coach2",
    notes: { categories: ["goals", "people", "style"], dream: ["goals", "people"], others: ["goals", "style"] },
    limits: { maxTurns: 12, maxBudgetUsd: 0.7 },
  }));
  const probe = join(scratch, "probe2.ts");
  const src = new URL("../src/", import.meta.url).pathname;
  writeFileSync(probe, `
    const T = await import(${JSON.stringify(src + "tenants/tenants.ts")});
    const { owner, group, tenant } = await import(${JSON.stringify(src + "conversation/conversation.ts")});
    const { runFor } = await import(${JSON.stringify(src + "run/runoptions.ts")});
    const { preset } = await import(${JSON.stringify(src + "core/preset.ts")});
    const { dreamScope } = await import(${JSON.stringify(src + "modules/memory/dreamscope.ts")});
    const { dreamSystem, GATE_DEFAULTS } = await import(${JSON.stringify(src + "run/persona.ts")});
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { NOTES_DIR, readIndex } = await import(${JSON.stringify(src + "memory/notes.ts")});
    mkdirSync(NOTES_DIR, { recursive: true });
    writeFileSync(join(NOTES_DIR, "goals-run.md"), "---\\nname: run\\n---\\n\\nRun a half marathon in spring.\\n");
    writeFileSync(join(NOTES_DIR, "people-sam.md"), "---\\nname: sam\\n---\\n\\nSam is the training partner.\\n");
    writeFileSync(join(NOTES_DIR, "triage-x.md"), "---\\nname: x\\n---\\n\\nOLD TRIAGE NOTE.\\n");
    const rec = T.addTenant({ aci: "00000000-0000-4000-8000-000000000001", name: "Mia" });
    T.provision(rec);
    const prompt = (o) => typeof o.systemPrompt === "string" ? o.systemPrompt : "";
    const out = {
      chat: prompt(runFor(owner(), "message", {})),
      group: prompt(runFor(group("g1"), "message", {})),
      friend: prompt(runFor(tenant(rec.id), "message", { apiKey: "k" })),
      heartbeat: runFor(owner(), "look", {}),
      friendHeartbeat: runFor(tenant(rec.id), "look", { apiKey: "k" }),
      notes: readIndex(owner().notesDir),
      friendNotes: readIndex(tenant(rec.id).notesDir),
      limits: [preset().limits.maxTurns, preset().limits.maxBudgetUsd],
      groupLimits: [runFor(group("g1"), "message", {}).maxTurns, runFor(group("g1"), "message", {}).maxBudgetUsd],
      scopes: Object.fromEntries(["owner", "group", "tenant"].map((k) => [k, dreamScope({ kind: k, groupId: "g1", tenantId: rec.id }).categories])),
      dream: ["owner", "group", "tenant"].map((k) => dreamSystem({ subject: "S", kind: k, categories: dreamScope({ kind: k, groupId: "g1", tenantId: rec.id }).categories })),
      gates: [GATE_DEFAULTS.group],
    };
    for (const k of ["heartbeat", "friendHeartbeat"]) out[k] = { systemPrompt: out[k].systemPrompt, maxTurns: out[k].maxTurns, maxBudgetUsd: out[k].maxBudgetUsd };
    out.heartbeatSystem = out.heartbeat.systemPrompt;
    console.log(JSON.stringify(out));
  `);
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=workspace-source", probe], {
    env: { ...process.env, HARNESS_DATA_DIR: join(scratch, "data2"), ASSISTANT_PRESET: dir, TENANTS: "on", TENANT_ANTHROPIC_API_KEY: "k", OWNER_NAME: "Alex", ASSISTANT_NAME: "Coach" }, encoding: "utf8",
  }).trim().split("\n").at(-1)!);
  assert.match(out.chat, /exactly one category of goals, people, style\./);
  assert.match(out.friend, /exactly one category of goals, style\./);
  assert.deepEqual(out.limits, [12, 0.7]);
  assert.deepEqual(out.groupLimits, [12, 0.7], "a group has the same limits as the owner");
  assert.deepEqual(out.scopes, { owner: ["goals", "people"], group: ["goals", "style"], tenant: ["goals", "style"] });
  assert.deepEqual([out.heartbeat.maxTurns, out.heartbeat.maxBudgetUsd], [12, 0.7], "a look has the conversation's own limits (the preset's limits)");
  assert.equal(out.heartbeat.systemPrompt, out.chat, "a look has the conversation's one prompt");
  assert.match(out.notes, /half marathon/);
  assert.match(out.notes, /training partner/);
  assert.doesNotMatch(out.notes, /OLD TRIAGE NOTE/, "a note of a category this assistant does not have is not in the index");
  assert.doesNotMatch(out.friendNotes ?? "", /OLD TRIAGE NOTE|half marathon/, "a friend's run has her own notes, in the friend categories, and none of the owner's");
  out.dream.forEach((d: string, i: number) => assert.ok(d.includes(`with a category of ${[["goals, people"], ["goals, style"], ["goals, style"]][i]![0]}.`), `dream ${i}`));
  for (const [where, text] of Object.entries({ chat: out.chat, group: out.group, friend: out.friend, dream: out.dream.join("\n"), gates: out.gates.join("\n"), heartbeat: out.heartbeat.systemPrompt, friendHeartbeat: out.friendHeartbeat.systemPrompt })) {
    assert.doesNotMatch(text as string, /\b(triage|scheduling|context)-[a-z]/, `${where}: no Ted file name`);
    for (const m of (text as string).matchAll(/categor(?:y|ies) of ([a-z, ]+)[.:]/g)) for (const c of m[1]!.split(", ")) assert.ok(["goals", "people", "style"].includes(c), `${where}: "${c}" is not this assistant's category`);
  }
});
