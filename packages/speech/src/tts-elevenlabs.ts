import { synthesizeRemote, type Fetch } from "./tts-remote.ts";
import type { VoiceFormat } from "./voiceformat.ts";

// Optional hosted speech: ElevenLabs. The text to speak goes to elevenlabs.io; the voice (a stock voice, or a
// clone you made there with a voice you have the rights to) is chosen by its id; no recording is kept here.

/** Settings of the ElevenLabs engine. */
export interface ElevenLabsConfig {
  apiKey: string; // keep it out of source control; it is sent only as a request header and blanked from errors
  voiceId: string;
  modelId: string;
  timeoutMs: number;
  baseUrl?: string; // for tests
  fetchImpl?: Fetch;
}

export const ELEVENLABS_BASE = "https://api.elevenlabs.io";

export const synthesizeElevenLabs = (text: string, c: ElevenLabsConfig, format?: VoiceFormat, signal?: AbortSignal): Promise<string> =>
  synthesizeRemote(
    {
      url: `${c.baseUrl ?? ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(c.voiceId)}?output_format=mp3_44100_128`,
      headers: { "xi-api-key": c.apiKey, accept: "audio/mpeg" },
      body: { text, model_id: c.modelId },
      secrets: [c.apiKey],
      timeoutMs: c.timeoutMs,
      fetchImpl: c.fetchImpl,
      format,
      signal,
    },
    "ElevenLabs",
  );
