import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { settings } from "../src/core/settings.ts";
import { conversationsDir, convIdOfKey, convPaths, groupConvId, layout, OWNER_CONV } from "../src/core/convpaths.ts";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOptions } from "../src/run/agentrun.ts";
import { classify } from "../src/policy/policy.ts";
import { access } from "./util.ts";
import { holdQuote, holdVoiceNote, resetVoiceNotes } from "../src/modules/voice/voicenote.ts";
import { withSend } from "../src/modules/send/send.ts";
import { voiceNow, type VoiceDeps } from "../src/modules/voice/voicetool.ts";
import {
  activeVoice, activeVoiceRel, buildReference, deleteVoice, listVoices, MAX_VOICES, sanitizeVoiceName, saveVoice, scopeRoot, setActiveVoice, voiceFiles,
  type ClipTools,
} from "@ted-assistant/speech/tts";
import { synthesizeQwen, stopQwen } from "@ted-assistant/speech/tts";

// The cloned voice: a library per conversation, built from voice notes received in that conversation, read by the speech provider per reply.

const RATE = 24_000;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const speech = (seconds: number): Int16Array => {
  const out = new Int16Array(seconds * RATE);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(((Math.floor(i / (0.3 * RATE)) % 3 === 2 ? 300 : 9000) * Math.sin(i / 17)));
  return out;
};
const silence = (seconds: number) => new Int16Array(seconds * RATE).map((_, i) => (i % 7) - 3);
const noise = (seconds: number) => new Int16Array(seconds * RATE).map((_, i) => Math.round(4000 * Math.sin(i * 12.9898) * Math.cos(i * 4.1414)));

const fakeClip = (pcm: Int16Array, text = "hello this is my own voice speaking", probe: ClipTools["probe"] = async () => ({ seconds: pcm.length / RATE, codec: "mp3" })): ClipTools => ({ decode: async () => pcm, transcribe: async () => text, probe });

let tmp: string;
let attachments: string;
let deps: VoiceDeps;
const mk = (clip: ClipTools = fakeClip(speech(12)), o: Partial<VoiceDeps> = {}): VoiceDeps => ({
  voiceRoot: join(tmp, "voice"), problem: () => undefined, clip, audioFile: async (id) => join(attachments, id), groups: () => [{ id: "grp-1", name: "Family" }], now: () => NOW, ...o,
});
// a conversation's voice library under the deps' root, by its key (the host's mapping: the conversation's folder name)
const lib = (key: string): string => scopeRoot(join(tmp, "voice"), convIdOfKey(key));
const note = (key: string, ts: number, by = "+1", o: { id?: string; file?: boolean; byName?: string } = {}) => {
  const id = o.id ?? `att${ts}`;
  if (o.file !== false) writeFileSync(join(attachments, id), "audio");
  holdVoiceNote(key, { ts, id, size: 5000, by, byName: o.byName, snippet: "use my voice please" }, NOW);
};
const asMember = async <T>(key: string, author: string, ts: number, owner: boolean, run: () => Promise<T>): Promise<T> => {
  let out: T | undefined;
  await withSend(key, undefined, async () => void (out = await run()), { author, timestamp: ts, owner });
  return out as T;
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "voice-test-"));
  attachments = join(tmp, "att");
  mkdirSync(attachments);
  rmSync(conversationsDir(), { recursive: true, force: true }); // notes are kept on disk: every test starts with none
  resetVoiceNotes();
  deps = mk();
});

