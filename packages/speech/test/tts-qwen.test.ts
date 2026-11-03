import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { qwenReady, stopQwen, synthesizeQwen, warmQwen, type QwenConfig } from "../src/tts-qwen.ts";
import { providerReady, synthesizeWith } from "../src/tts-provider.ts";

// The Python server is replaced by a small fake (a node script with the same protocol); no model is loaded.

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } });
    return true;
  } catch {
    return false;
  }
})();
const skip = !hasFfmpeg && "ffmpeg is not installed";

const tmp = mkdtempSync(join(tmpdir(), "qwen-test-"));
after(() => (stopQwen(), rmSync(tmp, { recursive: true, force: true })));

const fake = join(tmp, "fake.mjs");
writeFileSync(fake, `
import http from "node:http";
const mode = process.argv[2];
if (mode === "crash") { console.error("boom: no model"); process.exit(3); }
if (mode === "hang") setInterval(() => {}, 1000);
else {
  const n = 800, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  const held = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/release") { const h = held.shift(); if (h) { h.writeHead(200, { "content-type": "audio/wav" }); h.end(b); } return res.end("ok"); }
    req.on("end", () => {
      if (req.headers["x-qwen-key"] !== process.env.QWEN_TTS_NONCE) { res.writeHead(403); return res.end("forbidden"); }
      if (mode === "hold") return held.push(res); // answered when the test posts /release, oldest first
      if (mode === "slow") return; // never answers
      if (mode === "bad") { res.writeHead(500); return res.end("RuntimeError: out of memory"); }
      res.writeHead(200, { "content-type": "audio/wav" }); res.end(b);
    });
  });
  const up = () => srv.listen(0, "127.0.0.1", () => console.log("READY " + srv.address().port));
  if (mode === "cold") setTimeout(up, 2500); else up(); // "cold": a slow start (the model loads)
  process.stdin.on("end", () => process.exit(0)); process.stdin.resume();
}
`);

let n = 0;
const cfg = (mode: string, o: Partial<QwenConfig> = {}): QwenConfig => ({
  dir: tmp, model: "m", refAudio: fake, refText: `ref ${++n}`, idleMs: 0, startTimeoutMs: 5000,
  command: [process.execPath, fake, mode], ...o,
});
const gone = (f: string) => rmSync(dirname(f), { recursive: true, force: true });

test("qwenReady names what is missing", () => {
  const r = qwenReady({ dir: join(tmp, "none"), refAudio: join(tmp, "none.wav"), refText: " " });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.includes("setup:tts-qwen")) && r.missing.includes("TTS_REF_AUDIO file") && r.missing.includes("TTS_REF_TEXT"));
  mkdirSync(join(tmp, "ok/venv/bin"), { recursive: true });
  writeFileSync(join(tmp, "ok/venv/bin/python"), "");
  const ok = qwenReady({ dir: join(tmp, "ok"), refAudio: fake, refText: "x" });
  assert.deepEqual(ok.missing.filter((m) => m !== "ffmpeg"), []);
});

test("qwen: starts on first use, speaks on loopback with a key, and is reused", { skip }, async () => {
  const urls: string[] = [];
  const keys: (string | undefined)[] = [];
  const fetchImpl = ((u: string, init: RequestInit) => (urls.push(u), keys.push((init.headers as Record<string, string>)["x-qwen-key"]), fetch(u, init))) as typeof fetch;
  const c = cfg("ok", { fetchImpl });
  const a = await synthesizeQwen("Hello.", c);
  const b = await synthesizeQwen("Again.", c);
  assert.ok(a.endsWith("voice.m4a") && b.endsWith("voice.m4a"));
  assert.equal(new Set(urls.map((u) => new URL(u).port)).size, 1, "one server, kept loaded");
  assert.ok(urls.every((u) => new URL(u).hostname === "127.0.0.1"));
  assert.ok(keys.every((k) => k && k.length >= 32));
  gone(a);
  gone(b);
});

test("qwen: a request without the key is refused by the server", { skip }, async () => {
  let port = 0;
  const c = cfg("ok", { fetchImpl: ((u: string, init: RequestInit) => ((port = Number(new URL(u).port)), fetch(u, init))) as typeof fetch });
  gone(await synthesizeQwen("x", c));
  assert.ok(port > 0);
  assert.equal((await fetch(`http://127.0.0.1:${port}/say`, { method: "POST", body: "{}" })).status, 403);
});

