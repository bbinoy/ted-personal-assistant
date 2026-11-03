/**
 * What bounds one synthesis, set by the caller that owns the overall deadline of a voice reply: aborting `signal` kills the running Qwen request,
 * the remote request and ffmpeg (and throws the signal's reason).
 */
export interface SynthLimits {
  signal?: AbortSignal;
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

/**
 * The longest text worth speaking. Measured: about 1,250 characters are one minute of speech, so this is roughly three minutes.
 * Longer than that is not a voice message.
 */
export const MAX_SPOKEN_CHARS = 3500;

// Measured on a Mac (Qwen3-TTS, 8-bit): 414 chars took 34 s, 658 took 75 s, 1004 took 56 to 141 s, 1339 took 103 s; under memory pressure about 10 chars/s or
// slower. A base of 15 s plus 0.15 s per character (6.7 chars/s) covers the slowest of those with margin.
const GENERATION_BASE_MS = 15_000;
const GENERATION_MS_PER_CHAR = 150;

/** How long one Qwen request may take to generate `chars` characters, once the server is up and it is the request's turn (a cold start and the queue do not count). */
export const qwenGenerationMs = (chars: number): number => GENERATION_BASE_MS + GENERATION_MS_PER_CHAR * chars;

const COLD_START_MS = 60_000; // a cold start of the Qwen server takes 5 to 50 s depending on memory pressure
const HAND_OVER_MS = 15_000; // the language check, the conversion with ffmpeg and the hand-over to the messenger

/** The ONE deadline of a whole voice reply of `chars` characters: a cold start, the generation, the conversion and the hand-over. Over it the words go out as text. */
export const voiceDeadlineMs = (chars: number): number => COLD_START_MS + qwenGenerationMs(chars) + HAND_OVER_MS;
