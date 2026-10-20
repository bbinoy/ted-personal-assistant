// The core of @ted-personal-assistant/signal: the signal-cli client and daemon. See README.md.
// Optional parts are separate entry points: "./messenger" (the Messenger adapter), "./testing" (a fake daemon). Speech lives in packages/speech.
export { SignalClient, toPerson, personOf } from "./client.ts";
export type { SignalGroup, SignalClientOptions, SendOptions, CloseInfo } from "./client.ts";
export { attachmentPath, defaultAttachmentsDir, parseQuote, parseAudio, parseImage, parseFile, parseLongText, readLongText, withMentions, interpretEnvelope, MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, MAX_FILE_BYTES, MAX_LONG_TEXT_BYTES, LONG_TEXT_TYPE } from "./envelope.ts";
export type { Channel, Quote, IncomingMessage, IncomingReaction, IncomingDeletion, AudioRef, ImageRef, FileRef, LongTextRef } from "./envelope.ts";
export { ensureSignalDaemon, type SignalDaemon, type DaemonOptions } from "./daemon.ts";
export { silentLogger, type Logger } from "./logger.ts";
