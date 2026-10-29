import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SAFE_INPUT, toolEnv } from "./internal/exec.ts";
import { AUDIO_FILE_MAX_SECONDS, probeAudio, type AudioInfo } from "./audiofile.ts";
import { transcribe } from "./transcribe.ts";

// A voice note -> the reference clip of a cloned voice: mono 24 kHz wav, silence trimmed at both ends, at most 15 s (the best stretch
// when it is longer), with the words said in it (local whisper). A clip that is too short, too long to take, mostly silence, or not
// speech is refused with a sentence the person can be told. ffmpeg and whisper run here, on this machine; nothing is sent anywhere.

const run = promisify(execFile);
const RATE = 24_000;
export const MIN_SECONDS = 3;
export const MAX_SECONDS = 15; // measured: a 27 s reference doubled the time of every reply (the clip is part of the prompt) against a 10 s one
const HARD_MAX_SECONDS = 300; // longer recordings are refused instead of searched
const FRAME = RATE / 10; // 100 ms

export interface ClipTools {
  /** Mono 24 kHz signed 16-bit samples of the recording, leading and trailing silence trimmed. */
  decode(file: string): Promise<Int16Array>;
  /** The words in a wav file ("" when none). */
  transcribe(wav: string): Promise<string>;
  /** What an audio FILE really is (ffprobe): its length, or a short reason it is not audio (video, other). */
  probe(file: string): Promise<AudioInfo | string>;
}

export interface BuildOptions {
  /** An audio file somebody sent, not a voice message: it must really be audio (not video), and only the first AUDIO_FILE_MAX_SECONDS are searched instead of refusing a long one. */
  file?: boolean;
}

export function realClipTools(whisperModel: string): ClipTools {
  return {
    async decode(file) {
      const af = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse";
      const { stdout } = await run("ffmpeg", ["-v", "error", ...SAFE_INPUT, "-i", file, "-vn", "-t", String(HARD_MAX_SECONDS + 1), "-ac", "1", "-ar", String(RATE), "-af", af, "-f", "s16le", "-"], {
        encoding: "buffer", timeout: 120_000, env: toolEnv(), maxBuffer: (HARD_MAX_SECONDS + 2) * RATE * 2,
      });
      const b = Buffer.from(stdout);
      return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 2)));
    },
    transcribe: (wav) => transcribe(wav, whisperModel),
    probe: probeAudio,
  };
}

const db = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-9) / 32768);

/** Pure: loudness of each 100 ms frame in dB below full scale. */
function frameLevels(pcm: Int16Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    let s = 0;
    for (let j = i; j < i + FRAME; j++) s += pcm[j]! * pcm[j]!;
    out.push(db(Math.sqrt(s / FRAME)));
  }
  return out;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

/** Pure: why a clip cannot be a voice (silence, noise), or undefined when it looks like speech. */
function notSpeech(levels: number[]): string | undefined {
  if (!levels.length) return "That recording is empty.";
  const sorted = [...levels].sort((a, b) => a - b);
  const loud = pct(sorted, 0.9);
  if (loud < -45) return "That recording is almost silent. Record it again a bit closer to the microphone.";
  const voiced = levels.filter((l) => l > Math.max(-50, loud - 20)).length / levels.length;
  if (voiced < 0.4) return "That recording is mostly silence. I need a clip where you talk for several seconds.";
  if (loud - pct(sorted, 0.1) < 6) return "That recording sounds like steady noise, not speech.";
  return undefined;
}

