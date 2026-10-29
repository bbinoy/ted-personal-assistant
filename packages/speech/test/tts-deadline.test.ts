import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopQwen, type QwenConfig } from "../src/tts-qwen.ts";
import { synthesizeWith } from "../src/tts-provider.ts";
import { VoiceAbort } from "../src/limits.ts";
import { runTool } from "../src/internal/exec.ts";

// The overall deadline of one voice reply, seen from the engines: an abort kills the Python and ffmpeg processes (and what they started) and the Qwen request, a fallback that could
// not finish in the time left is not started, and a fast failure still falls back. Fakes only: no model, no real synthesis.

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

// A fake Qwen server that answers /say only after 30 s, and a fake Kokoro whose "python" starts a grandchild and then hangs.
const server = join(tmp, "server.mjs");
writeFileSync(server, `
import http from "node:http";
const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => setTimeout(() => res.end("late"), 30000)); });
srv.listen(0, "127.0.0.1", () => console.log("READY " + srv.address().port));
process.stdin.on("end", () => process.exit(0)); process.stdin.resume();
`);
const kdir = join(tmp, "kokoro");
mkdirSync(join(kdir, "venv/bin"), { recursive: true });
writeFileSync(join(kdir, "kokoro-v1.0.onnx"), "");
writeFileSync(join(kdir, "voices-v1.0.bin"), "");
const python = join(kdir, "venv/bin/python");
const pids = join(tmp, "pids");
const writeKokoro = (body: string) => (writeFileSync(python, `#!/bin/sh\n${body}\n`), chmodSync(python, 0o755));
const kokoro = { dir: kdir, voice: "am_onyx", speed: 1 };
const quiet = { warn() {}, error() {}, info() {}, log() {} } as never;
let n = 0;
const qwen = (o: Partial<QwenConfig> = {}): QwenConfig => ({ dir: tmp, model: "m", refAudio: server, refText: `ref ${++n}`, timeoutMs: 20_000, idleMs: 0, startTimeoutMs: 5000, command: [process.execPath, server], ...o });
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

test("provider: an abort while Kokoro speaks kills it and leaves no folder; no second engine is tried", async () => {
  writeKokoro(`sleep 60 & echo $! > ${pids}; wait`);
  const ctl = new AbortController();
  const made = synthesizeWith("Hi.", { provider: "kokoro", fallback: "none", kokoro }, quiet, "owner", undefined, { signal: ctl.signal, remainingMs: () => 60_000 });
  assert.equal(await until(() => existsSync(pids)), true);
  const child = Number(readFileSync(pids, "utf8"));
  ctl.abort(new VoiceAbort("timeout"));
  await assert.rejects(made, (e: unknown) => e instanceof VoiceAbort);
  assert.equal(await until(() => !alive(child)), true);
});

test("provider: a Qwen request in flight is aborted, its server stopped, and Kokoro is NOT started", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  rmSync(pids, { force: true });
  writeKokoro(`echo started > ${pids}`);
  mkdirSync(join(tmp, "venv/bin"), { recursive: true });
  writeFileSync(join(tmp, "venv/bin/python"), "");
  const ctl = new AbortController();
  const cfg = { provider: "qwen", fallback: "kokoro", kokoro, qwen: qwen() } as const;
  const made = synthesizeWith("Hi.", cfg, quiet, "owner", undefined, { signal: ctl.signal, remainingMs: () => 60_000 });
  setTimeout(() => ctl.abort(new VoiceAbort("timeout")), 500);
  await assert.rejects(made, (e: unknown) => e instanceof VoiceAbort);
  assert.equal(existsSync(pids), false, "the fallback did not run after the deadline");
});

test("provider: Qwen failed and less than 30 s are left: Kokoro is skipped; with time left a fast failure still falls back", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const w = join(tmp, "k.wav");
  const b = Buffer.alloc(44 + 1600);
  b.write("RIFF", 0); b.writeUInt32LE(36 + 1600, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(1600, 40);
  writeFileSync(w, b);
  rmSync(pids, { force: true });
  writeKokoro(`cat >/dev/null; echo ran > ${pids}; cp "${w}" "$6"`);
  mkdirSync(join(tmp, "venv/bin"), { recursive: true });
  writeFileSync(join(tmp, "venv/bin/python"), "");
  const failing = { provider: "qwen", fallback: "kokoro", kokoro, qwen: qwen({ command: [process.execPath, "-e", "console.error('boom'); process.exit(3)"] }) } as const;
  const warns: string[] = [];
  const log = { warn: (...a: unknown[]) => warns.push(a.join(" ")), error() {}, info() {}, log() {} } as never;
  await assert.rejects(synthesizeWith("Hi.", failing, log, "owner", undefined, { remainingMs: () => 29_000 }), (e: unknown) => e instanceof VoiceAbort && e.kind === "timeout");
  assert.equal(existsSync(pids), false, "Kokoro did not run");
  assert.match(warns.join("\n"), /too few for Kokoro/);
  const file = await synthesizeWith("Hi.", failing, log, "owner", undefined, { remainingMs: () => 60_000 });
  assert.equal(readFileSync(pids, "utf8").trim(), "ran", "a fast failure with time left falls back to Kokoro");
  assert.ok(readFileSync(file).length > 0);
  rmSync(join(file, ".."), { recursive: true, force: true });
});
