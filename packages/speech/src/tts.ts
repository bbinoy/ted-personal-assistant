import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { onPath, toolEnv } from "./internal/exec.ts";
import { voiceEncoding, type VoiceFormat } from "./voiceformat.ts";

// Text to speech, on this machine: Kokoro (an open-source neural voice model, run through onnx in its
// own Python environment) makes the audio, ffmpeg turns it into the voice message format of the messenger (AAC for Signal, which shows it as a
// voice message). No network, no API key. `scripts/setup-tts.sh` in this package installs everything.
// English only: voices starting with "b" speak en-gb, all others en-us (scripts/kokoro-say.py).

const run = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../scripts/kokoro-say.py");
const TIMEOUT_MS = 240_000; // synthesis runs at roughly 10 to 20 times real time; this is generous even for MAX_SPOKEN_CHARS

/**
 * The longest text worth speaking. Measured: about 1,250 characters are one minute of speech (2,145 characters came
 * out as 102 seconds, made in 26 s), so this is roughly three minutes. Longer than that is not a voice message.
 */
export const MAX_SPOKEN_CHARS = 3500;

/** Settings of the local Kokoro voice. */
export interface TtsConfig {
  dir: string; // holds venv/, kokoro-v1.0.onnx and voices-v1.0.bin
  voice: string; // a Kokoro voice, like am_onyx
  speed: number; // 1 is normal
}

const files = (dir: string) => ({ python: join(dir, "venv/bin/python"), model: join(dir, "kokoro-v1.0.onnx"), voices: join(dir, "voices-v1.0.bin") });

/** What is missing for local speech: the Python environment, the model files, ffmpeg. */
export function ttsReady(dir: string): { ok: boolean; missing: string[] } {
  const f = files(dir);
  const missing = Object.entries({ "Python environment": f.python, "Kokoro model": f.model, "Kokoro voices": f.voices }).filter(([, p]) => !existsSync(p)).map(([n]) => n);
  if (!onPath("ffmpeg")) missing.push("ffmpeg");
  return { ok: missing.length === 0, missing };
}

// A failed child process says why only in its exit code, signal and stderr: keep them in the error, so a log line is enough to diagnose it.
async function step<T>(name: string, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const x = e as { code?: unknown; signal?: unknown; killed?: boolean; stderr?: string; message: string };
    throw new Error(`${name} failed (exit ${x.code ?? "?"}, signal ${x.signal ?? "none"}${x.killed ? ", killed: timeout?" : ""}): ${(x.stderr ?? "").trim().split("\n").slice(-4).join(" | ") || x.message.slice(0, 200)}`);
  }
}

/**
 * Speaks `text` locally and returns the path of a voice message (an .m4a, or the `format` asked for) in a fresh temp folder (mode 0700). The caller
 * sends it and then deletes that folder (`dirname` of the path).
 * @throws if the Python environment, the model or ffmpeg is missing or fails, or after 240 s
 */
export async function synthesize(text: string, cfg: TtsConfig, format?: VoiceFormat): Promise<string> {
  const f = files(cfg.dir);
  const dir = await mkdtemp(join(tmpdir(), "speech-"));
  const wav = join(dir, "say.wav");
  const enc = voiceEncoding(format);
  const out = join(dir, enc.file);
  const env = toolEnv();
  const py = run(f.python, [SCRIPT, f.model, f.voices, cfg.voice, String(cfg.speed), wav], { timeout: TIMEOUT_MS, env });
  py.child.stdin?.end(text);
  await step("speech model", py);
  await step("ffmpeg", run("ffmpeg", ["-v", "error", "-y", "-i", wav, ...enc.args, out], { timeout: TIMEOUT_MS, env }));
  return out;
}
