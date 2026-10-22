import { test } from "node:test";
import assert from "node:assert/strict";
import * as voice from "../src/voice.ts";
import * as tts from "../src/index.ts";

// The entry points the app uses, written down: an accidental addition or removal shows up here and is a deliberate change.
const names = (m: object) => Object.keys(m).sort();

test("exports: ./voice", () => {
  assert.deepEqual(names(voice), ["AUDIO_FILE_MAX_SECONDS", "MAX_AUDIO_FILE_BYTES", "audioMagic", "audioVerdict", "cleanTranscript", "probeAudio", "transcribe", "voiceReady"]);
});

test("exports: ./tts", () => {
  assert.deepEqual(names(tts), [
    "ClipRefused", "DEFAULT_VOICE", "KOKORO_MIN_MS", "MAX_SECONDS", "MAX_SPOKEN_CHARS", "MAX_VOICES", "MIN_SECONDS", "OWNER_SCOPE", "VOICE_NAME", "VoiceAbort", "activeVoice", "activeVoiceRel", "buildReference", "deleteVoice", "getMeta", "isSafeUrl", "listVoices", "looksLikeSpeech",
    "maxVoices", "providerReady", "qwenReady", "realClipTools", "removeScope", "sanitizeVoiceName", "saveVoice", "scopeRoot", "setActiveVoice", "stopQwen", "synthesize", "synthesizeQwen", "synthesizeWith", "ttsReady", "voiceFiles", "warmQwen",
  ]);
});
