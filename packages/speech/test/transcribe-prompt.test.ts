import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transcribe } from "../src/transcribe.ts";

test("transcribe: a failing whisper-cli does not repeat the prompt in its error", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-bin-"));
  const path = process.env.PATH;
  try {
    for (const [name, body] of [["ffmpeg", "exit 0"], ["whisper-cli", 'echo "bad: $*" >&2; exit 3']] as const) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = `${bin}:${path}`;
    const audio = join(bin, "in.ogg");
    writeFileSync(audio, "x");
    await assert.rejects(transcribe(audio, "model.bin", undefined, "Zorbel Quint"), (e: Error) => {
      assert.doesNotMatch(e.message, /Zorbel/);
      assert.match(e.message, /whisper-cli failed/);
      return true;
    });
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});
