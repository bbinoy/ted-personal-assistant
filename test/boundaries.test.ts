import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Folder boundaries of src/ (docs/ARCHITECTURE.md "Project layout"): each folder may value-import only the folders below it. Type-only imports are exempt
// (verbatimModuleSyntax erases them), as are dynamic import() calls (the lazy edges, like policy reading modules/index through registered()).
// The table below is the dependency diagram of the layout (docs/ARCHITECTURE.md "Project layout"), top to bottom: heartbeat, conversation, run, modules, approvals, policy,
// tenants / intake / memory, secrets, core. A folder may import the ones below it; nothing imports the entry points. The accepted exceptions are named in the rows.

const SRC = resolve(fileURLToPath(new URL("../src", import.meta.url)));

// The folder of a file: "." for src/x.ts, "modules" for src/modules/x.ts, "modules/*" for a feature folder src/modules/<feature>/x.ts, else the first segment.
export const folderOf = (rel: string): string => {
  const parts = rel.split("/").slice(0, -1);
  if (parts.length === 0) return ".";
  if (parts[0] === "modules") return parts.length === 1 ? "modules" : "modules/*";
  return parts[0]!;
};

// folder -> folders it may value-import (itself is always fine). Absent folder = not in the layout yet = no file may sit there (add a row when a chunk creates it).
export const ALLOWED: Record<string, readonly string[]> = {
  // The entry points (main.ts, cli.ts, doctor.ts) are the only files in the src/ root; they wire everything, so they may import anything.
  ".": ["*"],
  // The tick and the look of every conversation: starts the jobs, so it sits on top of everything below.
  heartbeat: ["conversation", "run", "modules", "modules/*", "approvals", "policy", "tenants", "intake", "memory", "tasks", "secrets", "core"],
  // The pipeline of every conversation (and the dream and the friend's turn, which read all of them), above the run machinery.
  conversation: ["run", "modules", "modules/*", "approvals", "policy", "tenants", "intake", "memory", "tasks", "secrets", "core"],
  // What a model run is made of (agent, agentrun, options, profiles, persona, the session, the heartbeat run's scope and delegation); it binds the module servers through modules/runtime.ts.
  run: ["modules", "modules/*", "approvals", "policy", "tenants", "intake", "memory", "secrets", "core"],
  // modules/index.ts, types.ts, runtime.ts, skills.ts, connectors.ts and the single-file declarations (policy leaves + the binding point).
  modules: ["modules/*", "approvals", "policy", "tenants", "intake", "memory", "secrets", "core"],
  // a feature folder: its declaration (light) and its server, guard, rules and store files. -> conversation is accepted: the voice tool sends through the messenger and lists the
  // groups, the memory module scopes a group's notes (dreamscope.ts). The pipeline wires features in the other direction (conversation -> modules/*), so this is the one mutual pair.
  "modules/*": ["modules", "conversation", "approvals", "policy", "tenants", "intake", "memory", "tasks", "secrets", "core"],
  // policy decides from data only, approvals sit above it.
  approvals: ["modules", "modules/*", "policy", "tenants", "intake", "memory", "secrets", "core"], // approvals -> modules/browse (payment wording) is accepted
  policy: ["modules", "tenants", "intake", "memory", "secrets", "core"], // reads modules/index lazily; never imports approvals; capabilities.ts reads the intake links, policy.ts knows what a note path is
  // tenants, intake and memory are one box, above the secrets. tenants also holds the payer (who pays for a call), the failures a refused call raises and the one-shot Haiku call.
  tenants: ["intake", "memory", "secrets", "core"],
  intake: ["modules/*", "tenants", "memory", "secrets", "core"], // intake -> modules/browse (the card and profile items) is accepted
  memory: ["tenants", "intake", "secrets", "core"],
  // the tasks of a conversation (store over its assistant.db, repeat rules, local-time arithmetic, the lists as text): a domain leaf, it needs the core only. The tool server (modules/tasks) and the /tasks command sit above it.
  tasks: ["core"],
  secrets: ["core"],
  // the bottom: settings, state, audit, the message log and the other leaves; imports nothing of the app.
  core: [],
};

// Files nothing under src/ may import: the entry points.
const ENTRY = new Set(["main.ts", "cli.ts"]);

export type Graph = Record<string, string[]>; // src-relative file -> src-relative files it value-imports

