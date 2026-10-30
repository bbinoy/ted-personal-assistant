import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// WHAT EACH KIND OF RUN IS HANDED, side by side (CLAUDE.md §2: one agent, a closed list of differences). The owner's chat turn and look, a group's, a friend's, and the
// expert each of them may brief are rendered with fakes (no model, a temporary data folder) through the real run path (agent.ts runConversation / runLook): the system
// prompt's persona sections, the blocks of the user turn by name (clock, setup, notices, notes, status, held posts, the message), the tools, skills, connectors flag, model,
// session and answer format, and the sections and blocks of the expert's own prompt and brief. Three tests and one fixture:
//   1. REQUIRED: what every run must have (exactly one CURRENT TIME in its turn and in its expert's brief, the persona sections every conversation shares).
//   2. ALLOWED: every other difference between two kinds must be in the table below, with its reason and the axis it follows (the trigger, the conversation, or either). A
//      difference not in the table, or one that follows another axis than its row says, fails the test: add it to the table with a reason, or remove the difference.
//   3. test/fixtures/run-inputs.json holds the rendered kinds and the differences as a table, so any change shows up as a diff to review (SNAPSHOT_WRITE=1 npm test).
// The test reads what the run was handed, never how it was built: a rewrite of how a block is made needs the fixture regenerated, not this file changed.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "runinputs-"));
process.env.INTAKE_BASE_URL = "";

