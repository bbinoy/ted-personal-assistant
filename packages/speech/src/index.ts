// Entry point "./tts" of @ted-assistant/speech: voice notes out. The local cloned voice (Qwen3-TTS), or an optional remote engine (ElevenLabs, or your own HTTP server).
// Needs ffmpeg; Qwen also needs its Python environment. Kept apart from the core (the root entry never imports from here).
export { synthesizeWith, providerReady, type TtsProviderConfig } from "./tts-provider.ts";
export { VoiceAbort, MAX_SPOKEN_CHARS, qwenGenerationMs, voiceDeadlineMs, type SynthLimits } from "./limits.ts";
export type { ElevenLabsConfig } from "./tts-elevenlabs.ts";
export type { HttpTtsConfig } from "./tts-http.ts";
export { isSafeUrl, type Fetch } from "./tts-remote.ts";
export { synthesizeQwen, warmQwen, stopQwen, qwenReady, type QwenConfig } from "./tts-qwen.ts";
export { OWNER_SCOPE, DEFAULT_VOICE, MAX_VOICES, NAME as VOICE_NAME, sanitizeVoiceName, scopeRoot, maxVoices, listVoices, activeVoice, setActiveVoice, saveVoice, deleteVoice, removeScope, getMeta, voiceFiles, activeVoiceRel, type VoiceMeta, type VoiceInfo } from "./voices.ts";
export { buildReference, looksLikeSpeech, realClipTools, ClipRefused, MIN_SECONDS, MAX_SECONDS, type ClipTools, type Reference } from "./voiceclip.ts";
