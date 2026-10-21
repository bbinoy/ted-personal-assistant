import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The intake page is a separate process: it must use the same redacting logger as the agent, and its launchd stderr file must be trimmed at start.
const ROOT = new URL("..", import.meta.url).pathname;
const TOKEN = "sk-" + "ant-api03-" + "Z".repeat(30);

test("the intake entry imports the redacting logger before anything else", () => {
  const src = readFileSync(join(ROOT, "scripts/intake.ts"), "utf8");
  const firstImport = /^import .*$/m.exec(src.split("\n").filter((l) => !l.startsWith("//")).join("\n"))![0];
  assert.match(firstImport, /src\/core\/log\.ts/);
});

test("with the logger imported, a token-shaped string is redacted in the log and the intake stderr file is trimmed at start", () => {
  const data = mkdtempSync(join(tmpdir(), "intakelog-"));
  mkdirSync(join(data, "logs"), { recursive: true });
  const stderr = join(data, "logs", "intake-launchd-stderr.log");
  writeFileSync(stderr, "old crash line\n".repeat(500_000)); // ~7.5 MB: over the 5 MB limit
  const code = `import "./src/core/log.ts"; console.log("intake: could not store ${TOKEN} for the friend"); console.error("bad bearer ${TOKEN}");`;
  const r = spawnSync(process.execPath, ["--conditions=workspace-source", "--input-type=module", "-e", code], { cwd: ROOT, env: { ...process.env, HARNESS_DATA_DIR: data }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(join(data, "logs", "agent.log"), "utf8");
  assert.doesNotMatch(log, /sk-ant-api03-Z{10}/);
  assert.match(log, /intake: could not store .* for the friend/);
  assert.ok(statSync(stderr).size <= 1024 * 1024 + 100, "trimmed to about 1 MB");
});
