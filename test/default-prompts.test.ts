import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BRIEF_INSTRUCTIONS } from "../src/brief.ts";
import { missingSetup, setupItems } from "../src/notes.ts";
import { backgroundSystem, briefSystem, chatContext, chatSystem, GATE_DEFAULTS, groupSystem, handlerSystem, ownerGateDefaults, radarSystem } from "../src/persona.ts";
import { PROFILES } from "../src/profiles.ts";
import { ownerSkills } from "../src/skills.ts";
import { settings } from "../src/settings.ts";

// The default (MAIL_PROVIDER=mailbird) must not drift: every prompt and the offered skills are compared with a stored copy.
// A deliberate change to a prompt means regenerating the fixture on purpose: SNAPSHOT_WRITE=1 npm test.

const FIXTURE = new URL("./fixtures/default-prompts.json", import.meta.url);
const NOW = new Date("2026-10-12T09:00:00");

// The data folder differs per run; nothing else in the prompts depends on the machine.
const portable = (s: string) => s.replaceAll(settings.dataDir, "<data>");

export function snapshot(): Record<string, unknown> {
  const signalAccount = process.env.SIGNAL_ACCOUNT;
  delete process.env.SIGNAL_ACCOUNT; // the chat prompt names the channel from it
  try {
    const missing = missingSetup([]);
    const down = ["notion", "calendar"] as const;
    return {
      offeredSkills: ownerSkills(settings.mail),
      profileSkills: Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, p.skills])),
      setupLabels: setupItems().map((i) => i.label),
      briefInstructions: BRIEF_INSTRUCTIONS,
      hiddenConnectors: settings.hiddenConnectors,
      chat: portable(chatSystem(NOW)),
      chatContext: portable(chatContext({ lastBrief: "yesterday's brief", pings: ["10:00 an alert"] }) ?? ""),
      chatContextSetup: portable(chatContext({ missing, down }) ?? ""),
      brief: portable(briefSystem("MEMORY", missing, down)),
      radar: portable(radarSystem("MEMORY", missing, down)),
      handler: portable(handlerSystem("MEMORY", missing, down)),
      background: portable(backgroundSystem("MEMORY", missing, down)),
      group: portable(groupSystem()),
      gateOwner: GATE_DEFAULTS.owner,
      gateGroup: GATE_DEFAULTS.group,
      ownerGate: ownerGateDefaults({ briefHour: 7, backstopHour: 9, radarMinutes: 180, radar: true, minGapMinutes: 60 }),
    };
  } finally {
    if (signalAccount !== undefined) process.env.SIGNAL_ACCOUNT = signalAccount;
  }
}

test("default (mailbird): prompts and offered skills are byte-identical to the stored copy", () => {
  const now = snapshot();
  if (process.env.SNAPSHOT_WRITE || !existsSync(FIXTURE)) return void writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  for (const key of Object.keys(stored)) assert.deepEqual(now[key], stored[key], `${key} drifted from test/fixtures/default-prompts.json`);
  assert.deepEqual(Object.keys(now), Object.keys(stored));
});