const { settings } = await import("../src/core/settings.ts");
const { preset } = await import("../src/core/preset.ts");
const { owner, group, tenant } = await import("../src/conversation/conversationmodel.ts");
const { runConversation, runLook } = await import("../src/run/agent.ts");
const { TRIGGERS, runFor } = await import("../src/run/runoptions.ts");
const { forgetShown, turnFactsFrom } = await import("../src/run/turncontext.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { CATEGORIES } = await import("../src/memory/notes.ts");
const { LOGIN } = await import("../src/tenants/payer.ts");
const T = await import("../src/tenants/tenants.ts");

(settings as unknown as { warm: boolean }).warm = false;

const FIXTURE = join(import.meta.dirname, "fixtures", "run-inputs.json");
const AT = new Date("2026-10-20T09:00:00Z");
const MSG = "MSG-MARK";
const KEY = "test-instance-key";

// ---- the allowed differences ----------------------------------------------------------------------------------------------------------------------------------
// A feature is named `<part>:<name>` (system:, expert-system:, block:, expert-brief:, tools:, builtin:, skills:, mcp:, agents:) or a plain scalar. `by`: what the value may depend on:
//   trigger       a chat turn against a look (CLAUDE.md §2: model, session, trigger line, attended, answer format), the same for every conversation
//   conversation  the owner, a group, a friend: the capability set, privacy (§5) or billing; a conversation's turn and look agree
//   either        both (a tool a capability gives that attendance removes)
// Nothing else is allowed: the clock, the persona sections everyone shares, the notes, the held posts and the message are the same for all.
type By = "trigger" | "conversation" | "either";
const ALLOWED: { match: RegExp; by: By; reason: string }[] = [
  // -- the trigger table (runoptions.ts TRIGGERS) and what follows from it --
  { match: /^(model|effort)$/, by: "trigger", reason: "model: a look is a cheap model that decides and delegates (HEARTBEAT_MODEL, high effort); a chat turn is HARNESS_MODEL" },
  { match: /^answer$/, by: "trigger", reason: "answer format: a look answers in the look's JSON (message, nextCheckMinutes, urgent), a chat turn in a reply" },
  { match: /^session$/, by: "trigger", reason: "session: a chat turn resumes the conversation's session, a look starts a fresh one every time" },
  { match: /^attended$/, by: "trigger", reason: "attended: a message's person is waiting, a look's nobody" },
  // -- what the capability set and attendance decide --
  { match: /^block:first-contact$/, by: "either", reason: "attended: only a friend's first message turn, after the owner let her in, greets her (runoptions.ts turnContext)" },
  { match: /^block:setup$/, by: "conversation", reason: "capability (setup): what is not connected or set up is the owner's own installation; a group or a friend has no setup to walk through" },
  { match: /^(tools:|mcp:)/, by: "either", reason: "capability X: a tool or server exists where the conversation's capability set holds it (capabilities.ts toolsFor), minus what attendance removes" },
  { match: /^(skills:|agents:expert-)/, by: "conversation", reason: "capability (the owner's whole plugin: mail, calendar, briefs, setup): a group or a friend gets the shared skills only, and an expert variant exists per skill" },
  { match: /^(system:send|stream)$/, by: "conversation", reason: "trial, owner only; remove at rollout (capability stream: the send persona text says everything written is sent as it is written)" },
  // -- privacy (§5) and persona --
  { match: /^(settingSources|strictMcp)$/, by: "conversation", reason: "privacy (§5): only the owner's run loads her login's connectors and user settings; a group's and a friend's are isolated (strict MCP, no settings sources)" },
  { match: /^system:participation$/, by: "conversation", reason: "persona: only a group is told when to speak (participation); every conversation's prompt is built from the same templates (identity, capabilities, shared), the owner's, a group's and a friend's alike" },
];

// What every run must have, whatever its kind: `feature=value`.
const REQUIRED = ["block:clock=1", "block:message=1", "expert-brief:clock=1", "system:personality=on", "system:identity=on", "system:capabilities=on", "system:shared=on", "system:background=on", "system:delegate=on", "expert-system:expert=on"];

// ---- the kinds ------------------------------------------------------------------------------------------------------------------------------------------------
const rec = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000cc", name: "Bea" })!;
const payer = { kind: "instance" as const, id: rec.id, apiKey: KEY, ledger: T.tenantContext(rec).ledger };
const FACTS = { blocks: ["HELD-MARK a post held for this routine"], status: ["STATUS-MARK information"], untrusted: false, done: () => {} };
turnFactsFrom(() => FACTS as never);
const noop = async () => ({ approved: false });

const KINDS = {
  "owner chat": { conv: owner(), trigger: "message" as const, who: "owner" },
  "owner look": { conv: owner(), trigger: "look" as const, who: "owner" },
  "group chat": { conv: group("g-run-inputs"), trigger: "message" as const, who: "group" },
  "group look": { conv: group("g-run-inputs"), trigger: "look" as const, who: "group" },
  "friend chat": { conv: tenant(rec.id), trigger: "message" as const, who: "friend" },
  "friend look": { conv: tenant(rec.id), trigger: "look" as const, who: "friend" },
};
type KindName = keyof typeof KINDS;
const NAMES = Object.keys(KINDS) as KindName[];

// A note in each conversation, so that each has an index to be told.
for (const k of Object.values(KINDS)) {
  mkdirSync(k.conv.notesDir, { recursive: true });
  writeFileSync(join(k.conv.notesDir, `${CATEGORIES[0]}-probe.md`), "---\ndescription: NOTES-MARK probe\n---\nbody\n");
}
recordMessage("notice", Date.now(), "NOTICE-MARK alert", new Date()); // (the owner's chat is told the notices of the last day, by the real clock)

// The sections of a prompt: each persona template (assistants/<name>/persona/*.md) is on when its first fixed words are in the text.
function sectionsOf(text: string): string[] {
  const out: string[] = [];
  for (const [key, t] of Object.entries(preset().persona)) {
    const lead = t.nodes.find((n): n is string => typeof n === "string" && n.trim().length >= 25);
    const marker = lead?.trim().split("\n")[0]!.slice(0, 60);
    if (marker && text.includes(marker)) out.push(key);
  }
  return out;
}

// The blocks of a user turn, by name: a paragraph is classified by what it starts with; one that is none of these is a block of its own, named by its first words, so a new
// block cannot hide (teach the table here what it is, and regenerate the fixture).
const BLOCKS: [string, RegExp][] = [
  ["context", /^The conversation's context, written by code/],
  ["chat-tail", /^(What was posted in this chat since you last looked|The rec)/],
  ["clock", /^CURRENT TIME:/],
  ["message", /^MSG-MARK/],
  ["setup", /^Not set up yet/],
  ["first-contact", /^This is the first time she talks to you/],
  ["notes", /NOTES-MARK/],
  ["status", /^STATUS-MARK/],
  ["held-posts", /^HELD-MARK/],
];
const blocksOf = (text: string): string[] => text.split("\n\n").map((para) => BLOCKS.find(([, re]) => re.test(para))?.[0] ?? `other(${para.slice(0, 24).replace(/\s+/g, " ")})`);

interface Seen {
  system: string[];
  blocks: string[];
  tools: string[];
  builtin: string[];
  skills: string[];
  mcp: string[];
  agents: string[];
  scalars: Record<string, string>;
  expertSystem: string[];
  expertBrief: string[];
}

const textOf = async (p: any): Promise<string> => (typeof p === "string" ? p : String((await p[Symbol.asyncIterator]().next()).value.message.content)); // (the owner's prompt is a message stream)

async function render(name: KindName): Promise<Seen> {
  const k = KINDS[name];
  const inputs = { now: AT, ...(k.who === "friend" ? { apiKey: KEY } : {}) };
  let prompt = "";
  let options: any;
  const query = ((p: { prompt: unknown; options: unknown }) => (
    (async function* () {
      prompt = await textOf(p.prompt);
      options = p.options;
      yield { type: "result", subtype: "success", is_error: false, result: "[[silent]]", session_id: "s", total_cost_usd: 0, structured_output: { message: "[[silent]]", nextCheckMinutes: 30 } };
    })()
  )) as never;
  forgetShown(k.conv.convId); // (every run is a first one: told everything)
  if (k.trigger === "message") await runConversation(k.conv, inputs, () => ({ prompt: MSG }), undefined, { query });
  else await runLook(k.conv, k.who === "friend" ? payer : LOGIN, () => ({ prompt: MSG }), noop, { facts: FACTS as never }, { now: AT, io: { query } });
  // The expert: the brief the run's first delegation hands it (the PreToolUse hook adds the context to the run's own words), and the expert's own system prompt.
  const hook = options.hooks.PreToolUse[0].hooks[0];
  const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "expert", prompt: "BRIEF-MARK" } }, undefined, { signal: new AbortController().signal });
  const brief = String(out.hookSpecificOutput.updatedInput.prompt).split("\n\n").slice(1).join("\n\n"); // (after the run's own words)
  const built = runFor(k.conv, k.trigger, inputs); // (the tools the capability set gives the run; the SDK is told only the built-in ones, the rest are its MCP servers)
  return {
    system: sectionsOf(options.systemPrompt.append),
    blocks: blocksOf(prompt),
    tools: [...(built.tools ?? [])].map((t) => (t.startsWith("mcp__") ? `${t.split("__")[1]} server` : t)).sort(), // (an MCP server's tools by its name, counted: test/run-identity.test.ts pins each tool)
    builtin: [...options.tools].sort(),
    skills: [...(options.skills ?? [])].sort(),
    mcp: Object.keys(options.mcpServers ?? {}).sort(),
    agents: Object.keys(options.agents ?? {}).sort(),
    scalars: {
      model: options.model === settings.model ? "HARNESS_MODEL" : "HEARTBEAT_MODEL",
      effort: String(options.effort ?? "default"),
      answer: options.outputFormat ? "json" : "reply",
      attended: String(TRIGGERS[k.trigger].attended),
      session: built.freshSession ? "fresh" : "conversation's",
      settingSources: JSON.stringify(options.settingSources),
      strictMcp: String(!!options.strictMcpConfig),
      notes: options.settings?.autoMemoryEnabled ? "own folder" : "none",
    },
    expertSystem: sectionsOf(options.agents.expert.prompt),
    expertBrief: blocksOf(brief),
  };
}

