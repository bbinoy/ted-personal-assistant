import { synthesize, ttsReady, type TtsConfig } from "./tts.ts";
import { synthesizeElevenLabs, type ElevenLabsConfig } from "./tts-elevenlabs.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { synthesizeHttp, type HttpTtsConfig } from "./tts-http.ts";
import { OWNER_SCOPE } from "./voices.ts";
import { qwenReady, synthesizeQwen, type QwenConfig } from "./tts-qwen.ts";
import type { VoiceFormat } from "./voiceformat.ts";
import { KOKORO_MIN_MS, VoiceAbort, type SynthLimits } from "./limits.ts";

// Which engine speaks: Kokoro on this machine (the default, nothing leaves it), or a remote one by choice.
// Every provider returns the path of a voice message (an .m4a, or the `format` asked for) in a fresh temp folder, or throws; the caller then sends text.

/** What happens when a remote engine fails: "none" (the call throws) or "kokoro" (the same words, spoken locally). */
export type TtsFallback = "none" | "kokoro";

/** Which engine speaks, with its settings. `kokoro` is always needed (it is also the optional fallback). */
export type TtsProviderConfig = { kokoro: TtsConfig; fallback: TtsFallback } & (
  | { provider: "kokoro" }
  | { provider: "elevenlabs"; elevenlabs: ElevenLabsConfig }
  | { provider: "http"; http: HttpTtsConfig }
  | { provider: "qwen"; qwen: QwenConfig }
);

/** What is missing for speech with this provider. A remote provider needs only ffmpeg; Qwen needs its environment and reference, or Kokoro as fallback. */
export function providerReady(cfg: TtsProviderConfig): { ok: boolean; missing: string[] } {
  const local = ttsReady(cfg.kokoro.dir);
  if (cfg.provider === "kokoro") return local;
  if (cfg.provider === "qwen") {
    // Ready when the cloned voice is, or when Kokoro can stand in for it (the fallback); nothing leaves the Mac either way.
    const q = qwenReady(cfg.qwen);
    return q.ok || (cfg.fallback === "kokoro" && local.ok) ? { ok: true, missing: [] } : { ok: false, missing: q.missing };
  }
  return { ok: !local.missing.includes("ffmpeg"), missing: local.missing.filter((m) => m === "ffmpeg") };
}

/**
 * Speaks `text` with the configured engine (qwen: local cloned voice, nothing leaves the Mac) and returns the path of a voice message (an .m4a unless `format` says otherwise) in a fresh temp folder, which the caller
 * deletes after sending. `scope` is the conversation ("owner" or a group id): the cloned voice is the one active there. A remote engine sends the text to a third party. A failed remote request throws, unless
 * `fallback` is "kokoro" and Kokoro is set up; a silent switch never happens otherwise.
 */
export async function synthesizeWith(text: string, cfg: TtsProviderConfig, log: Logger = silentLogger, scope: string = OWNER_SCOPE, format?: VoiceFormat, limits: SynthLimits = {}): Promise<string> {
  const t0 = Date.now();
  const { signal } = limits;
  const done = (provider: string, file: string) => (log.info(`voice: ${provider} synthesised ${text.length} chars in ${Date.now() - t0} ms`), file);
  if (cfg.provider === "kokoro") return done("kokoro", await synthesize(text, cfg.kokoro, format, limits));
  try {
    if (cfg.provider === "qwen" && !qwenReady(cfg.qwen).ok) throw new Error(`Qwen voice not set up, missing: ${qwenReady(cfg.qwen).missing.join(", ")}`);
    return done(cfg.provider, await (cfg.provider === "qwen" ? synthesizeQwen(text, cfg.qwen, scope, format, signal) : cfg.provider === "elevenlabs" ? synthesizeElevenLabs(text, cfg.elevenlabs, format, signal) : synthesizeHttp(text, cfg.http, format, signal)));
  } catch (e) {
    if (signal?.aborted) throw signal.reason; // the caller's deadline ran out (or the Mac slept): no second engine
    // Only when asked for (fallback: "kokoro"): the same words, spoken locally.
    if (cfg.fallback !== "kokoro" || !ttsReady(cfg.kokoro.dir).ok) throw e;
    const left = limits.remainingMs?.();
    if (left !== undefined && left < KOKORO_MIN_MS) {
      log.warn(`${cfg.provider} speech failed, and ${Math.max(0, Math.round(left / 1000))} s are too few for Kokoro:`, (e as Error).message);
      throw new VoiceAbort("timeout");
    }
    log.warn(`${cfg.provider} speech failed, using Kokoro:`, (e as Error).message);
    return done("kokoro (fallback)", await synthesize(text, cfg.kokoro, format, limits));
  }
}