/** Pure: the best stretch of at most `max` seconds: the one with the most speech, its ends moved to the quietest moment nearby so no word is cut. */
function bestWindow(levels: number[], max = MAX_SECONDS): { from: number; to: number } {
  const w = Math.min(levels.length, (max - 2) * 10); // leave room to move the ends
  if (levels.length <= max * 10) return { from: 0, to: levels.length };
  const sorted = [...levels].sort((a, b) => a - b);
  const gate = Math.max(-50, pct(sorted, 0.9) - 20);
  let best = 0;
  let bestScore = -Infinity;
  // Most speech wins, and a long silence inside the window costs more than the frames it lacks: a stretch of continuous talking beats
  // one with a pause in the middle (or music that fades in and out around a few words). Ties keep the earliest stretch.
  // Speech rises and falls from syllable to syllable; a steady tone or hum (an intro jingle, a held note) does not, so a loud frame only counts
  // when the level moves by a dB or more next to it.
  const lively = levels.map((l, i) => Math.abs(l - (levels[i - 1] ?? l)) >= 1 || Math.abs(l - (levels[i + 1] ?? l)) >= 1);
  for (let s = 0; s + w <= levels.length; s++) {
    let voiced = 0;
    let run = 0;
    let longest = 0;
    for (let i = s; i < s + w; i++) {
      if (levels[i]! > gate) (lively[i] && voiced++, (run = 0));
      else longest = Math.max(longest, ++run);
    }
    const score = voiced - 2 * Math.max(0, longest - 5); // pauses up to half a second are speech rhythm
    if (score > bestScore) (bestScore = score, (best = s));
  }
  const quietest = (a: number, b: number) => {
    let q = a;
    for (let i = a; i < b; i++) if (levels[i]! < levels[q]!) q = i;
    return q;
  };
  const from = quietest(Math.max(0, best - 10), best + 10 > levels.length ? levels.length - 1 : best + 10);
  const to = Math.min(levels.length, quietest(Math.max(from + 1, from + w - 10), Math.min(levels.length - 1, from + w + 10)) + 1);
  return { from, to: Math.min(to, from + max * 10) };
}

/** Pure: a 16-bit mono wav file. */
function wavBytes(pcm: Int16Array, rate = RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Pure: whether a transcript is plausibly speech (a few real words), not whisper's brackets, a lone filler or nothing. */
export function looksLikeSpeech(text: string): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters >= 8 && text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 3;
}

export class ClipRefused extends Error {}

export interface Reference {
  wav: Buffer;
  text: string;
  seconds: number;
}

/** Makes the reference clip of a voice note file, or throws ClipRefused with a sentence. */
export async function buildReference(file: string, tools: ClipTools, opts: BuildOptions = {}): Promise<Reference> {
  if (opts.file) {
    const info = await tools.probe(file).catch(() => "not media" as const);
    if (typeof info === "string") throw new ClipRefused(info === "video" ? "That file is a video, not audio, so I can't make a voice from it." : "That file is not real audio, so I can't make a voice from it.");
  }
  let pcm: Int16Array;
  try {
    pcm = await tools.decode(file);
  } catch {
    throw new ClipRefused("I couldn't read that audio.");
  }
  if (opts.file && pcm.length > AUDIO_FILE_MAX_SECONDS * RATE) pcm = pcm.subarray(0, AUDIO_FILE_MAX_SECONDS * RATE); // a long file: its first minutes are searched
  if (pcm.length > HARD_MAX_SECONDS * RATE) throw new ClipRefused(`That recording is over ${HARD_MAX_SECONDS / 60} minutes. Send a clip of 10 to 15 seconds.`);
  if (pcm.length < MIN_SECONDS * RATE) throw new ClipRefused(`That clip is too short (${(pcm.length / RATE).toFixed(1)} s). I need at least ${MIN_SECONDS} seconds of speech, ideally 10 to 15.`);
  const levels = frameLevels(pcm);
  const { from, to } = bestWindow(levels);
  const bad = notSpeech(levels.slice(from, to)); // the stretch that is used must be speech; a long recording with only a few seconds of it is fine
  if (bad) throw new ClipRefused(bad);
  const clip = pcm.subarray(from * FRAME, Math.min(pcm.length, to * FRAME));
  if (clip.length < MIN_SECONDS * RATE) throw new ClipRefused("That clip is too short.");
  const wav = wavBytes(clip);
  const dir = await mkdtemp(join(tmpdir(), "voiceclip-"));
  let text = "";
  try {
    const f = join(dir, "clip.wav");
    await writeFile(f, wav, { mode: 0o600 });
    text = (await tools.transcribe(f)).trim();
  } catch {
    throw new ClipRefused("I couldn't transcribe that clip, and a voice needs the words that are said in it.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (!looksLikeSpeech(text)) throw new ClipRefused("I couldn't hear clear speech in that clip.");
  return { wav, text, seconds: Math.round((clip.length / RATE) * 10) / 10 };
}
