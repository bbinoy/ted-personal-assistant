import { onPath } from "./internal/exec.ts";
import { synthesizeElevenLabs, type ElevenLabsConfig } from "./tts-elevenlabs.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { synthesizeHttp, type HttpTtsConfig } from "./tts-http.ts";
import { OWNER_SCOPE } from "./voices.ts";
import { qwenReady, synthesizeQwen, type QwenConfig } from "./tts-qwen.ts";
import type { VoiceFormat } from "./voiceformat.ts";
import type { SynthLimits } from "./limits.ts";

// Which engine speaks: the local cloned voice (Qwen, the default, nothing leaves the Mac), or a remote one by choice.
// Every provider returns the path of a voice message (an .m4a, or the `format` asked for) in a fresh temp folder, or throws; the caller then sends text.

/** Which engine speaks, with its settings. */
export type TtsProviderConfig =
  | { provider: "elevenlabs"; elevenlabs: ElevenLabsConfig }
  | { provider: "http"; http: HttpTtsConfig }
  | { provider: "qwen"; qwen: QwenConfig };

/** What is missing for speech with this provider. A remote provider needs only ffmpeg; Qwen needs its environment and reference: never another voice in its place. */
export function providerReady(cfg: TtsProviderConfig): { ok: boolean; missing: string[] } {
  if (cfg.provider === "qwen") return qwenReady(cfg.qwen);
  return onPath("ffmpeg") ? { ok: true, missing: [] } : { ok: false, missing: ["ffmpeg"] };
}

/**
 * Speaks `text` with the configured engine (qwen: local cloned voice, nothing leaves the Mac) and returns the path of a voice message (an .m4a unless `format` says otherwise) in a fresh temp folder, which the caller
 * deletes after sending. `scope` is the conversation ("owner" or a group id): the cloned voice is the one active there. A remote engine sends the text to a third party. A failed request throws (the caller sends text): there is no switch to
 * another engine, so the voice is never a different one than the one configured.
 */
export async function synthesizeWith(text: string, cfg: TtsProviderConfig, log: Logger = silentLogger, scope: string = OWNER_SCOPE, format?: VoiceFormat, limits: SynthLimits = {}): Promise<string> {
  const t0 = Date.now();
  const { signal } = limits;
  const done = (provider: string, file: string) => (log.info(`voice: ${provider} synthesised ${text.length} chars in ${Date.now() - t0} ms`), file);
  try {
    if (cfg.provider === "qwen" && !qwenReady(cfg.qwen).ok) throw new Error(`Qwen voice not set up, missing: ${qwenReady(cfg.qwen).missing.join(", ")}`);
    return done(cfg.provider, await (cfg.provider === "qwen" ? synthesizeQwen(text, cfg.qwen, scope, format, signal) : cfg.provider === "elevenlabs" ? synthesizeElevenLabs(text, cfg.elevenlabs, format, signal) : synthesizeHttp(text, cfg.http, format, signal)));
  } catch (e) {
    throw signal?.aborted ? signal.reason : e; // the caller's deadline ran out (or the Mac slept)
  }
}
