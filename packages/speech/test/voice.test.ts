import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript } from "../src/transcribe.ts";

test("voice: whisper's silence markers are dropped, the words kept", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO]\n"), "");
  assert.equal(cleanTranscript("[Music] Move my 3pm to Thursday (laughs) please.\n"), "Move my 3pm to Thursday please.");
});
