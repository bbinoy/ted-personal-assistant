import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SAFE_INPUT, toolEnv } from "./internal/exec.ts";

// Audio FILES (an MP3, M4A, WAV, OGG, AAC, FLAC someone sends) as opposed to recorded voice messages. The bytes decide what a file is,
// never its name or the type the sender claimed: a cheap look at the first bytes says "this might be audio", ffprobe (run with
// execFile, no shell, plain files only) says what is really inside, and a file with a video stream, or none with audio, is refused.

const run = promisify(execFile);

/** Audio files larger than this (bytes) are not opened. */
export const MAX_AUDIO_FILE_BYTES = 50_000_000;
/** Only this much of a file is transcribed (and searched for a voice sample); longer files are cut, and the person is told. */
export const AUDIO_FILE_MAX_SECONDS = 300;

/** Pure: do the first bytes look like an audio container (MP3 with or without ID3, M4A/MP4, WAV, OGG, FLAC, AAC/ADTS, AIFF, AMR, Matroska/WebM)? Only a hint: ffprobe decides. */
export function audioMagic(head: Uint8Array): boolean {
  const s = Buffer.from(head.buffer, head.byteOffset, Math.min(head.byteLength, 16)).toString("latin1");
  if (s.startsWith("ID3") || s.startsWith("fLaC") || s.startsWith("OggS") || s.startsWith("#!AMR") || s.startsWith("\x1aE\xdf\xa3")) return true;
  if (s.startsWith("RIFF") && s.slice(8, 12) === "WAVE") return true;
  if (s.startsWith("FORM") && /^AIF[FC]/.test(s.slice(8, 12))) return true;
  if (s.slice(4, 8) === "ftyp") return true;
  const b0 = head[0] ?? 0;
  const b1 = head[1] ?? 0;
  return b0 === 0xff && (b1 & 0xe0) === 0xe0; // MPEG audio frame or ADTS sync
}

export interface AudioInfo {
  seconds: number;
  codec: string;
}

/** Pure: ffprobe's JSON -> the audio it describes, or a short reason it is not an audio file. */
export function audioVerdict(raw: string): AudioInfo | string {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return "not media";
  }
  const streams: any[] = Array.isArray(j?.streams) ? j.streams : [];
  const audio = streams.find((s) => s?.codec_type === "audio");
  if (!audio) return "no audio stream";
  // cover art in an MP3 or M4A is a "video" stream marked attached_pic; a real video is not audio
  if (streams.some((s) => s?.codec_type === "video" && Number(s?.disposition?.attached_pic ?? 0) !== 1)) return "video";
  const fmt = String(j?.format?.format_name ?? "");
  if (/\b(hls|concat|ffconcat|image2|rtsp|sdp|lavfi)\b/.test(fmt)) return "not a plain audio file";
  const seconds = Number(j?.format?.duration ?? audio?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown length";
  return { seconds, codec: String(audio.codec_name ?? "") };
}

/** What a file really is: its audio length and codec, or a short reason it is not audio. ffprobe runs on this machine with a timeout; nothing is sent anywhere. */
export async function probeAudio(file: string): Promise<AudioInfo | string> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", ...SAFE_INPUT, "-show_entries", "stream=codec_type,codec_name,duration:stream_disposition=attached_pic:format=format_name,duration", "-of", "json", file], {
      timeout: 30_000, env: toolEnv(), maxBuffer: 1_000_000,
    });
    return audioVerdict(stdout);
  } catch {
    return "not media";
  }
}
