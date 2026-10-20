import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delegatedText, expertSetup } from "../src/heartbeat/delegation.ts";
import { mailSlot } from "../src/modules/index.ts";
import { missingSetup, setupItems } from "../src/notes.ts";
import { backgroundSystem, chatContext, chatSystem, GATE_DEFAULTS, groupSystem, expertSystem, handlerSystem, heartbeatInstruction, heartbeatSystem } from "../src/persona.ts";
import { PROFILES } from "../src/profiles.ts";
import { ownerSkills } from "../src/skills.ts";
import { settings } from "../src/settings.ts";

// The default (MAIL_PROVIDER=mailbird) must not drift: every prompt and the offered skills are compared with a stored copy.
// A deliberate change to a prompt means regenerating the fixture on purpose: SNAPSHOT_WRITE=1 npm test (the same switch as the run options' fixture). A missing fixture is a
// failure, never written silently.

const FIXTURE = new URL("./fixtures/default-prompts.json", import.meta.url);
const NOW = new Date("2026-10-12T09:00:00");

// The data folder differs per run; nothing else in the prompts depends on the machine.
const portable = (s: string) => s.replaceAll(settings.dataDir, "<data>");

export function snapshot(): Record<string, unknown> {
  const own = settings as unknown as { signalOwnAccount: string | undefined };
  const signalAccount = own.signalOwnAccount;
  own.signalOwnAccount = undefined; // the chat prompt names the channel from it
  try {
    const missing = missingSetup([]);
    const down = ["notion", "calendar"] as const;
    return {
      offeredSkills: ownerSkills(settings.mail),
      profileSkills: Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, p.skills])),
      setupLabels: setupItems().map((i) => i.label),
      hiddenConnectors: settings.hiddenConnectors,
      chat: portable(chatSystem(NOW)),
      chatContext: portable(chatContext({ pings: ["10:00 an alert"] }) ?? ""),
      chatContextSetup: portable(chatContext({ missing, down }) ?? ""),
      heartbeat: portable(heartbeatSystem("MEMORY", { missing, down })),
      expert: portable(expertSystem("MEMORY", { missing, down })),
      heartbeatInstruction: heartbeatInstruction({ now: "Monday 2026-10-12 09:00", timeZone: "Europe/Berlin", lastLook: "Your last look was at 08:30.", quietFrom: "22:00", quietTo: "07:00", dayMinutes: "30", delegated: delegatedText(expertSetup(PROFILES.heartbeat.skills, "")), briefTime: "07:30", briefOverdueHour: "09:00", briefHow: mailSlot()!.brief.how(), who: settings.owner, own: true, reads: true, experts: true, brief: true, sources: "mail since your last look, the calendar for the next 36 hours, tasks, and your notes and their schedules" }),
      handler: portable(handlerSystem("MEMORY", { missing, down })),
      background: portable(backgroundSystem("MEMORY", missing, down)),
      group: portable(groupSystem()),
      gateGroup: GATE_DEFAULTS.group,
    };
  } finally {
    own.signalOwnAccount = signalAccount;
  }
}

test("default (mailbird): prompts and offered skills are byte-identical to the stored copy", () => {
  const now = snapshot();
  if (process.env.SNAPSHOT_WRITE) return void writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  assert.ok(existsSync(FIXTURE), "test/fixtures/default-prompts.json is missing: regenerate it on purpose with SNAPSHOT_WRITE=1 npm test"); 
  const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  for (const key of Object.keys(stored)) assert.deepEqual(now[key], stored[key], `${key} drifted from test/fixtures/default-prompts.json`);
  assert.deepEqual(Object.keys(now), Object.keys(stored));
});
