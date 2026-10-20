import { synthesizeRemote, type Fetch } from "./tts-remote.ts";
import type { VoiceFormat } from "./voiceformat.ts";

// Optional speech from a server of your own (a serverless GPU running F5-TTS or Chatterbox, say). The contract is
// in packages/speech/docs/remote-tts.md: POST JSON {text, voice?, reference_id?}, optional bearer token, audio bytes back.
// The reference recording of a cloned voice stays on that server; here it is only named by `reference_id`.

/** Settings of the generic HTTP engine. */
export interface HttpTtsConfig {
  url: string; // https, or http on this machine
  token?: string; // sent as a bearer token and blanked from errors; keep it out of source control
  voice?: string;
  referenceId?: string;
  timeoutMs: number;
  fetchImpl?: Fetch;
}

export const synthesizeHttp = (text: string, c: HttpTtsConfig, format?: VoiceFormat): Promise<string> =>
  synthesizeRemote(
    {
      url: c.url,
      headers: c.token ? { authorization: `Bearer ${c.token}` } : {},
      body: { text, ...(c.voice ? { voice: c.voice } : {}), ...(c.referenceId ? { reference_id: c.referenceId } : {}) },
      secrets: c.token ? [c.token] : [],
      timeoutMs: c.timeoutMs,
      fetchImpl: c.fetchImpl,
      format,
    },
    "Remote speech server",
  );