test("names: sanitised to [a-z0-9-] up to 32, and nothing climbs out of the library", () => {
  assert.equal(sanitizeVoiceName("Anna's Voice!"), "anna-s-voice");
  assert.equal(sanitizeVoiceName("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeVoiceName("Zoë Ünal"), "zoe-unal");
  assert.equal(sanitizeVoiceName("x".repeat(80)).length, 32);
  assert.equal(sanitizeVoiceName("   "), "");
  const root = join(tmp, "lib");
  for (const bad of ["../x", "a/b", "..", "A", "x".repeat(33), ""]) assert.throws(() => saveVoice(root, bad, { wav: Buffer.alloc(4), text: "t", meta: { created: "", source: "", seconds: 1 } }, 5), /bad voice name/, bad);
  assert.equal(voiceFiles(root, "../../etc"), undefined);
  assert.throws(() => deleteVoice(root, "../.."), /no voice/);
  assert.ok(!existsSync(join(tmp, "x")));
});

test("library: create, switch, delete, cap, default is built in and cannot be deleted or replaced", () => {
  const root = join(tmp, "lib");
  const v = (t: string) => ({ wav: Buffer.from("RIFF"), text: t, meta: { created: new Date().toISOString(), source: "voice note", seconds: 5 } });
  assert.equal(activeVoice(root), "default");
  saveVoice(root, "anna", v("a"), 3);
  saveVoice(root, "bo", v("b"), 3);
  assert.throws(() => saveVoice(root, "anna", v("again"), 3), /exists already/);
  assert.throws(() => saveVoice(root, "default", v("d"), 3), /built-in/);
  setActiveVoice(root, "anna");
  assert.equal(activeVoice(root), "anna");
  assert.equal(voiceFiles(root, "anna")?.text, "a");
  assert.throws(() => setActiveVoice(root, "nobody"), /no voice/);
  saveVoice(root, "cy", v("c"), 3);
  assert.throws(() => saveVoice(root, "di", v("d"), 3), /holds 3 voices/);
  assert.deepEqual(listVoices(root).map((x) => x.name).sort(), ["anna", "bo", "cy"]);
  assert.throws(() => deleteVoice(root, "default"), /cannot be deleted/);
  deleteVoice(root, "anna"); // the active one: the default is active again
  assert.equal(activeVoice(root), "default");
  setActiveVoice(root, "bo");
  setActiveVoice(root, "default");
  assert.equal(activeVoice(root), "default");
  assert.equal(MAX_VOICES.owner, 10);
  assert.equal(MAX_VOICES.group, 5);
});

test("library: each conversation's library is <root>/<its folder name>/voices; a group's folder name is a hash, never its id, and the package takes only a plain folder name", () => {
  const id = "Zm9vYmFyLWdyb3VwLWlkLXdpdGgtc2VjcmV0cw==";
  const conv = groupConvId(id);
  const base = join(tmp, "conv");
  const root = scopeRoot(base, conv);
  assert.equal(root, join(base, conv, "voices"));
  assert.ok(!root.includes(id) && !root.includes("secrets"));
  assert.notEqual(root, scopeRoot(base, groupConvId("other")));
  assert.equal(scopeRoot(base, "owner"), join(base, "owner", "voices"));
  for (const bad of [id, "../x", "a/b", "", "Owner", "x".repeat(65)]) assert.throws(() => scopeRoot(base, bad), /bad voice scope/, bad);
  assert.equal(scopeRoot(layout(tmp).conversations, conv), layout(tmp).conv(conv).voices, "the app's folder layout (convpaths.ts) and the package agree on where a library is");
  saveVoice(root, "kid", { wav: Buffer.from("RIFF"), text: "t", meta: { created: "", source: "", seconds: 4 } }, 5);
  setActiveVoice(root, "kid");
  assert.equal(activeVoiceRel(base, conv), `${conv}/voices/kid`);
  assert.equal(activeVoiceRel(base, "owner"), undefined, "another conversation is unaffected");
  assert.equal(activeVoiceRel(base, groupConvId("other")), undefined);
});

test("clip: too short, silent, noise, no words and too long are refused; a long good one is cut to 15 s", async () => {
  const f = join(tmp, "in");
  await assert.rejects(buildReference(f, fakeClip(speech(2))), /too short/);
  await assert.rejects(buildReference(f, fakeClip(silence(10))), /almost silent|mostly silence/);
  await assert.rejects(buildReference(f, fakeClip(noise(10))), /noise|silence/);
  await assert.rejects(buildReference(f, fakeClip(speech(10), "")), /clear speech/);
  await assert.rejects(buildReference(f, fakeClip(speech(10), "(music) [noise]"), ), /clear speech/);
  await assert.rejects(buildReference(f, fakeClip(speech(10), "uh")), /clear speech/);
  await assert.rejects(buildReference(f, { ...fakeClip(new Int16Array(301 * RATE)), transcribe: async () => "x" }), /over 5 minutes/);
  await assert.rejects(buildReference(f, { ...fakeClip(speech(1)), decode: async () => { throw new Error("bad"); } }), /couldn't read/);
  const ok = await buildReference(f, fakeClip(speech(8)));
  assert.ok(ok.seconds > 7 && ok.wav.subarray(0, 4).toString() === "RIFF" && ok.wav.readUInt32LE(24) === RATE);
  const long = await buildReference(f, fakeClip(speech(70)));
  assert.ok(long.seconds <= 15 && long.seconds >= 10, String(long.seconds));
});

test("tool: the owner turns a voice note into the active voice; the consent line comes once", async () => {
  note("owner", NOW - 60_000, "owner");
  const first = await voiceNow("owner", { action: "use", name: "My Voice" }, deps);
  assert.match(first, /now using the voice "my-voice"/);
  assert.match(first, /right to use/);
  assert.equal(activeVoice(lib("owner")), "my-voice");
  const files = voiceFiles(lib("owner"), "my-voice")!;
  assert.equal(files.text, "hello this is my own voice speaking");
  const meta = JSON.parse(readFileSync(join(lib("owner"), "my-voice/meta.json"), "utf8"));
  assert.equal(meta.source, "voice note");
  assert.ok(meta.created && meta.seconds > 0);
  note("owner", NOW - 30_000, "owner");
  assert.doesNotMatch(await voiceNow("owner", { action: "use" }, deps), /right to use/);
  assert.match(await voiceNow("owner", { action: "list" }, deps), /- default: the built-in voice\n- my-voice: .*\n- voice \(active\)/);
  assert.match(await voiceNow("owner", { action: "switch", name: "normal" }, deps), /default voice/);
  assert.equal(activeVoice(lib("owner")), "default");
  assert.match(await voiceNow("owner", { action: "delete", name: "default" }, deps), /cannot be deleted/);
  assert.match(await voiceNow("owner", { action: "delete", name: "my-voice" }, deps), /Deleted/);
  assert.match(await voiceNow("owner", { action: "switch", name: "my-voice" }, deps), /no voice called/);
});

test("tool: not available unless the Qwen voice is set up", async () => {
  const d = mk(undefined, { problem: () => "Voice cloning needs the Qwen voice (TTS_PROVIDER=qwen); it is not set up here." });
  assert.match(await voiceNow("owner", { action: "list" }, d), /needs the Qwen voice/);
  assert.ok(!existsSync(join(tmp, "voice")));
});

test("tool: in a group the default source is the asking message's own note or the one it replies to; both people are recorded", async () => {
  const T = NOW - 100_000;
  note("g1", T + 1000, "+2", { byName: "Eve" });
  note("g1", T + 2000, "+3", { byName: "Max" });
  holdQuote("g1", T + 3000, T + 2000); // a message by +2 replies to Max's voice note
  const root = lib("g1");
  await asMember("g1", "+2", T + 1000, false, async () => {
    const r = await voiceNow("g1", { action: "use", name: "eve" }, deps);
    assert.match(r, /Eve's voice/);
    assert.match(r, /only in this group|only used in this group|used only in this group/);
    assert.match(r, /normal voice/);
  });
  const m1 = JSON.parse(readFileSync(join(root, "eve/meta.json"), "utf8"));
  assert.equal(m1.by, "+2");
  assert.equal(m1.from, "+2");
  await asMember("g1", "+2", T + 3000, false, async () => {
    const r = await voiceNow("g1", { action: "use", name: "max" }, deps);
    assert.match(r, /Max's voice/);
    assert.match(r, /at /);
  });
  const m2 = JSON.parse(readFileSync(join(root, "max/meta.json"), "utf8"));
  assert.equal(m2.by, "+2");
  assert.equal(m2.from, "+3");
  assert.equal(m2.fromName, "Max");
  assert.equal(activeVoice(lib("owner")), "default", "the owner's chat is untouched");
  assert.equal(activeVoiceRel(deps.voiceRoot, convIdOfKey("g1")), `${groupConvId("g1")}/voices/max`);
});

test("tool: a source from another conversation, an unknown or too old id, or a missing file is refused", async () => {
  note("g2", NOW - 5000, "+9", { byName: "Other" });
  const noSource = await asMember("g1", "+2", 7777, false, async () => assert.match(await voiceNow("g1", { action: "use" }, deps), /no voice note to use/));
  void noSource;
  await asMember("g1", "+2", 7777, false, async () => {
    assert.match(await voiceNow("g1", { action: "use", source: String(NOW - 5000) }, deps), /not a voice note from this conversation/);
    assert.match(await voiceNow("g1", { action: "use", source: "../../etc/passwd" }, deps), /id from the sources list/);
  });
  note("g1", NOW - 8 * 24 * 3_600_000, "+2", { id: "old" });
  await asMember("g1", "+2", 7777, false, async () => assert.match(await voiceNow("g1", { action: "use", source: String(NOW - 8 * 24 * 3_600_000) }, deps), /not a voice note from this conversation/));
  note("g1", NOW - 5000, "+2", { id: "vanished", file: false });
  await asMember("g1", "+2", NOW - 5000, false, async () => assert.match(await voiceNow("g1", { action: "use" }, deps), /no longer on this device/));
  assert.deepEqual(listVoices(lib("g1")), []);
});

test("tool: a source id is only joined to the attachments folder (the id is the only thing trusted)", async () => {
  let asked = "";
  const d = mk(undefined, { audioFile: async (id) => ((asked = id), join(attachments, id)) });
  note("owner", NOW - 1000, "owner", { id: "abc123" });
  await voiceNow("owner", { action: "use" }, d);
  assert.equal(asked, "abc123");
});

test("tool: sources lists this conversation's notes with sender, age and a snippet", async () => {
  note("g1", NOW - 2 * 3_600_000, "+2", { byName: "Eve" });
  note("g2", NOW - 1000, "+9", { byName: "Other" });
  const r = await asMember("g1", "+2", NOW - 2 * 3_600_000, false, async () => {
    const s = await voiceNow("g1", { action: "sources" }, deps);
    assert.match(s, /from Eve, 2 h ago/);
    assert.match(s, /the message you are answering/);
    assert.doesNotMatch(s, /Other/);
  });
  void r;
});

test("tool: group rules: a group library is capped, anyone can switch back, only the maker or the owner delete, the owner resets from the chat", async () => {
  const root = lib("g1");
  for (let i = 1; i <= 5; i++) note("g1", NOW - 1000 * i, "+2", { byName: "Eve" });
  for (let i = 1; i <= 5; i++) await asMember("g1", "+2", NOW - 1000 * i, false, async () => assert.match(await voiceNow("g1", { action: "use", name: `v${i}` }, deps), /Saved/));
  note("g1", NOW - 9000, "+2");
  await asMember("g1", "+2", NOW - 9000, false, async () => assert.match(await voiceNow("g1", { action: "use", name: "v6" }, deps), /holds 5 voices/));
  await asMember("g1", "+7", 1, false, async () => {
    assert.match(await voiceNow("g1", { action: "switch", name: "default" }, deps), /default voice/);
    assert.match(await voiceNow("g1", { action: "switch", name: "v3" }, deps), /Now using/);
    assert.match(await voiceNow("g1", { action: "delete", name: "v1" }, deps), /Only the member who made/);
  });
  await asMember("g1", "+2", 1, false, async () => assert.match(await voiceNow("g1", { action: "delete", name: "v1" }, deps), /Deleted/));
  await asMember("g1", "+owner", 1, true, async () => assert.match(await voiceNow("g1", { action: "delete", name: "v2" }, deps), /Deleted/));
  assert.equal(activeVoice(root), "v3");
  assert.match(await voiceNow("g1", { action: "reset_group", group: "x" }, deps), /Only the owner/);
  assert.match(await voiceNow("owner", { action: "reset_group", group: "Nope" }, deps), /No group named/);
  assert.match(await voiceNow("owner", { action: "reset_group", group: "family" }, mk(undefined, { groups: () => [{ id: "g1", name: "Family" }] })), /default voice again/);
  assert.equal(activeVoice(root), "default");
});

test("tool: manifest and policy: chat and group without approval, never an unattended run", () => {
  const TOOL = "mcp__voice__voice";
  assert.equal(access(TOOL, "chat"), "free");
  assert.equal(classify(TOOL, { action: "list" }, "chat"), "allow");
  assert.equal(classify(TOOL, { action: "list" }, "group"), "allow");
  for (const source of ["radar", "handler", "heartbeat", "dream", "browse", "background"] as const) {
    assert.equal(access(TOOL, source), undefined, source);
    assert.equal(classify(TOOL, { action: "list" }, source), "deny", source);
  }
  // the default provider is Qwen: chat and group are offered the tool, an unattended run is not
  const servers = (source: "chat" | "group" | "handler") => Object.keys(buildOptions(async () => ({ approved: true }), { systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1, source, ...(source === "chat" ? { memory: { dir: "/tmp/n" } } : source === "group" ? { memory: { dir: "/tmp/n", groupId: "g" } } : {}) }, undefined).mcpServers ?? {});
  for (const s of ["chat", "group", "handler"] as const) assert.equal(servers(s).includes("voice"), s !== "handler", s);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

test("provider: the speech request names the conversation's active voice, read per reply (no restart)", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const bodies: unknown[] = [];
  const voiceRoot = join(tmp, "voice");
  const owners = scopeRoot(voiceRoot, "owner"); // (the default scope of a call without one)
  const fakeServer = join(tmp, "fake.mjs");
  writeFileSync(fakeServer, `
import http from "node:http";
const n = 800, b = Buffer.alloc(44 + n * 2);
b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "audio/wav" }); res.end(b); }); }).listen(0, "127.0.0.1", function () { console.log("READY " + this.address().port); });
process.stdin.on("end", () => process.exit(0)); process.stdin.resume();
`);
  const fetchImpl = ((u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), fetch(u, init))) as typeof fetch;
  const cfg = { dir: tmp, model: "m", refAudio: fakeServer, refText: "ref", voiceRoot, timeoutMs: 20_000, idleMs: 0, startTimeoutMs: 5000, command: [process.execPath, fakeServer], fetchImpl };
  const gone = (f: string) => void readdirSync(join(f, ".."));
  try {
    gone(await synthesizeQwen("one", cfg));
    saveVoice(owners, "anna", { wav: Buffer.from("RIFF"), text: "t", meta: { created: "", source: "", seconds: 4 } }, 5);
    setActiveVoice(owners, "anna");
    await synthesizeQwen("two", cfg);
    await synthesizeQwen("three", cfg, "some-group"); // another conversation: its own (default) voice
    setActiveVoice(owners, "default");
    await synthesizeQwen("four", cfg);
  } finally {
    stopQwen();
  }
  assert.deepEqual(bodies, [{ text: "one" }, { text: "two", voice: "owner/voices/anna" }, { text: "three" }, { text: "four" }]);
});

// ---- audio FILES as a voice source (an mp3 someone sent), the same list and the same rules as voice messages ----

const fileNote = (key: string, ts: number, by = "+1", o: { id?: string; file?: boolean; byName?: string; name?: string } = {}) => {
  const id = o.id ?? `file${ts}`;
  if (o.file !== false) writeFileSync(join(attachments, id), "mp3 bytes");
  holdVoiceNote(key, { ts, id, size: 90_000, by, byName: o.byName, snippet: "this is the speech in the file", kind: "file", name: o.name ?? "talk.mp3", seconds: 95 }, NOW);
};

test("clip: an audio file must really be audio (no video, no fake mp3); a long one is searched in its first 5 minutes instead of refused", async () => {
  const f = join(tmp, "in");
  await assert.rejects(buildReference(f, fakeClip(speech(10), undefined, async () => "video"), { file: true }), /video/);
  await assert.rejects(buildReference(f, fakeClip(speech(10), undefined, async () => "not media"), { file: true }), /not real audio/);
  await assert.rejects(buildReference(f, { ...fakeClip(speech(10)), probe: async () => { throw new Error("boom"); } }, { file: true }), /not real audio/);
  // a voice message is not probed: the same fake that refuses a file passes there
  assert.ok((await buildReference(f, fakeClip(speech(10), undefined, async () => "video"))).seconds > 0);
  const long = await buildReference(f, fakeClip(speech(301)), { file: true });
  assert.ok(long.seconds <= 15 && long.seconds >= 10);
  await assert.rejects(buildReference(f, fakeClip(speech(301))), /over 5 minutes/);
});

test("clip: for a long file the best stretch has continuous speech, not the start (a hum, a long pause)", async () => {
  const hum = (s: number) => new Int16Array(s * RATE).map((_, i) => Math.round(120 * Math.sin(i / 9)));
  const pcm = new Int16Array([...hum(40), ...speech(12), ...hum(40)]);
  const tone = (s: number) => new Int16Array(s * RATE).map((_, i) => Math.round(9000 * Math.sin(i / 11))); // a loud steady intro jingle: loud, but not speech
  const withJingle = new Int16Array([...tone(25), ...speech(12)]);
  const j = await buildReference(join(tmp, "in"), fakeClip(withJingle), { file: true });
  const jb = j.wav.subarray(44);
  const js = new Int16Array(jb.buffer.slice(jb.byteOffset, jb.byteOffset + jb.length));
  assert.ok(js.filter((v) => Math.abs(v) > 2000).length / js.length > 0.3 && j.seconds < 14, "the jingle is skipped");
  const ref = await buildReference(join(tmp, "in"), fakeClip(pcm), { file: true });
  const body = ref.wav.subarray(44);
  const samples = new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length));
  const loud = samples.filter((v) => Math.abs(v) > 2000).length / samples.length;
  assert.ok(loud > 0.3, String(loud));
});

test("tool: an audio file with speech is a source like a voice note: use it from the asking message, a quoted file or the latest one", async () => {
  const T = NOW - 100_000;
  fileNote("owner", T, "owner", { byName: "Ben", name: "talk.mp3" });
  const s = await voiceNow("owner", { action: "sources" }, deps);
  assert.match(s, /id \d+: audio file "talk.mp3" \(95 s\), from Ben, .*"this is the speech in the file"/);
  const r = await asMember("owner", "owner", T, true, () => voiceNow("owner", { action: "use", name: "talk" }, deps));
  assert.match(r, /now using the voice "talk".*from the audio file/);
  const meta = JSON.parse(readFileSync(join(lib("owner"), "talk/meta.json"), "utf8"));
  assert.deepEqual([meta.source, meta.by, meta.from], ["audio file", "owner", "owner"]);
  fileNote("owner", T + 5000, "owner", { name: "other.mp3" });
  holdQuote("owner", T + 9000, T); // a later message replies to the first file
  const q = await asMember("owner", "owner", T + 9000, true, () => voiceNow("owner", { action: "use", name: "quoted" }, deps));
  assert.match(q, /"quoted"/);
  assert.match(await voiceNow("owner", { action: "use", name: "latest" }, deps), /"latest"/); // no source in the message: the latest in the chat
});

test("tool: a file source is probed again at use (not audio any more: refused, nothing saved); too big or gone is refused first", async () => {
  fileNote("owner", NOW - 5000, "owner");
  const d = mk(fakeClip(speech(12), undefined, async () => "not media"));
  assert.match(await voiceNow("owner", { action: "use" }, d), /not real audio/);
  assert.deepEqual(listVoices(lib("owner")), []);
  fileNote("owner", NOW - 4000, "owner", { id: "huge" });
  truncateSync(join(attachments, "huge"), 50_000_001);
  assert.match(await voiceNow("owner", { action: "use", source: String(NOW - 4000) }, deps), /audio file is no longer on this device/);
  fileNote("owner", NOW - 3000, "owner", { id: "gone", file: false });
  assert.match(await voiceNow("owner", { action: "use", source: String(NOW - 3000) }, deps), /audio file is no longer on this device/);
});

test("tool: a file without speech is refused by the clip check, and a file from another conversation is never used", async () => {
  fileNote("owner", NOW - 5000, "owner");
  assert.match(await voiceNow("owner", { action: "use" }, mk(fakeClip(speech(12), ""))), /clear speech/);
  fileNote("g2", NOW - 2000, "+9", { byName: "Other" });
  await asMember("g1", "+2", 1, false, async () => assert.match(await voiceNow("g1", { action: "use", source: String(NOW - 2000) }, deps), /not a voice note from this conversation/));
  assert.deepEqual(listVoices(lib("g1")), []);
});

test("tool: group: a member's file makes a voice used in that group only; the file's sender and the requester are both recorded", async () => {
  const T = NOW - 50_000;
  fileNote("g1", T, "+3", { byName: "Max", name: "max.m4a" });
  const r = await asMember("g1", "+2", T + 1000, false, () => voiceNow("g1", { action: "use", name: "max", source: String(T) }, deps));
  assert.match(r, /Max's voice/);
  assert.match(r, /only in this group|used only in this group/);
  const meta = JSON.parse(readFileSync(join(lib("g1"), "max/meta.json"), "utf8"));
  assert.deepEqual([meta.by, meta.from, meta.source], ["+2", "+3", "audio file"]);
  assert.equal(activeVoice(lib("owner")), "default");
  assert.deepEqual(listVoices(lib("owner")), []);
});
