import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAFE_INPUT } from "../src/internal/exec.ts";
import { sniffAudio } from "../src/tts-remote.ts";
import { synthesizeHttp } from "../src/tts-http.ts";

// Limits on what a remote speech server (or a file that only claims to be audio) can make us do. All HTTP is a mock.

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } });
    return true;
  } catch {
    return false;
  }
})();

// A real, tiny WAV (0.1 s of silence, 8 kHz mono, 16 bit).
function wav(): Buffer {
  const n = 800;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

const fetchOf = (respond: () => Response) => ((async () => respond()) as unknown as typeof fetch);

// A body that never ends and has no Content-Length: the reader must give up at the limit, not hold it all.
function endless(chunkBytes: number, counter: { pulled: number }, status = 200): Response {
  const chunk = new Uint8Array(chunkBytes).fill(0x41);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      counter.pulled++;
      controller.enqueue(chunk);
    },
  });
  return new Response(body, { status, headers: { "content-type": "audio/mpeg" } });
}

test("tts remote: an answer without Content-Length is cut off at the size limit, and an error body is read only briefly", async () => {
  const cfg = { url: "https://tts.example.com/say", timeoutMs: 5000 };
  const big = { pulled: 0 };
  await assert.rejects(synthesizeHttp("x", { ...cfg, fetchImpl: fetchOf(() => endless(1024 * 1024, big)) }), /larger than 26214400 bytes/);
  assert.ok(big.pulled <= 30, `stopped reading after ${big.pulled} MB`);
  const err = { pulled: 0 };
  await assert.rejects(synthesizeHttp("x", { ...cfg, fetchImpl: fetchOf(() => endless(1024, err, 500)) }), /HTTP 500/);
  assert.ok(err.pulled <= 16, `read only ${err.pulled} KB of an endless error body`);
});

test("tts remote: a body that stalls past the timeout is a timeout, not a hang", async () => {
  // like real fetch, the request's signal also aborts the body stream
  const stalls = (async (_u: string, init: RequestInit) =>
    new Response(new ReadableStream<Uint8Array>({ start: (c) => init.signal!.addEventListener("abort", () => c.error(init.signal!.reason)) }), { status: 200, headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
  await assert.rejects(synthesizeHttp("x", { url: "https://tts.example.com/say", timeoutMs: 40, fetchImpl: stalls }), /timeout/);
});

test("tts remote: the format comes from the bytes when they are recognisable, whatever the server calls it", () => {
  assert.equal(sniffAudio("audio/mpeg", wav()), "wav");
  assert.equal(sniffAudio("audio/wav", new TextEncoder().encode("OggS\u0000")), "ogg");
  assert.equal(sniffAudio("audio/mpeg", new Uint8Array(4)), "mp3");
  assert.equal(sniffAudio("text/plain", new TextEncoder().encode("#EXTM3U\n")), undefined);
});

test("ffmpeg input is limited to plain files: a real WAV still converts, a playlist naming a network address is refused", { skip: !hasFfmpeg && "ffmpeg is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "safe-input-"));
  const env = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
  try {
    writeFileSync(join(dir, "in.wav"), wav());
    execFileSync("ffmpeg", ["-v", "error", "-y", ...SAFE_INPUT, "-f", "wav", "-i", join(dir, "in.wav"), join(dir, "out.m4a")], { env });
    assert.ok(readFileSync(join(dir, "out.m4a")).length > 0);
    writeFileSync(join(dir, "list.m3u8"), "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/a.ts\n#EXT-X-ENDLIST\n");
    assert.throws(() => execFileSync("ffmpeg", ["-v", "error", "-y", ...SAFE_INPUT, "-i", join(dir, "list.m3u8"), "-f", "null", "-"], { env, stdio: "pipe" }), (e: { stderr: Buffer }) => /not on whitelist 'file'/.test(e.stderr.toString()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
