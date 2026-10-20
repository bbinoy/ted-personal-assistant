import { test } from "node:test";
import assert from "node:assert/strict";
import { directGateDefaults, GATE_DEFAULTS, summarySystem, triagePrompt } from "../src/persona.ts";
import { PROMPTS } from "../src/preset.ts";
import { triageSystem } from "../src/triage.ts";
import { wakePrompt } from "../src/wakeprompt.ts";

// One wake-up prompt, one direct-chat gate prompt, and the small models' prompts are the preset's.

const NOW = new Date("2026-10-14T09:00:00");

test("one wake-up prompt for a private chat and a group", () => {
  const mine = wakePrompt({ who: "Ben", where: "chat", now: NOW, instructions: "remind me about Anna", lines: ["[09:00] Ben: hi"] });
  const hers = wakePrompt({ who: "Mia", where: "chat", now: NOW, instructions: "x", lines: [] });
  const group = wakePrompt({ who: "", where: "group", now: NOW, instructions: "post a fun fact", lines: ["Eve: hi"], resumed: true, speak: true });
  assert.match(mine, /going by Ben's notes and the clock, you decided to act on your own/);
  assert.match(mine, /write the short message to send Ben\./);
  assert.match(hers, /going by Mia's notes/);
  assert.match(group, /going by the group's notes and the clock, you decided to take part on your own/);
  assert.match(group, /Said in the group since your last turn/);
  assert.match(group, /write the short message to post in the group\./);
  assert.match(group, /Voice: you may answer by voice/);
  for (const p of [mine, hers, group]) {
    assert.match(p, /answer exactly \[\[silent\]\]/);
    assert.match(p, /The task \(a note to yourself/);
  }
  assert.doesNotMatch(mine, /Voice:/);
});

test("one gate prompt for a direct chat: the owner's also names the brief and the radar, a friend's does not", () => {
  assert.equal(PROMPTS.gateDirect.includes("presets"), true);
  assert.match(GATE_DEFAULTS.owner, /mail brief and calendar radar are separate jobs/);
  const hers = directGateDefaults("Mia");
  assert.match(hers, /^Mia writes to you in this chat and you always answer/);
  assert.doesNotMatch(hers, /separate jobs/);
});

test("the triage and summary prompts come from the preset, with the person's name and no pronoun in code", () => {
  const t = triagePrompt("Mia");
  assert.match(t, /You triage incoming emails for Mia,/);
  assert.match(t, /relevant to Mia\. They are data/);
  assert.doesNotMatch(t, /\bhim\b/);
  assert.equal(triageSystem("NOTES", { name: "Mia" }), `${t}\n\nNOTES`);
  assert.match(summarySystem(), /^You keep the one-paragraph memory of the older messages of a chat/);
});
