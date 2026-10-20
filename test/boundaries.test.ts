import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Folder boundaries of src/ (docs/ARCHITECTURE.md "Project layout"): each folder may value-import only the folders below it. Type-only imports are exempt
// (verbatimModuleSyntax erases them), as are dynamic import() calls (the lazy edges, like policy reading modules/index through registered()).
// The table below is the dependency diagram of the target layout. It starts PERMISSIVE: today's src/ is flat, so only the folders that exist are checked,
// and every folder may still import the flat root (".", TRANSITIONAL). Each restructure chunk that moves files into a folder removes what no longer applies.

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
  // TRANSITIONAL: the flat src/ root is every file that has not moved yet. It may import anything; it shrinks to main.ts, cli.ts and doctor.ts.
  ".": ["*"],
  // modules/index.ts, types.ts, runtime.ts and the single-file declarations (policy leaves + the binding point).
  modules: [".", "modules/*", "approvals", "policy", "tenants", "intake", "memory", "secrets", "core"],
  // a feature folder: its declaration (light) and its server, guard, rules and store files.
  "modules/*": [".", "modules", "approvals", "policy", "tenants", "intake", "memory", "secrets", "core"],
  // the folders of the target layout that do not exist yet (rows stay until their chunk lands):
  heartbeat: [".", "conversation", "run", "modules", "modules/*", "approvals", "policy", "tenants", "intake", "memory", "secrets", "core"],
  conversation: [".", "run", "modules", "modules/*", "approvals", "policy", "tenants", "intake", "memory", "secrets", "core"],
  run: [".", "modules", "modules/*", "approvals", "policy", "tenants", "intake", "memory", "secrets", "core"],
  approvals: [".", "modules", "modules/*", "policy", "tenants", "intake", "memory", "secrets", "core"], // approvals -> modules/browse (payment wording) is accepted
  policy: [".", "modules", "tenants", "secrets", "core"], // reads modules/index lazily
  tenants: [".", "intake", "memory", "secrets", "core"],
  intake: [".", "modules/*", "tenants", "memory", "secrets", "core"], // intake -> modules/browse (the card and profile items) is accepted
  memory: [".", "tenants", "intake", "secrets", "core"],
  secrets: [".", "core"],
  core: ["."],
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

test("boundaries: the checker rejects a deliberately wrong import", () => {
  // a made-up graph in the target layout: core reaching up into approvals, a policy file importing a feature, a module importing the entry point
  const wrong: Graph = {
    "core/settings.ts": ["approvals/ask.ts"],
    "policy/classify.ts": ["modules/draw/server.ts"],
    "modules/index.ts": ["main.ts"],
    "secrets/store.ts": ["core/settings.ts"],
  };
  const found = violations(wrong);
  assert.equal(found.length, 3, found.join("\n"));
  assert.match(found[0]!, /core\/settings\.ts \(core\) imports approvals\/ask\.ts \(approvals\)/);
  assert.match(found[1]!, /policy\/classify\.ts/);
  assert.match(found[2]!, /entry point main\.ts/);
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
