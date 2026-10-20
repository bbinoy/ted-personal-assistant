// Entry point "./voice": voice notes in. Local speech to text with ffmpeg and whisper.cpp; needs those programs installed.
// Kept apart from the core (the root entry never imports from here).
export { transcribe, voiceReady, cleanTranscript } from "./transcribe.ts";
export { probeAudio, audioVerdict, audioMagic, MAX_AUDIO_FILE_BYTES, AUDIO_FILE_MAX_SECONDS } from "./audiofile.ts";
export type { AudioInfo } from "./audiofile.ts";
