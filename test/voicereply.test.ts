import test from "node:test";
import assert from "node:assert/strict";
import { voiceOption, SPOKEN_STYLE } from "../src/conversation/voicereply.ts";

test("the voice option tells the model to write for the ear, and only when speech is set up", () => {
  assert.ok(voiceOption(true).includes(SPOKEN_STYLE));
  assert.match(SPOKEN_STYLE, /short sentences/);
  assert.match(SPOKEN_STYLE, /numbers, dates, times/);
  assert.match(SPOKEN_STYLE, /never any emoji/);
  assert.equal(voiceOption(false), "");
});
