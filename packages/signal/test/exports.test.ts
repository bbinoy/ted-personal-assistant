import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.ts";
import * as voice from "../src/voice.ts";
import * as tts from "../src/speech.ts";
import * as messenger from "../src/messenger.ts";
import * as testing from "../src/testing.ts";

// The public surface, written down: an accidental addition or removal shows up here and is a deliberate change
// (and, after 1.0, a semver decision).
const names = (m: object) => Object.keys(m).sort();

test("exports: core entry", () => {
  assert.deepEqual(names(core), [
    "LONG_TEXT_TYPE",
    "MAX_AUDIO_BYTES",
    "MAX_FILE_BYTES",
    "MAX_IMAGE_BYTES",
    "MAX_LONG_TEXT_BYTES",
    "SignalClient",
    "attachmentPath",
    "defaultAttachmentsDir",
    "ensureSignalDaemon",
    "interpretEnvelope",
    "parseAudio",
    "parseFile",
    "parseImage",
    "parseLongText",
    "parseQuote",
    "personOf",
    "readLongText",
    "silentLogger",
    "toPerson",
    "withMentions",
  ]);
});

test("exports: ./voice", () => {
  assert.deepEqual(names(voice), ["AUDIO_FILE_MAX_SECONDS", "MAX_AUDIO_FILE_BYTES", "audioMagic", "audioVerdict", "cleanTranscript", "probeAudio", "transcribe", "voiceReady"]);
});

test("exports: ./tts", () => {
  assert.deepEqual(names(tts), [
    "ClipRefused", "DEFAULT_VOICE", "MAX_SECONDS", "MAX_SPOKEN_CHARS", "MAX_VOICES", "MIN_SECONDS", "OWNER_SCOPE", "VOICE_NAME", "activeVoice", "activeVoiceRel", "buildReference", "deleteVoice", "getMeta", "isSafeUrl", "listVoices", "looksLikeSpeech",
    "maxVoices", "providerReady", "qwenReady", "realClipTools", "removeScope", "sanitizeVoiceName", "saveVoice", "scopeRoot", "setActiveVoice", "stopQwen", "synthesize", "synthesizeQwen", "synthesizeWith", "ttsReady", "voiceFiles", "warmQwen",
  ]);
});

test("exports: ./messenger", () => {
  assert.deepEqual(names(messenger), ["createMessenger", "doctor", "toSignalStyles"]);
});

test("exports: ./testing", () => {
  assert.deepEqual(names(testing), ["FakeRpcError", "FakeSignalDaemon"]);
});
