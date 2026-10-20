import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSETS_DIR, ASSISTANTS_DIR, dataDirOf, PLUGIN_DIR, ROOT, VOICES_DIR } from "../src/core/paths.ts";

// src/core/paths.ts is the only file that locates the repo; a file moved into a folder must not change where the data dir or the assets are.

const REPO = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");

test("paths: ROOT is the repo root (the folder with the root package.json)", () => {
  assert.equal(ROOT, REPO);
  assert.ok(existsSync(join(ROOT, "package.json")));
  assert.equal(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).private, true, "the root package, not a workspace package");
  assert.ok(existsSync(join(ROOT, "src", "core", "paths.ts")));
});

test("paths: the shipped folders exist under ROOT", () => {
  for (const d of [PLUGIN_DIR, ASSETS_DIR, VOICES_DIR, ASSISTANTS_DIR]) assert.ok(existsSync(d), d);
  assert.equal(PLUGIN_DIR, join(ROOT, "plugin"));
});

test("paths: the default data dir is the repo root, an override wins", () => {
  assert.equal(dataDirOf({}), ROOT);
  assert.notEqual(dataDirOf({}), join(ROOT, "src"));
  assert.equal(dataDirOf({ HARNESS_DATA_DIR: "/tmp/x" }), "/tmp/x");
});

test("paths: settings, loaded with HARNESS_DATA_DIR unset, puts the data dir at the repo root", () => {
  const env = { ...process.env };
  delete env.HARNESS_DATA_DIR;
  const code = `import(${JSON.stringify(new URL("../src/core/settings.ts", import.meta.url).href)}).then(({ settings }) => console.log(JSON.stringify([settings.dataDir, settings.pluginDir])));`;
  const out = execFileSync(process.execPath, ["--conditions=workspace-source", "-e", code], { env, encoding: "utf8" });
  const [dataDir, pluginDir] = JSON.parse(out.trim().split("\n").pop()!);
  assert.equal(dataDir, ROOT);
  assert.equal(pluginDir, join(ROOT, "plugin"));
});
