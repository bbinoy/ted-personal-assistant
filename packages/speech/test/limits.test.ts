import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SPOKEN_CHARS, qwenGenerationMs, voiceDeadlineMs } from "../src/limits.ts";

test("qwenGenerationMs: a base plus 0.15 s per character, covering the slowest measured speeds", () => {
  assert.equal(qwenGenerationMs(0), 15_000);
  assert.equal(qwenGenerationMs(1130), 15_000 + 169_500);
  // measured on a Mac: 414 chars took 34 s, 658 took 75 s, 1004 took up to 141 s, 1339 took 103 s
  for (const [chars, took] of [[414, 34], [658, 75], [1004, 141], [1339, 103]] as const) assert.ok(qwenGenerationMs(chars) >= took * 1000, `${chars} chars`);
});

test("voiceDeadlineMs: room for a cold start, the generation and the hand-over; grows with the text; bounded by MAX_SPOKEN_CHARS", () => {
  assert.equal(voiceDeadlineMs(0), 60_000 + 15_000 + 15_000);
  assert.ok(voiceDeadlineMs(200) > qwenGenerationMs(200) + 60_000);
  assert.ok(voiceDeadlineMs(1130) > voiceDeadlineMs(199));
  assert.ok(voiceDeadlineMs(MAX_SPOKEN_CHARS) <= 11 * 60_000);
});
