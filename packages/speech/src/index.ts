// Entry point "./tts" of @ted-assistant/speech: voice notes out. Local Kokoro, or an optional remote engine (ElevenLabs, or your own HTTP server).
// Needs ffmpeg; Kokoro also needs its Python environment. Kept apart from the core (the root entry never imports from here).
export { synthesize, ttsReady, MAX_SPOKEN_CHARS, type TtsConfig } from "./tts.ts";
export { synthesizeWith, providerReady, type TtsProviderConfig, type TtsFallback } from "./tts-provider.ts";
export type { ElevenLabsConfig } from "./tts-elevenlabs.ts";
export type { HttpTtsConfig } from "./tts-http.ts";
export { isSafeUrl, type Fetch } from "./tts-remote.ts";
export { synthesizeQwen, warmQwen, stopQwen, qwenReady, type QwenConfig } from "./tts-qwen.ts";
export { OWNER_SCOPE, DEFAULT_VOICE, MAX_VOICES, NAME as VOICE_NAME, sanitizeVoiceName, scopeRoot, maxVoices, listVoices, activeVoice, setActiveVoice, saveVoice, deleteVoice, removeScope, getMeta, voiceFiles, activeVoiceRel, type VoiceMeta, type VoiceInfo } from "./voices.ts";
export { buildReference, looksLikeSpeech, realClipTools, ClipRefused, MIN_SECONDS, MAX_SECONDS, type ClipTools, type Reference } from "./voiceclip.ts";
