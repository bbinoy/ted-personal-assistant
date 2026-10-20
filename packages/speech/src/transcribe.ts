import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { onPath, SAFE_INPUT, toolEnv } from "./internal/exec.ts";

// Voice messages are transcribed on this machine: ffmpeg turns the recording into 16 kHz mono audio,
// whisper.cpp (the open-source port of OpenAI's Whisper) turns that into text. No network, no API key.

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;

/** Whisper marks silence and noise in brackets or parentheses; keeps only the words. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** What is missing for transcription: ffmpeg, whisper-cli, or the model file. */
export function voiceReady(model: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!onPath("ffmpeg")) missing.push("ffmpeg");
  if (!onPath("whisper-cli")) missing.push("whisper-cli (whisper.cpp; on macOS: brew install whisper-cpp)");
  if (!existsSync(model)) missing.push(`model ${model}`);
  return { ok: missing.length === 0, missing };
}

/**
 * Transcribes a recording locally (language detected automatically; no limit on concurrent calls).
 * @param file any audio file ffmpeg can read
 * @param model path of a whisper.cpp ggml model file
 * @param maxSeconds transcribe only this much from the start (a long audio file)
 * @throws if ffmpeg or whisper-cli is missing or fails, or after 120 s
 */
export async function transcribe(file: string, model: string, maxSeconds?: number): Promise<string> {
  if (!existsSync(file)) throw new Error("the recording is not on disk");
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  const env = toolEnv();
  try {
    const wav = join(dir, "in.wav");
    await run("ffmpeg", ["-v", "error", ...SAFE_INPUT, "-i", file, ...(maxSeconds ? ["-t", String(maxSeconds)] : []), "-ar", "16000", "-ac", "1", "-f", "wav", wav], { timeout: TIMEOUT_MS, env });
    const { stdout } = await run("whisper-cli", ["-m", model, "-f", wav, "-l", "auto", "-nt", "-np"], { timeout: TIMEOUT_MS, env, maxBuffer: 4_000_000 });
    return cleanTranscript(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
