import type { VoiceFormat } from "@ted-assistant/messenger";

// The last step of every speech engine is ffmpeg turning the engine's audio into the voice message format the messenger sends
// (Messenger.capabilities.voiceFormat). The default is what Signal shows as a voice message: AAC in an .m4a.

export type { VoiceFormat };

/** The output file name and the ffmpeg codec arguments of a voice format. */
export function voiceEncoding(format: VoiceFormat = "m4a"): { file: string; args: string[] } {
  return format === "ogg-opus" ? { file: "voice.ogg", args: ["-c:a", "libopus", "-b:a", "32k"] } : { file: "voice.m4a", args: ["-c:a", "aac", "-b:a", "64k"] };
}
