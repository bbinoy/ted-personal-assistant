import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceEncoding } from "../src/voiceformat.ts";

test("the voice encoding follows the messenger's voice format", () => {
  assert.deepEqual(voiceEncoding(), { file: "voice.m4a", args: ["-c:a", "aac", "-b:a", "64k"] });
  assert.deepEqual(voiceEncoding("m4a"), voiceEncoding());
  assert.deepEqual(voiceEncoding("ogg-opus"), { file: "voice.ogg", args: ["-c:a", "libopus", "-b:a", "32k"] });
});
