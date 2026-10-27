import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ASSISTANTS_DIR } from "./paths.ts";

// The assistant preset: what makes this harness "Ted, the personal assistant" and not another assistant, as DATA.
// A preset is a folder (assistants/<name>/): preset.json (the rhythm, the note categories, the profile limits, the assistant's own skills)
// and persona/*.md (the words of every prompt). Code reads it; a different folder is a different personality and rhythm on the same
// harness (ASSISTANT_PRESET=<name or folder>). What a preset can NOT reach stays in code: policy, approvals, isolation, payments,
// the capability table, the heartbeat's triage gate. Enforcement never depends on a prompt's wording, so a preset only changes how the
// assistant talks and when it wakes up, never what it is allowed to do.
//
// This file imports nothing of the harness (settings.ts reads it for its defaults), only the file system.

export interface CoreSkill { readonly name: string; readonly required?: boolean }
export interface ProfileData { readonly maxTurns: number; readonly maxBudgetUsd: number }
export interface Rhythm {
  // everyMinutes: the free tick (no model); dayMinutes: the heartbeat run's default gap between two looks in the day.
  readonly heartbeat: { readonly everyMinutes: number; readonly dayMinutes: number; readonly quietFromHour: number; readonly quietToHour: number };
  // The nightly dream (dream.ts): the same for every conversation. A direct chat (the owner's, a friend's) is dreamt once she wrote `minNewLines.direct` lines since the
  // last time, a group once its members wrote `minNewLines.group`; at most `maxGroupsPerNight` groups a night.
  readonly dream: { readonly enabled: boolean; readonly hour: number; readonly minNewLines: { readonly direct: number; readonly group: number }; readonly maxGroupsPerNight: number };
}
export type ProfileKey = "chat" | "group";
export interface Preset {
  readonly name: string;
  readonly rhythm: Rhythm;
  // categories: every note category; background: the ones a heartbeat look may write itself (facts, never rules); dream: the ones the owner's dream may write; group and tenant: the ones a group's and a friend's notes (and their dreams) have.
  readonly notes: { readonly categories: readonly string[]; readonly dream: readonly string[]; readonly group: readonly string[]; readonly tenant: readonly string[]; readonly background: readonly string[] };
  readonly profiles: Readonly<Record<ProfileKey, ProfileData>>;
  readonly skills: { readonly core: readonly CoreSkill[]; readonly order: readonly string[] };
  readonly expert: { readonly model: string; readonly maxTurns: number }; // the general expert every run may delegate to (run/delegation.ts); expert-opus is the same on OPUS_MODEL
  readonly persona: Readonly<Record<PromptKey, Template>>;
}

// The Claude plugin that bundles the skills (plugin/skills/<name>/SKILL.md); a skill is named to the model as "<plugin>:<skill>".
export const PLUGIN = "ted-personal-assistant";

// ---- the words: templates with {{name}} (text), {{#name}}..{{/name}} (only when the flag is on) and {{^name}}..{{/name}} (only when off) ----

type Node = string | { kind: "var"; name: string } | { kind: "section"; name: string; not: boolean; body: Node[] };
export interface Template { readonly source: string; readonly nodes: readonly Node[] }
export type Value = string | boolean;

