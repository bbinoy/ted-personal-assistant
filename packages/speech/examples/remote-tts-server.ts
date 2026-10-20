// SAMPLE ONLY: a stand-in for your own speech server, to test the plumbing locally. It follows the contract in
// docs/remote-tts.md but makes no speech: it answers with a short sine-wave beep whose length follows the text.
// No model, no voice, no recording. Replace `render` with a real model (F5-TTS, Chatterbox, ...) on your own server.
//
//   TTS_SAMPLE_TOKEN=some-long-random-string node examples/remote-tts-server.ts
//   then use  { provider: "http", http: { url: "http://localhost:8787/tts", token: "some-long-random-string", timeoutMs: 60000 }, ... }  with synthesizeWith
import { createServer } from "node:http";

const PORT = Number(process.env.TTS_SAMPLE_PORT ?? 8787);
const TOKEN = process.env.TTS_SAMPLE_TOKEN; // optional; when set, requests must carry it as a bearer token
const RATE = 16_000;

// {text, voice?, reference_id?} -> a 16-bit mono WAV. `reference_id` would name, on YOUR server, the recording a cloned voice is made from.
function render(text: string, voice?: string): Buffer {
  const seconds = Math.min(10, Math.max(0.3, text.length / 15));
  const hz = voice === "high" ? 660 : 440;
  const n = Math.floor(RATE * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * 8000), 44 + i * 2);
  return b;
}

createServer((req, res) => {
  const fail = (code: number, msg: string) => res.writeHead(code, { "content-type": "text/plain" }).end(msg);
  if (req.method !== "POST" || req.url !== "/tts") return fail(404, "POST /tts");
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return fail(401, "bad token");
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    try {
      const { text, voice } = JSON.parse(body) as { text?: unknown; voice?: unknown };
      if (typeof text !== "string" || !text.trim()) return fail(400, "text is required");
      res.writeHead(200, { "content-type": "audio/wav" }).end(render(text, typeof voice === "string" ? voice : undefined));
    } catch {
      fail(400, "invalid JSON");
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`sample speech server on http://localhost:${PORT}/tts`));
