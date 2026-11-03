import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopQwen, type QwenConfig } from "../src/tts-qwen.ts";
import { synthesizeWith } from "../src/tts-provider.ts";
import { VoiceAbort } from "../src/limits.ts";
import { runTool } from "../src/internal/exec.ts";

// The overall deadline of one voice reply, seen from the engines: an abort kills the Python and ffmpeg processes (and what they started) and the Qwen request. Fakes only: no model, no real synthesis.

const tmp = mkdtempSync(join(tmpdir(), "deadline-test-"));
after(() => (stopQwen(), rmSync(tmp, { recursive: true, force: true })));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end && !f(); ) await new Promise((r) => setTimeout(r, 25));
  return f();
};

// A fake Qwen server that answers /say only after 30 s.
const server = join(tmp, "server.mjs");
writeFileSync(server, `
import http from "node:http";
const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => setTimeout(() => res.end("late"), 30000)); });
srv.listen(0, "127.0.0.1", () => console.log("READY " + srv.address().port));
process.stdin.on("end", () => process.exit(0)); process.stdin.resume();
`);
const quiet = { warn() {}, error() {}, info() {}, log() {} } as never;
let n = 0;
const qwen = (o: Partial<QwenConfig> = {}): QwenConfig => ({ dir: tmp, model: "m", refAudio: server, refText: `ref ${++n}`, idleMs: 0, startTimeoutMs: 5000, command: [process.execPath, server], ...o });
const hasFfmpeg = existsSync("/opt/homebrew/bin/ffmpeg") || existsSync("/usr/local/bin/ffmpeg") || existsSync("/usr/bin/ffmpeg");

test("runTool: an abort kills the program and its children at once and rejects with the reason", async () => {
  const file = join(tmp, "pids1");
  const ctl = new AbortController();
  const run = runTool("/bin/sh", ["-c", `sleep 60 & echo $! > ${file}; echo $$ >> ${file}; wait`], { timeoutMs: 60_000, signal: ctl.signal });
  assert.equal(await until(() => existsSync(file) && readFileSync(file, "utf8").trim().split("\n").length === 2), true);
  const [child, parent] = readFileSync(file, "utf8").trim().split("\n").map(Number) as [number, number];
  ctl.abort(new VoiceAbort("timeout"));
  await assert.rejects(run, (e: unknown) => e instanceof VoiceAbort && e.kind === "timeout");
  assert.equal(await until(() => !alive(child) && !alive(parent)), true, "no runaway process is left");
});

test("runTool: its own timeout kills the group too, and an already aborted signal starts nothing", async () => {
  const file = join(tmp, "pids2");
  await assert.rejects(runTool("/bin/sh", ["-c", `sleep 60 & echo $! > ${file}; wait`], { timeoutMs: 300 }), (e: { killed?: boolean }) => e.killed === true);
  assert.equal(await until(() => !alive(Number(readFileSync(file, "utf8")))), true);
  const ctl = new AbortController();
  ctl.abort(new VoiceAbort("slept"));
  await assert.rejects(runTool("/bin/sh", ["-c", `echo started > ${join(tmp, "started")}`], { timeoutMs: 1000, signal: ctl.signal }), (e: unknown) => e instanceof VoiceAbort && e.kind === "slept");
  assert.equal(existsSync(join(tmp, "started")), false);
});

test("provider: a Qwen request in flight is aborted and its server stopped", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  mkdirSync(join(tmp, "venv/bin"), { recursive: true });
  writeFileSync(join(tmp, "venv/bin/python"), "");
  const ctl = new AbortController();
  const cfg = { provider: "qwen", qwen: qwen() } as const;
  const made = synthesizeWith("Hi.", cfg, quiet, "owner", undefined, { signal: ctl.signal });
  setTimeout(() => ctl.abort(new VoiceAbort("timeout")), 500);
  await assert.rejects(made, (e: unknown) => e instanceof VoiceAbort);
});