const TAG = /\{\{([#^/]?)\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

export function parseTemplate(source: string, where: string): Template {
  const root: Node[] = [];
  const stack: { name: string; body: Node[] }[] = [{ name: "", body: root }];
  let at = 0;
  for (const m of source.matchAll(TAG)) {
    const top = stack[stack.length - 1]!;
    if (m.index! > at) top.body.push(source.slice(at, m.index));
    at = m.index! + m[0].length;
    const [, mark, name] = m as unknown as [string, string, string];
    if (mark === "") top.body.push({ kind: "var", name });
    else if (mark === "/") {
      if (stack.length === 1 || top.name !== name) throw new Error(`${where}: {{/${name}}} closes ${stack.length === 1 ? "nothing" : `{{#${top.name}}}`}`);
      stack.pop();
    } else {
      const body: Node[] = [];
      top.body.push({ kind: "section", name, not: mark === "^", body });
      stack.push({ name, body });
    }
  }
  if (stack.length > 1) throw new Error(`${where}: {{#${stack[stack.length - 1]!.name}}} is never closed`);
  if (at < source.length) root.push(source.slice(at));
  if (/\{\{|\}\}/.test(source.replace(TAG, ""))) throw new Error(`${where}: a stray "{{" or "}}" (a tag is {{name}}, {{#flag}}...{{/flag}} or {{^flag}}...{{/flag}})`);
  return { source, nodes: root };
}

const namesIn = (nodes: readonly Node[], out: Set<string> = new Set()): Set<string> => {
  for (const n of nodes) if (typeof n !== "string") { out.add(n.name); if (n.kind === "section") namesIn(n.body, out); }
  return out;
};

export function render(t: Template, ctx: Readonly<Record<string, Value>>, where = "template"): string {
  const walk = (nodes: readonly Node[]): string =>
    nodes
      .map((n) => {
        if (typeof n === "string") return n;
        const v = ctx[n.name];
        if (v === undefined) throw new Error(`${where}: {{${n.name}}} has no value`);
        if (n.kind === "var") return String(v);
        return (v === false || v === "") === n.not ? walk(n.body) : "";
      })
      .join("");
  return walk(t.nodes);
}

// Every prompt of the assistant, and the names its template may use (the code that renders it passes exactly these, plus owner and assistant).
// A template naming anything else is refused when the preset loads, not when the first prompt is built.
const COMMON = ["owner", "assistant"];
export const PROMPTS = {
  personality: [],
  participation: [],
  unprompted: [],
  routine: [],
  sources: [],
  send: [],
  noMail: [],
  reactions: ["who"],
  skills: ["mail", "mailSkill"],
  chat: ["mail", "personality", "sources", "reactions", "send", "channel", "mailNote", "logsDir", "ownerDir", "routine", "categories"],
  voice: ["own", "group"],
  summary: [],
  group: ["weather", "browse", "draw", "categories", "personality", "participation", "routine", "sources", "reactions", "send"],
  tenant: ["browse", "weather", "draw", "google", "her", "personality", "routine", "sources", "reactions", "send", "categories"],
  dream: ["subject", "own", "group", "categories", "peopleGuide"],
  background: ["who", "Who", "own", "group", "reads", "mail", "sources", "tasks", "meetings", "delegated", "routines", "dayMinutes"],
  delegate: ["who", "delegated"],
  expert: ["personality", "own", "who"],
  heartbeat: ["now", "timeZone", "who", "lastLook", "quietFrom", "quietTo", "due", "sources", "routineFacts"],
  tasks: ["own", "group", "who"],
  gateGroup: ["participation", "unprompted"],
} as const satisfies Record<string, readonly string[]>;
export type PromptKey = keyof typeof PROMPTS;
const PROMPT_KEYS = Object.keys(PROMPTS) as PromptKey[];

// ---- loading ----

export { ASSISTANTS_DIR };
const NAME = /^[a-z][a-z0-9-]*$/;

const fail = (where: string, what: string): never => {
  throw new Error(`assistant preset ${where}: ${what}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// A preset may start from another one ("extends": "ted") and change only some of it: objects are merged key by key, lists and texts replace.
// A persona file in the folder replaces the base's of the same name.
function readData(dir: string, seen: string[] = []): { json: Record<string, unknown>; files: Map<string, string>; where: string } {
  const where = `"${dir}"`;
  if (seen.includes(dir)) fail(where, `"extends" loops (${[...seen, dir].join(" -> ")})`);
  const file = join(dir, "preset.json");
  if (!existsSync(file)) fail(where, "has no preset.json (a preset is a folder with preset.json and persona/*.md)");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return fail(where, `preset.json is not valid JSON (${(e as Error).message})`);
  }
  if (!isObj(json)) return fail(where, "preset.json must be a JSON object");
  const files = new Map<string, string>();
  let merged = json;
  if (json.extends !== undefined) {
    if (typeof json.extends !== "string" || !NAME.test(json.extends)) fail(where, `"extends" must be the name of another preset (got ${JSON.stringify(json.extends)})`);
    const base = readData(join(ASSISTANTS_DIR, json.extends as string), [...seen, dir]);
    for (const [k, v] of base.files) files.set(k, v);
    merged = mergeInto(base.json, json);
  }
  const persona = join(dir, "persona");
  for (const key of PROMPT_KEYS) {
    const f = join(persona, `${key}.md`);
    if (existsSync(f)) files.set(key, readFileSync(f, "utf8").replace(/\n$/, ""));
  }
  return { json: merged, files, where };
}

const mergeInto = (base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? mergeInto(base[k] as Record<string, unknown>, v) : v;
  return out;
};

const int = (where: string, v: unknown, min: number, max: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fail(where, `must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)})`);
const num = (where: string, v: unknown, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fail(where, `must be a number from ${min} to ${max} (got ${JSON.stringify(v)})`);
const bool = (where: string, v: unknown): boolean => (typeof v === "boolean" ? v : fail(where, `must be true or false (got ${JSON.stringify(v)})`));
const word = (where: string, v: unknown): string => (typeof v === "string" && NAME.test(v) ? v : fail(where, `must be a lower-case word like "daily-brief" (got ${JSON.stringify(v)})`));
const obj = (where: string, v: unknown): Record<string, unknown> => (isObj(v) ? v : fail(where, "must be an object"));
const words = (where: string, v: unknown): string[] => (Array.isArray(v) ? v.map((x, i) => word(`${where}[${i}]`, x)) : fail(where, "must be a list"));

export function loadPreset(dir: string): Preset {
  const { json, files, where } = readData(resolve(dir));
  const at = (path: string) => `${where}: ${path}`;
  const sec = (k: string) => obj(at(k), json[k]);
  const name = typeof json.name === "string" && NAME.test(json.name) ? json.name : fail(where, `"name" must be a lower-case word (got ${JSON.stringify(json.name)})`);

  const r = sec("rhythm");
  const hb = obj(at("rhythm.heartbeat"), r.heartbeat), dr = obj(at("rhythm.dream"), r.dream), mn = obj(at("rhythm.dream.minNewLines"), dr.minNewLines);
  const rhythm: Rhythm = {
    heartbeat: { everyMinutes: int(at("rhythm.heartbeat.everyMinutes"), hb.everyMinutes, 1, 240), dayMinutes: int(at("rhythm.heartbeat.dayMinutes"), hb.dayMinutes, 10, 120), quietFromHour: int(at("rhythm.heartbeat.quietFromHour"), hb.quietFromHour, 0, 23), quietToHour: int(at("rhythm.heartbeat.quietToHour"), hb.quietToHour, 0, 23) },
    dream: {
      enabled: bool(at("rhythm.dream.enabled"), dr.enabled),
      hour: int(at("rhythm.dream.hour"), dr.hour, 0, 23),
      minNewLines: { direct: int(at("rhythm.dream.minNewLines.direct"), mn.direct, 1, 1000), group: int(at("rhythm.dream.minNewLines.group"), mn.group, 1, 1000) },
      maxGroupsPerNight: int(at("rhythm.dream.maxGroupsPerNight"), dr.maxGroupsPerNight, 1, 1000),
    },
  };

  const n = sec("notes");
  const categories = words(at("notes.categories"), n.categories);
  if (categories.length === 0 || new Set(categories).size !== categories.length) fail(at("notes.categories"), "needs at least one category, each once");
  const subset = (path: string, v: unknown): string[] => {
    const list = words(at(path), v);
    const stray = list.find((c) => !categories.includes(c));
    return stray ? fail(at(path), `"${stray}" is not one of notes.categories (${categories.join(", ")})`) : list;
  };
  const notes = { categories, dream: subset("notes.dream", n.dream), group: subset("notes.group", n.group), tenant: subset("notes.tenant", n.tenant), background: n.background === undefined ? [] : words(at("notes.background"), n.background).filter((c) => categories.includes(c)) }; // (a preset that extends another and changes the categories keeps the ones it still has)

  const p = sec("profiles");
  const profile = (key: ProfileKey): ProfileData => {
    const d = obj(at(`profiles.${key}`), p[key]);
    return { maxTurns: int(at(`profiles.${key}.maxTurns`), d.maxTurns, 1, 1000), maxBudgetUsd: num(at(`profiles.${key}.maxBudgetUsd`), d.maxBudgetUsd, 0.01, 1000) };
  };
  const profiles = { chat: profile("chat"), group: profile("group") };

  const s = sec("skills");
  const coreList = Array.isArray(s.core) ? s.core : fail(at("skills.core"), "must be a list");
  const core = coreList.map((c, i): CoreSkill => {
    const d = obj(at(`skills.core[${i}]`), c);
    return { name: word(at(`skills.core[${i}].name`), d.name), ...(d.required === undefined ? {} : { required: bool(at(`skills.core[${i}].required`), d.required) }) };
  });
  const order = words(at("skills.order"), s.order);

  const ex = sec("expert");
  const expert = { model: typeof ex.model === "string" && /^[a-z][a-z0-9.-]*$/.test(ex.model) ? ex.model : fail(at("expert.model"), `must be a model alias or id like "sonnet" (got ${JSON.stringify(ex.model)})`), maxTurns: int(at("expert.maxTurns"), ex.maxTurns, 1, 200) };

  const persona = {} as Record<PromptKey, Template>;
  for (const key of PROMPT_KEYS) {
    const source = files.get(key);
    if (source === undefined) fail(where, `persona/${key}.md is missing (every prompt needs its text)`);
    const file = at(`persona/${key}.md`);
    const t = parseTemplate(source as string, file);
    const allowed = new Set<string>([...COMMON, ...PROMPTS[key]]);
    for (const used of namesIn(t.nodes)) if (!allowed.has(used)) fail(file, `{{${used}}} is not available here (this text may use ${[...allowed].map((a) => `{{${a}}}`).join(", ") || "nothing"})`);
    persona[key] = t;
  }
  return { name, rhythm, notes, profiles, skills: { core, order }, expert, persona };
}

// The preset this process runs: ASSISTANT_PRESET is the name of a folder in assistants/ (default "ted") or the path of one.
const loaded = new Map<string, Preset>();
export function presetFor(env: Readonly<Record<string, string | undefined>> = process.env): Preset {
  const want = env.ASSISTANT_PRESET?.trim() || "ted";
  const dir = isAbsolute(want) ? want : NAME.test(want) ? join(ASSISTANTS_DIR, want) : fail(`"${want}"`, "ASSISTANT_PRESET is the name of a folder in assistants/ (like ted) or the full path of one");
  let p = loaded.get(dir);
  if (!p) loaded.set(dir, (p = loadPreset(dir)));
  return p;
}
export const preset = (): Preset => presetFor(process.env);

// The note categories a conversation has: the owner's chat all of them, a group the preset's notes.group, a friend notes.tenant. Nothing else in the code names a category.
export const categoriesFor = (kind: "owner" | "group" | "tenant", p: Preset = preset()): readonly string[] => (kind === "owner" ? p.notes.categories : kind === "group" ? p.notes.group : p.notes.tenant);
