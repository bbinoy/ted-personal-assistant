import { test } from "node:test";
import assert from "node:assert/strict";

// The app reaches the signal package only through its public entry points (never packages/signal/src paths):
// every one must resolve from here, which is how a broken `exports` map would show up.
test("the signal package entry points the app uses resolve", async () => {
  const core = await import("@ted-personal-assistant/signal");
  const testing = await import("@ted-personal-assistant/signal/testing");
  assert.equal(typeof core.SignalClient, "function");
  assert.equal(typeof testing.FakeSignalDaemon, "function");
});

// The speech libraries are their own private package: the app imports them by its entry points, never by src paths.
test("the speech package entry points the app uses resolve", async () => {
  const voice = await import("@ted-personal-assistant/speech/voice");
  const tts = await import("@ted-personal-assistant/speech/tts");
  assert.equal(typeof voice.transcribe, "function");
  assert.equal(typeof tts.synthesizeWith, "function");
});
