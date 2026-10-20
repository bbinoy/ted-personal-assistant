import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings.ts";
import { qwenReference } from "../src/doctor.ts";

test("settings: Qwen is the default speech provider, with Kokoro standing in; Kokoro alone has no fallback", () => {
  const s = loadSettings({});
  assert.equal(s.tts.provider, "qwen");
  assert.equal(s.tts.fallback, "kokoro");
  assert.equal(loadSettings({ TTS_PROVIDER: "kokoro" }).tts.fallback, "none");
});

test("settings: remote speech needs its keys and a safe address, or the agent does not start", () => {
  assert.throws(() => loadSettings({ TTS_PROVIDER: "elevenlabs" }), /ELEVENLABS_API_KEY/);
  // read once into settings, then gone from the environment every child process (Claude Code, MCP servers, ffmpeg) inherits
  const probe = "import('./src/settings.ts').then(({ settings }) => console.log(JSON.stringify([process.env.ELEVENLABS_API_KEY ?? null, process.env.TTS_HTTP_TOKEN ?? null, settings.tts.provider === 'elevenlabs' && settings.tts.elevenlabs.apiKey])))";
  const out = execFileSync(process.execPath, ["--conditions=workspace-source", "-e", probe], { encoding: "utf8", env: { PATH: process.env.PATH, TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "key-123456", ELEVENLABS_VOICE_ID: "v", TTS_HTTP_TOKEN: "tok-123456", HARNESS_DATA_DIR: process.env.HARNESS_DATA_DIR } });
  assert.equal(out.trim(), JSON.stringify([null, null, "key-123456"]));
  assert.throws(() => loadSettings({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k" }), /ELEVENLABS_VOICE_ID/);
  const e = loadSettings({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", TTS_FALLBACK: "kokoro" }).tts;
  assert.ok(e.provider === "elevenlabs" && e.elevenlabs.modelId === "eleven_multilingual_v2" && e.fallback === "kokoro");
  assert.throws(() => loadSettings({ TTS_PROVIDER: "http" }), /TTS_HTTP_URL/);
  assert.throws(() => loadSettings({ TTS_PROVIDER: "http", TTS_HTTP_URL: "http://example.com/tts" }), /https/);
  const h = loadSettings({ TTS_PROVIDER: "http", TTS_HTTP_URL: "http://localhost:8787/tts", TTS_HTTP_REFERENCE_ID: "r1" }).tts;
  assert.ok(h.provider === "http" && h.http.referenceId === "r1" && h.http.token === undefined);
  assert.throws(() => loadSettings({ TTS_PROVIDER: "other" }), /TTS_PROVIDER/);
  assert.throws(() => loadSettings({ TTS_FALLBACK: "elevenlabs" }), /TTS_FALLBACK/);
});

test("settings: the timing constants keep the values they had when they were hard-coded, and are validated", () => {
  const s = loadSettings({});
  const ms = { stickyMs: s.groupStickyMinutes * 60_000, noticeMs: s.groupNoticeMinutes * 60_000, memberMs: s.groupMemberCacheMinutes * 60_000, slowMs: s.slowReplySeconds * 1000, echoMs: s.echoWindowMinutes * 60_000, refreshMs: s.warmRefreshMinutes * 60_000, seenMs: s.seenMailDays * 24 * 3600_000, noticeAgeMs: s.noticeAgeHours * 3600_000, backoffMs: s.compactBackoffMinutes * 60_000 };
  assert.deepEqual(ms, { stickyMs: 30 * 60_000, noticeMs: 10 * 60_000, memberMs: 5 * 60_000, slowMs: 20_000, echoMs: 5 * 60_000, refreshMs: 25 * 60_000, seenMs: 14 * 24 * 3600_000, noticeAgeMs: 24 * 3600_000, backoffMs: 3600_000 });
  assert.equal(loadSettings({ GROUP_STICKY_MINUTES: "45" }).groupStickyMinutes, 45);
  assert.throws(() => loadSettings({ SLOW_REPLY_SECONDS: "soon" }), /SLOW_REPLY_SECONDS/);
});

test("settings: the local cloned voice (qwen) takes its reference from paths, falls back to Kokoro by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "ref-"));
  writeFileSync(join(dir, "ref.txt"), "  Words spoken in the reference.\n");
  const q = loadSettings({ TTS_PROVIDER: "qwen", HARNESS_DATA_DIR: dir, TTS_REF_AUDIO: "ref.wav", TTS_REF_TEXT: "ref.txt", WARM_IDLE_MINUTES: "30" }).tts;
  assert.ok(q.provider === "qwen");
  assert.equal(q.fallback, "kokoro");
  assert.equal(q.qwen.refAudio, join(dir, "ref.wav"));
  assert.equal(q.qwen.refText, "Words spoken in the reference.");
  assert.equal(q.qwen.dir, join(dir, "state/tts-qwen"));
  assert.equal(q.qwen.idleMs, 30 * 60_000);
  assert.match(q.qwen.model, /Qwen3-TTS-12Hz-0\.6B-Base-8bit$/);
  const inline = loadSettings({ TTS_PROVIDER: "qwen", TTS_REF_TEXT: "Just these words." }).tts;
  assert.ok(inline.provider === "qwen" && inline.qwen.refText === "Just these words." && inline.qwen.refAudio === "");
  assert.ok(loadSettings({ TTS_PROVIDER: "qwen", TTS_FALLBACK: "none" }).tts.fallback === "none");
  rmSync(dir, { recursive: true, force: true });
});

test("settings: with TTS_PROVIDER=qwen and no reference set, the built-in sample voice from assets/voices/ is used", () => {
  const dir = mkdtempSync(join(tmpdir(), "ref-"));
  const q = loadSettings({ TTS_PROVIDER: "qwen", HARNESS_DATA_DIR: dir }).tts;
  assert.ok(q.provider === "qwen");
  assert.equal(q.qwen.builtIn, true);
  const repoVoices = join(import.meta.dirname, "../assets/voices");
  assert.equal(q.qwen.refAudio, join(repoVoices, "default.wav")); // resolved from the repo, not the data dir
  assert.equal(q.qwen.refText, readFileSync(join(repoVoices, "default.txt"), "utf8").trim());
  assert.ok(q.qwen.refText.length > 50);
  assert.equal(qwenReference(q.qwen), "built-in sample voice");
  rmSync(dir, { recursive: true, force: true });
});

test("settings: an explicit TTS_REF_AUDIO / TTS_REF_TEXT wins over the built-in sample, and the doctor says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "ref-"));
  const q = loadSettings({ TTS_PROVIDER: "qwen", HARNESS_DATA_DIR: dir, TTS_REF_AUDIO: "mine.wav", TTS_REF_TEXT: "My own words." }).tts;
  assert.ok(q.provider === "qwen");
  assert.equal(q.qwen.builtIn, false);
  assert.equal(q.qwen.refAudio, join(dir, "mine.wav"));
  assert.equal(q.qwen.refText, "My own words.");
  assert.match(qwenReference(q.qwen), /^your own file .*mine\.wav$/);
  // one of the two set: still your own (the sample is never mixed with your text or audio)
  const half = loadSettings({ TTS_PROVIDER: "qwen", HARNESS_DATA_DIR: dir, TTS_REF_AUDIO: "mine.wav" }).tts;
  assert.ok(half.provider === "qwen" && half.qwen.builtIn === false && half.qwen.refText === "");
  rmSync(dir, { recursive: true, force: true });
});

test("assets/voices: the shipped sample is a mono 24 kHz 16-bit PCM WAV of about 10 s, small, with its text", () => {
  const dir = join(import.meta.dirname, "../assets/voices");
  const wav = readFileSync(join(dir, "default.wav"));
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(wav.toString("latin1", 8, 12), "WAVE");
  const fmt = wav.indexOf("fmt ");
  assert.equal(wav.readUInt16LE(fmt + 8), 1); // PCM
  assert.equal(wav.readUInt16LE(fmt + 10), 1); // mono
  assert.equal(wav.readUInt32LE(fmt + 12), 24000);
  assert.equal(wav.readUInt16LE(fmt + 22), 16);
  const data = wav.indexOf("data");
  const seconds = wav.readUInt32LE(data + 4) / (24000 * 2);
  assert.ok(seconds >= 8 && seconds <= 15, `duration ${seconds}`);
  assert.ok(wav.length < 1_000_000);
  const text = readFileSync(join(dir, "default.txt"), "utf8").trim();
  assert.ok(text.length > 100 && text.length < 400);
  assert.ok(readFileSync(join(dir, "README.md"), "utf8").includes("Apache-2.0"));
});