// ---- the comparison -------------------------------------------------------------------------------------------------------------------------------------------
const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
function featuresOf(s: Seen): Map<string, string> {
  const f = new Map<string, string>();
  for (const x of s.system) f.set(`system:${x}`, "on");
  for (const x of s.expertSystem) f.set(`expert-system:${x}`, "on");
  for (const [x, n] of count(s.blocks)) f.set(`block:${x}`, String(n));
  for (const [x, n] of count(s.expertBrief)) f.set(`expert-brief:${x}`, String(n));
  for (const [x, n] of count(s.tools)) f.set(`tools:${x}`, String(n));
  for (const [part, list] of [["builtin", s.builtin], ["skills", s.skills], ["mcp", s.mcp], ["agents", s.agents]] as const) for (const x of list) f.set(`${part}:${x}`, "on");
  for (const [x, v] of Object.entries(s.scalars)) f.set(x, v);
  return f;
}

const AXIS: Record<Exclude<By, "either">, (n: KindName) => string> = {
  trigger: (n) => String(TRIGGERS[KINDS[n].trigger].attended),
  conversation: (n) => KINDS[n].who,
};
// Does the feature follow its axis alone: do the kinds that share the axis' value agree?
function follows(by: By, values: Record<string, string>): boolean {
  if (by === "either") return true;
  const seen = new Map<string, string>();
  return NAMES.every((n) => (seen.get(AXIS[by](n)) ?? values[n]) === values[n] && !!seen.set(AXIS[by](n), values[n]!));
}

