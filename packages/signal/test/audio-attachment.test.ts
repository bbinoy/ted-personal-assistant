import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAudio } from "../src/envelope.ts";

test("voice: only a plain, reasonably sized audio attachment is accepted", () => {
  assert.deepEqual(parseAudio([{ contentType: "audio/aac", id: "abc-DEF_1.m4a", size: 40000 }]), { id: "abc-DEF_1.m4a", size: 40000 });
  assert.deepEqual(parseAudio([{ contentType: "image/jpeg", id: "x.jpg", size: 10 }, { contentType: "audio/mp4", id: "v1", size: 5 }]), { id: "v1", size: 5 });
  assert.equal(parseAudio([{ contentType: "image/jpeg", id: "x.jpg", size: 10 }]), undefined);
  assert.equal(parseAudio([{ contentType: "audio/aac", id: "../../.ssh/id_rsa", size: 10 }]), undefined);
  assert.equal(parseAudio([{ contentType: "audio/aac", id: ".hidden", size: 10 }]), undefined);
  assert.equal(parseAudio([{ contentType: "audio/aac", id: "big", size: 99_000_000 }]), undefined);
  assert.equal(parseAudio(undefined), undefined);
});
