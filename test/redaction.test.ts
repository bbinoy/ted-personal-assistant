import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitRecord } from "../src/core/events.ts";
import { redact, redactSecrets } from "../src/core/redact.ts";
import { readText } from "../src/core/state.ts";
import { layout, logPaths } from "../src/core/convpaths.ts";

// Fake credentials are assembled here so that no real-looking token sits in the source (npm run check:secrets).
const body = (n: number) => "a1B2c3D4e5".repeat(Math.ceil(n / 10)).slice(0, n);

test("redact: more kinds of credential are masked, and a JSON line stays JSON", () => {
  const cases: [string, string][] = [
    [`key ${"sk" + "_" + body(48)} done`, "key sk-*** done"],
    [`gh ${"ghp" + "_" + body(36)} done`, "gh *** done"],
    [`slack ${"xoxb" + "-" + body(24)}`, "slack ***"],
    [`aws ${"AKIA" + "ABCDEFGHIJKLMNOP"}`, "aws ***"],
    [`jwt ${["eyJ" + body(12), body(20), body(10)].join(".")}`, "jwt ***"],
    [`curl -H "xi-api-key: ${body(30)}" x`, `curl -H "xi-api-key: ***" x`],
    [`GET https://api.example.com/v1/x?voice=a&api_key=${body(20)}&n=1`, "GET https://api.example.com/v1/x?voice=a&api_key=***&n=1"],
    [`TTS_HTTP_TOKEN=${body(16)} and ELEVENLABS_API_KEY=${body(16)}`, "TTS_HTTP_TOKEN=*** and ELEVENLABS_API_KEY=***"],
    [`https://user:${body(12)}@host.example.com/path`, "https://user:***@host.example.com/path"],
    [`Authorization: Basic ${body(24)}`, "Authorization: Basic ***"],
  ];
  for (const [input, want] of cases) assert.equal(redactSecrets(input), want);
  // ordinary text is left alone
  for (const same of ["Basic organisation chart attached", "the API key is stored in .env", "MAX_TOKENS is 5", "tokens=12", "a@b.com wrote 2026-10-14T10:00:00Z"]) assert.equal(redactSecrets(same), same);
  const line = JSON.stringify({ ts: "x", decision: "failed", meta: { error: `boom ANTHROPIC_API_KEY=${body(20)}`, other: "ok" } });
  const redacted = JSON.parse(redactSecrets(line)) as { meta: { error: string; other: string } };
  assert.equal(redacted.meta.error, "boom ANTHROPIC_API_KEY=***");
  assert.equal(redacted.meta.other, "ok");
  // the log version also masks phone numbers; the secrets-only one does not
  assert.equal(redact("from +15555550105"), "from +***05");
  assert.equal(redactSecrets("from +15555550105"), "from +15555550105");
});

test("audit: a credential in an error message is masked, a sender and subject stay readable", () => {
  const token = body(24);
  emitRecord("test_redaction", "failed", "chat", { error: `request failed: Bearer ${token}`, from: "Anna <anna@example.com>", subject: "Call +15555550105 back" });
  const last = (readText(logPaths().audit) ?? "").trim().split("\n").filter((l) => l.includes('"test_redaction"')).at(-1)!; // other test files write to the same log at the same time
  const e = JSON.parse(last) as { meta: { error: string; from: string; subject: string } };
  assert.ok(!last.includes(token));
  assert.equal(e.meta.error, "request failed: Bearer ***");
  assert.equal(e.meta.from, "Anna <anna@example.com>");
  assert.equal(e.meta.subject, "Call +15555550105 back");
});

test("log.ts: warnings and info are redacted and written to the log file too, and a circular object does not make logging throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-test-"));
  try {
    const script = `
      await import("./src/core/log.ts");
      const loop = {}; loop.self = loop;
      console.warn("read receipt failed: Bearer " + ${JSON.stringify(body(24))} + " for +15555550105");
      console.info("info line key=ok");
      console.log(loop);
      console.error("TTS_HTTP_TOKEN=" + ${JSON.stringify(body(16))});`;
    execFileSync(process.execPath, ["--conditions=workspace-source", "--input-type=module", "-e", script], { env: { PATH: process.env.PATH, HARNESS_DATA_DIR: dir } });
    const text = readFileSync(layout(dir).logs.agent, "utf8");
    assert.match(text, /WARN read receipt failed: Bearer \*\*\* for \+\*\*\*05/);
    assert.match(text, /info line key=ok/);
    assert.match(text, /\[object Object\]/);
    assert.match(text, /ERR TTS_HTTP_TOKEN=\*\*\*/);
    assert.ok(!text.includes(body(24)) && !text.includes(body(16)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