test("qwen: a server that crashes at start is an error with its stderr", async () => {
  await assert.rejects(synthesizeQwen("Hi.", cfg("crash")), /Qwen voice server exited \(code 3.*boom: no model/);
  assert.match((await warmQwen(cfg("crash"))) ?? "", /boom/);
});

test("qwen: a server that never gets ready times out", async () => {
  await assert.rejects(synthesizeQwen("Hi.", cfg("hang", { startTimeoutMs: 400 })), /did not start within/);
});

test("qwen: a slow answer times out, and a server error is named", { skip }, async () => {
  await assert.rejects(synthesizeQwen("Hi.", cfg("slow", { generationMs: () => 1500 })), /timeout after/);
  await assert.rejects(synthesizeQwen("Hi.", cfg("bad")), /HTTP 500.*out of memory/);
});

// "hold": the fake server answers a text only when the test releases it, so no timing decides the order of events.
const traced = (log: string[]) => ((u: string, init: RequestInit) => (log.push(`${new URL(u).port}:${JSON.parse(String(init.body)).text}`), fetch(u, init))) as typeof fetch;
const until = async (f: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end && !f(); ) await new Promise((r) => setTimeout(r, 10));
  assert.ok(f(), "condition was not reached");
};
const release = async (log: string[]) => void (await fetch(`http://127.0.0.1:${log[0]!.split(":")[0]}/release`, { method: "POST", body: "{}" }));

test("qwen: concurrent replies are served one at a time, in order", { skip }, async () => {
  const log: string[] = [];
  const c = cfg("hold", { fetchImpl: traced(log) });
  const both = Promise.all([synthesizeQwen("first", c), synthesizeQwen("second", c)]);
  await until(() => log.length === 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(log.length, 1, "the second waits while the first is running");
  await release(log);
  await until(() => log.length === 2);
  await release(log);
  const [a, b] = await both;
  assert.ok(a.endsWith("voice.m4a") && b.endsWith("voice.m4a"));
  assert.deepEqual(log.map((x) => x.split(":")[1]), ["first", "second"]);
  assert.equal(new Set(log.map((x) => x.split(":")[0])).size, 1, "no restart");
  gone(a);
  gone(b);
});

test("qwen: an aborted waiting reply leaves the running one and the next one working, and does not stop the server", { skip }, async () => {
  const log: string[] = [];
  const c = cfg("hold", { fetchImpl: traced(log) });
  const ac = new AbortController();
  const first = synthesizeQwen("first", c);
  const second = synthesizeQwen("second", c, undefined, undefined, ac.signal);
  const third = synthesizeQwen("third", c);
  second.catch(() => {});
  await until(() => log.length === 1); // the first is running; the others are queued
  ac.abort(new Error("gave up"));
  await assert.rejects(second, /gave up/);
  await release(log);
  await until(() => log.length === 2);
  await release(log);
  const [a, t] = await Promise.all([first, third]);
  assert.deepEqual(log.map((x) => x.split(":")[1]), ["first", "third"]);
  assert.equal(new Set(log.map((x) => x.split(":")[0])).size, 1, "the server was not stopped");
  gone(a);
  gone(t);
});

test("qwen: an idle server is stopped, the next reply starts a new one", { skip }, async () => {
  const ports: number[] = [];
  const fetchImpl = ((u: string, init: RequestInit) => (ports.push(Number(new URL(u).port)), fetch(u, init))) as typeof fetch;
  const c = cfg("ok", { idleMs: 50, fetchImpl });
  gone(await synthesizeQwen("One.", c));
  let stopped = false; // observe the stop itself: the old port stops answering
  for (const end = Date.now() + 20_000; !stopped && Date.now() < end; ) {
    stopped = await fetch(`http://127.0.0.1:${ports[0]}/`, { method: "POST", body: "{}" }).then(() => false, () => true);
    if (!stopped) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(stopped, "the idle server was stopped");
  gone(await synthesizeQwen("Two.", c));
  assert.equal(ports.length, 2);
  assert.notEqual(ports[0], ports[1]);
});

test("qwen: a slow cold start does not take time from the generation", { skip }, async () => {
  // the generation limit (1.5 s here) is shorter than the start (2.5 s): counted from the call, the request would have timed out
  const f = await synthesizeQwen("Hi.", cfg("cold", { generationMs: () => 1500 }));
  assert.ok(f.endsWith("voice.m4a"));
  gone(f);
});

test("provider: Qwen not set up or failing is an error (the words go out as text); no other voice is tried", { skip }, async () => {
  const notSetUp = { provider: "qwen", qwen: cfg("ok", { dir: join(tmp, "missing"), command: undefined }) } as const;
  await assert.rejects(synthesizeWith("Hi.", notSetUp), /Qwen voice not set up/);
  assert.equal(providerReady(notSetUp).ok, false);
  mkdirSync(join(tmp, "venv/bin"), { recursive: true });
  writeFileSync(join(tmp, "venv/bin/python"), ""); // the Qwen environment "exists"; the fake command then crashes
  await assert.rejects(synthesizeWith("Hi.", { provider: "qwen", qwen: cfg("crash") }), /Qwen voice server/);
});

test("the Python server binds to loopback only and checks the key", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/qwen-tts-server.py"), "utf8");
  assert.match(src, /HTTPServer\(\("127\.0\.0\.1", 0\)/);
  assert.match(src, /x-qwen-key/);
  assert.ok(!src.includes("0.0.0.0"));
});
