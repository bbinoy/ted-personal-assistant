/**
 * What bounds one synthesis, set by the caller that owns the overall deadline of a voice reply: aborting `signal` kills the running Qwen request,
 * Kokoro and ffmpeg (and throws the signal's reason); `remainingMs` says how much of the deadline is left, so a fallback that would not fit is not started.
 */
export interface SynthLimits {
  signal?: AbortSignal;
  remainingMs?: () => number;
}

/** Why a synthesis was given up on by its caller: it took longer than its deadline ("timeout"), or the Mac slept meanwhile ("slept"). */
export class VoiceAbort extends Error {
  readonly kind: "timeout" | "slept";
  constructor(kind: "timeout" | "slept", message = kind === "slept" ? "the Mac slept" : "took longer than its deadline") {
    super(message);
    this.name = "VoiceAbort";
    this.kind = kind;
  }
}

/** The least time Kokoro needs for a typical reply (about 12 s on a quiet machine, with margin): the fallback is not started with less left. */
export const KOKORO_MIN_MS = 30_000;
