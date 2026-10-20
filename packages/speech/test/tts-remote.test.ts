import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { isSafeUrl, sniffAudio } from "../src/tts-remote.ts";
import { synthesizeElevenLabs } from "../src/tts-elevenlabs.ts";
import { synthesizeHttp } from "../src/tts-http.ts";
import { synthesizeWith } from "../src/tts-provider.ts";

// All HTTP here is a mock: no real service is ever called.

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } });
    return true;
  } catch {
    return false;
  }
})();

// A real, tiny WAV (0.1 s of silence, 8 kHz mono, 16 bit).
function wav(): Buffer {
  const n = 800;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

type Call = { url: string; init: RequestInit };
function mock(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetchImpl: (async (url: string, init: RequestInit) => (calls.push({ url: String(url), init }), respond())) as unknown as typeof fetch };
}
const audio = (type = "audio/wav") => new Response(new Uint8Array(wav()), { status: 200, headers: { "content-type": type } });

test("tts remote: https is required, http only for this machine", () => {
  assert.ok(isSafeUrl("https://tts.example.com/say"));
  assert.ok(isSafeUrl("http://localhost:8787/tts"));
  assert.ok(isSafeUrl("http://127.0.0.1:8787/tts"));
  assert.ok(!isSafeUrl("http://tts.example.com/say"));
  assert.ok(!isSafeUrl("ftp://localhost/x"));
  assert.ok(!isSafeUrl("not a url"));
});

test("tts remote: audio is recognised by content type or by its first bytes, anything else is refused", () => {
  assert.equal(sniffAudio("audio/mpeg", new Uint8Array(4)), "mp3");
  assert.equal(sniffAudio("audio/ogg; codecs=opus", new Uint8Array(4)), "ogg");
  assert.equal(sniffAudio("application/octet-stream", wav()), "wav");
  assert.equal(sniffAudio(null, new TextEncoder().encode("OggS\u0000")), "ogg");
  assert.equal(sniffAudio(null, new TextEncoder().encode("ID3\u0004")), "mp3");
  assert.equal(sniffAudio(null, Uint8Array.of(0xff, 0xfb, 0x90)), "mp3");
  assert.equal(sniffAudio("application/json", new TextEncoder().encode('{"error":1}')), undefined);
});

test("elevenlabs: sends only the words, the key as a header, and returns an m4a", { skip: !hasFfmpeg && "ffmpeg is not installed, so this encoding test is skipped" }, async () => {
  const m = mock(() => audio("audio/mpeg"));
  const file = await synthesizeElevenLabs("Hello there.", { apiKey: "KEY-123456", voiceId: "voice 1", modelId: "model-x", timeoutMs: 5000, baseUrl: "http://localhost:1", fetchImpl: m.fetchImpl });
  try {
    assert.match(file, /voice\.m4a$/);
    assert.ok(readFileSync(file).length > 0);
    const [c] = m.calls;
    assert.equal(c!.url, "http://localhost:1/v1/text-to-speech/voice%201?output_format=mp3_44100_128");
    assert.equal((c!.init.headers as Record<string, string>)["xi-api-key"], "KEY-123456");
    assert.deepEqual(JSON.parse(String(c!.init.body)), { text: "Hello there.", model_id: "model-x" });
    assert.ok(!c!.url.includes("KEY-123456"));
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
});

test("http: the contract body and optional bearer token; fields left out when unset", { skip: !hasFfmpeg && "ffmpeg is not installed, so this encoding test is skipped" }, async () => {
  const m = mock(() => audio());
  const a = await synthesizeHttp("Hi.", { url: "https://tts.example.com/say", token: "TOKEN-abcdef", voice: "ted", referenceId: "ref-1", timeoutMs: 5000, fetchImpl: m.fetchImpl });
  const b = await synthesizeHttp("Hi.", { url: "https://tts.example.com/say", timeoutMs: 5000, fetchImpl: m.fetchImpl });
  try {
    assert.deepEqual(JSON.parse(String(m.calls[0]!.init.body)), { text: "Hi.", voice: "ted", reference_id: "ref-1" });
    assert.equal((m.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer TOKEN-abcdef");
    assert.deepEqual(JSON.parse(String(m.calls[1]!.init.body)), { text: "Hi." });
    assert.equal((m.calls[1]!.init.headers as Record<string, string>).authorization, undefined);
    assert.equal(m.calls[0]!.init.redirect, "error");
  } finally {
    rmSync(dirname(a), { recursive: true, force: true });
    rmSync(dirname(b), { recursive: true, force: true });
  }
});

test("http: errors, quota, non-audio and timeouts throw, and a secret never appears in the message", async () => {
  const cfg = { url: "https://tts.example.com/say", token: "TOKEN-abcdef", timeoutMs: 5000 };
  const quota = mock(() => new Response("quota exceeded for TOKEN-abcdef", { status: 429 }));
  await assert.rejects(synthesizeHttp("x", { ...cfg, fetchImpl: quota.fetchImpl }), (e: Error) => /HTTP 429 \(quota or rate limit\)/.test(e.message) && !e.message.includes("TOKEN-abcdef"));
  const denied = mock(() => new Response("no", { status: 401 }));
  await assert.rejects(synthesizeHttp("x", { ...cfg, fetchImpl: denied.fetchImpl }), /key or token refused/);
  const json = mock(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(synthesizeHttp("x", { ...cfg, fetchImpl: json.fetchImpl }), /not wav, mp3 or ogg/);
  const empty = mock(() => new Response(new Uint8Array(0), { status: 200 }));
  await assert.rejects(synthesizeHttp("x", { ...cfg, fetchImpl: empty.fetchImpl }), /0 bytes/);
  const slow = { fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch };
  await assert.rejects(synthesizeHttp("x", { ...cfg, timeoutMs: 30, fetchImpl: slow.fetchImpl }), /timeout/);
  const down = { fetchImpl: (async () => { throw new TypeError("fetch failed: connect to TOKEN-abcdef"); }) as unknown as typeof fetch };
  await assert.rejects(synthesizeHttp("x", { ...cfg, fetchImpl: down.fetchImpl }), (e: Error) => /network error/.test(e.message) && !e.message.includes("TOKEN"));
});

test("provider: a remote failure is an error (text is sent) unless TTS_FALLBACK=kokoro and Kokoro is set up", async () => {
  const bad = mock(() => new Response("", { status: 500 }));
  const base = { kokoro: { dir: "/nonexistent-kokoro", voice: "am_onyx", speed: 1 }, provider: "http" as const, http: { url: "https://tts.example.com/say", timeoutMs: 5000, fetchImpl: bad.fetchImpl } };
  await assert.rejects(synthesizeWith("x", { ...base, fallback: "none" }), /HTTP 500/);
  // fallback asked for, but Kokoro is not installed here: still the remote error, so the caller sends text
  await assert.rejects(synthesizeWith("x", { ...base, fallback: "kokoro" }), /HTTP 500/);
  assert.equal(bad.calls.length, 2);
});