export function violations(graph: Graph, allowed: Record<string, readonly string[]> = ALLOWED): string[] {
  const out: string[] = [];
  for (const [file, deps] of Object.entries(graph)) {
    const from = folderOf(file);
    const rule = allowed[from];
    if (!rule) {
      out.push(`${file}: folder "${from}" has no row in ALLOWED (test/boundaries.test.ts)`);
      continue;
    }
    for (const dep of deps) {
      const to = folderOf(dep);
      if (ENTRY.has(dep)) out.push(`${file} imports the entry point ${dep}`);
      if (to !== from && !rule.includes("*") && !rule.includes(to)) out.push(`${file} (${from}) imports ${dep} (${to}): not an allowed direction`);
    }
  }
  return out;
}

// Static value imports and re-exports of one source text, as relative specifiers. `import type` / `export type` are skipped; `import { type A }` is a value import (kept by verbatimModuleSyntax).
export function valueSpecifiers(text: string): string[] {
  return [...text.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?"(\.[^"]+)";/gms)].filter((m) => !m[1]).map((m) => m[2]!);
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

function srcGraph(): Graph {
  const graph: Graph = {};
  for (const abs of walk(SRC)) {
    const deps = valueSpecifiers(readFileSync(abs, "utf8")).map((s) => relative(SRC, resolve(dirname(abs), s)));
    graph[relative(SRC, abs)] = deps;
  }
  return graph;
}

test("boundaries: no file under src/ value-imports against the folder table", () => {
  const graph = srcGraph();
  assert.ok(Object.keys(graph).length > 100, "the walk found src/");
  assert.deepEqual(violations(graph), []);
});

test("boundaries: every relative value import stays inside src/ and names a file that exists", () => {
  const graph = srcGraph();
  const bad = Object.entries(graph).flatMap(([f, deps]) => deps.filter((d) => d.startsWith("..") || !(d in graph)).map((d) => `${f} -> ${d}`));
  assert.deepEqual(bad, [], "packages are imported by name (@ted-assistant/...), never by a relative path");
});

test("boundaries: every feature folder under src/modules/ holds its declaration as module.ts", () => {
  const features = readdirSync(join(SRC, "modules"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(features.length > 0, "the walk found the feature folders");
  const without = features.filter((f) => !readdirSync(join(SRC, "modules", f)).includes("module.ts"));
  assert.deepEqual(without, [], "module.ts is the light declaration; the server, guard, rules and store files sit next to it");
});

test("boundaries: the src/ root holds only the entry points", () => {
  const root = readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  assert.deepEqual(root, ["cli.ts", "doctor.ts", "main.ts"], "everything else belongs in a folder (docs/ARCHITECTURE.md \"Project layout\")");
});

test("boundaries: the checker rejects a deliberately wrong import", () => {
  // a made-up graph in the target layout: core reaching up into approvals, a policy file importing a feature, a module importing the entry point
  const wrong: Graph = {
    "core/settings.ts": ["approvals/ask.ts"],
    "policy/classify.ts": ["modules/draw/server.ts"],
    "modules/index.ts": ["main.ts"],
    "secrets/store.ts": ["core/settings.ts"],
  };
  const found = violations(wrong);
  assert.equal(found.length, 4, found.join("\n"));
  assert.match(found[0]!, /core\/settings\.ts \(core\) imports approvals\/ask\.ts \(approvals\)/);
  assert.match(found[1]!, /policy\/classify\.ts/);
  assert.match(found[2]!, /entry point main\.ts/);
  assert.match(found[3]!, /modules\/index\.ts \(modules\) imports main\.ts/);
  assert.deepEqual(violations({ "secrets/store.ts": ["core/settings.ts"], "core/settings.ts": [] }), [], "a downward import is fine");
  assert.match(violations({ "unlisted/x.ts": [] })[0]!, /no row in ALLOWED/);
});

test("boundaries: the import reader skips type imports and sees multi-line value imports", () => {
  const text = [
    'import type { A } from "./a.ts";',
    'import { b } from "./b.ts";',
    'import {\n  c,\n  type D,\n} from "./c.ts";',
    'export type { E } from "./e.ts";',
    'export { f } from "./f.ts";',
    'import "./side.ts";',
    'import { pkg } from "@ted-assistant/speech/tts";',
    'const lazy = () => import("./lazy.ts");',
  ].join("\n");
  assert.deepEqual(valueSpecifiers(text), ["./b.ts", "./c.ts", "./f.ts", "./side.ts"]);
});