let cached: ReturnType<typeof everything> | undefined; // (the runs are made once for the three tests: each leaves marks, such as a friend's first contact, in the data folder)
const once = (): ReturnType<typeof everything> => (cached ??= everything());
async function everything() {
  const seen = {} as Record<KindName, Seen>;
  for (const n of NAMES) seen[n] = await render(n);
  const feats = Object.fromEntries(NAMES.map((n) => [n, featuresOf(seen[n])])) as Record<KindName, Map<string, string>>;
  const features = [...new Set(Object.values(feats).flatMap((m) => [...m.keys()]))].sort();
  const differences: Record<string, { by?: By; reason?: string; values: Record<string, string[]> }> = {};
  const problems: string[] = [];
  for (const feature of features) {
    const values = Object.fromEntries(NAMES.map((n) => [n, feats[n].get(feature) ?? "-"])) as Record<KindName, string>;
    if (new Set(Object.values(values)).size === 1) continue;
    const grouped: Record<string, string[]> = {};
    for (const [n, v] of Object.entries(values)) (grouped[v] ??= []).push(n);
    const row = ALLOWED.find((a) => a.match.test(feature));
    differences[feature] = { ...(row ? { by: row.by, reason: row.reason } : {}), values: grouped };
    const odd = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length).slice(1).flatMap(([v, ns]) => ns.map((n) => `${n} (${v})`));
    if (!row) problems.push(`${odd.join(", ")} differ in "${feature}" from the other kinds: add it to the allowed table with a reason, or remove the difference`);
    else if (!follows(row.by, values)) problems.push(`"${feature}" may follow the ${row.by} only (${row.reason}), but ${odd.join(", ")} differ in another way: add it to the allowed table with a reason, or remove the difference`);
  }
  const kinds = Object.fromEntries(NAMES.map((n) => [n, { ...seen[n], ...seen[n].scalars, scalars: undefined }]));
  return { feats, problems, fixture: JSON.parse(JSON.stringify({ kinds, differences })) };
}

test("run inputs: what every kind of run must have, it has", async () => {
  const { feats } = await once();
  for (const [name, f] of Object.entries(feats)) {
    for (const want of REQUIRED) {
      const [feature, value] = want.split("=") as [string, string];
      assert.equal(f.get(feature) ?? "-", value, `${name}: "${feature}" must be ${value} in every run (it is ${f.get(feature) ?? "absent"})`);
    }
  }
});

test("run inputs: kinds differ only where the allowed table says", async () => {
  const { problems } = await once();
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("run inputs: the rendered kinds and their differences are as recorded", async () => {
  const { fixture } = await once();
  const lists = /\[\n\s+("(?:[^"\\]|\\.)*"(?:,\n\s+"(?:[^"\\]|\\.)*")*)\n\s+\]/g; // (a list of names on one line: a diff of the fixture is a diff of a row)
  if (process.env.SNAPSHOT_WRITE) return void writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2).replace(lists, (_m, items: string) => `[${items.replace(/,\n\s+/g, ", ")}]`)}\n`);
  assert.ok(existsSync(FIXTURE), "test/fixtures/run-inputs.json is missing: regenerate it on purpose with SNAPSHOT_WRITE=1 npm test");
  assert.deepEqual(fixture, JSON.parse(readFileSync(FIXTURE, "utf8")), "what a run is handed drifted from test/fixtures/run-inputs.json (a deliberate change: SNAPSHOT_WRITE=1 npm test)");
});
