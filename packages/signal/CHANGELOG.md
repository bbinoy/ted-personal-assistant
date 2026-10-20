# Changelog

0.x releases may change the API between minor versions.

## 0.2.0 (unreleased)

Added
- `SignalClient.sendFirst` and `Messenger.sendFirst`: a first message to a phone number or a Signal username, returning the recipient's account id when signal-cli reports it.
- `/messenger` entry point: the Signal client, daemon and attachments as an implementation of the `Messenger` interface (`createMessenger`, `doctor`, `toSignalStyles`). The incoming types (`IncomingMessage`, `Quote`, ...) and the attachment size limits now come from `@ted-assistant/messenger` and are re-exported unchanged. `@ted-assistant/messenger` is a published dependency (`^0.1.0`).
- Long messages: an attachment of type `text/x-signal-plain` (how Signal apps send the full text of a message over about 2000 characters) is delivered as `IncomingMessage.longText` (`LongTextRef`, `parseLongText`), never as `file`. `readLongText(ref, dir?)` reads it safely (plain file, no symlink, strict UTF-8 without NUL, at most `MAX_LONG_TEXT_BYTES` = 64 KB); `LONG_TEXT_TYPE`.
- `IncomingMessage.file` / `parseFile` / `FileRef` / `MAX_FILE_BYTES`: the first attachment that is neither a picture nor audio (a document or any other file), with its id, size and the sender's file name. A message with only such a file is now delivered.

- Audio files: an audio attachment that has a file name is delivered as `IncomingMessage.file` (with `FileRef.audio`), not as `audio`.

Breaking changes
- The speech libraries are gone from this package: `/voice` (speech to text) and `/tts` (text to speech, voices, reference clips), their scripts and the remote speech guide now live in the private workspace package `@ted-assistant/speech`. This package no longer needs ffmpeg, whisper.cpp or Kokoro. (It was never published.)
- The library no longer exits the process. `SignalClient` has `onClose(handler)` and `close()`; a socket error after connecting is reported through `onClose` instead of crashing. `ensureSignalDaemon` returns `{ started, stop(), exited }`, installs no process or signal handlers, and takes an options object.
- `new SignalClient({ host, port, account, peer?, logger?, rpcTimeoutMs?, ownReactionMs? })` replaces the positional constructor.
- `send(text, { style?, quote?, attachments?, groupId? })` replaces `send(text, textStyle, quote, opts)`.
- `IncomingMessage.voice` is gone (it was set by the application, not by the package).
- `ensureSignalDaemon` refuses a host other than loopback unless `allowNonLoopback` is set.
- Entry points: the root exports the core only. Test helpers are `/testing`. `sniffAudio` and `ELEVENLABS_BASE` are no longer exported.
- The package is built: `exports` point at `dist/` (with declarations). Inside the monorepo the `workspace-source` condition resolves the TypeScript source.
- Nothing is logged by default; pass `logger` to see messages.

Added
- Edited messages: `IncomingMessage.edited?: { targetTimestamp }` (from signal-cli's `editMessage`, also the sync of your own edit in Note to Self). Messages deleted for everyone: `SignalClient.onDelete(handler)` with `IncomingDeletion`. Before, `interpretEnvelope` dropped both.
- `attachmentPath(ref, dir?)`, `defaultAttachmentsDir()`.
- `@ted-assistant/signal/testing`: `FakeSignalDaemon`, `FakeRpcError`.
- Clear error when a request is made before `connect()` or after the connection closed.
- Documentation: install, signal-cli prerequisites, security notes, third-party licences, JSDoc on the public API, examples and an account guide.

Fixed
- `markRead` sent `sendReceipt`'s `recipient` as a list; signal-cli wants a single string, so read receipts failed for peers known only by account id.
- `ensureSignalDaemon` failed only after 30 s if signal-cli exited at once; it now reports that immediately.
