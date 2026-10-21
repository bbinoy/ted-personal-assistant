import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutSecrets } from "@ted-assistant/messenger/env";
import { toolEnv } from "../src/internal/exec.ts";

test("helper processes get no credentials: keys, tokens, secrets, passwords and agent sockets are dropped, the rest is kept", () => {
  const env = withoutSecrets({ PATH: "/bin", HOME: "/h", LANG: "C", ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "b", ELEVENLABS_API_KEY: "c", TTS_HTTP_TOKEN: "d", AWS_SECRET_ACCESS_KEY: "e", DB_PASSWORD: "f", SSH_AUTH_SOCK: "/s", HF_TOKEN: "g" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
});

test("toolEnv: no credentials from this process reach ffmpeg, whisper or Kokoro, and the Homebrew directories are on PATH", () => {
  process.env.FAKE_SPEECH_API_KEY = "must-not-leak";
  try {
    const env = toolEnv();
    assert.equal(env.FAKE_SPEECH_API_KEY, undefined);
    assert.match(env.PATH ?? "", /\/opt\/homebrew\/bin/);
  } finally {
    delete process.env.FAKE_SPEECH_API_KEY;
  }
});
