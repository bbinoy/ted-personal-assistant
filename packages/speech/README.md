# @ted-assistant/speech

The speech libraries of the Ted personal assistant: text to speech and speech to text. They know nothing about any messenger, so they work with Signal or any other messenger package. Private to this repository for now (not published).

## What is in it

| Entry | What it gives you |
|---|---|
| `@ted-assistant/speech/tts` | `synthesizeWith`: text to an audio file. Engines: Qwen3-TTS (a local cloned voice), Kokoro (local, the fallback), ElevenLabs or your own HTTP server (remote, opt-in). The messenger's voice format (`m4a` or `ogg-opus`) is passed in. |
| `@ted-assistant/speech/voice` | Voice library and cloning helpers: voice notes and audio files become reference clips, `voices`, `voiceclip`. Also speech to text with local whisper.cpp (`transcribe`). |

Source layout: `src/` (engines `tts-*.ts`, `voices.ts`, `voiceclip.ts`, `transcribe.ts`, `audiofile.ts`, `voiceformat.ts`), `scripts/` (`kokoro-say.py`, `qwen-tts-server.py`, `setup-tts.sh`), `docs/remote-tts.md` (using a remote engine, and what it sends where), `examples/remote-tts-server.ts`, `test/`.

## Using it

The application imports it by name (`@ted-assistant/speech/tts`, `@ted-assistant/speech/voice`); there is no build step, the package is source-only like the skeleton packages (`workspace-source` condition). Setup of the local engines is described in the repository's `docs/SETUP.md` ("Voice") and started by `npm run setup:tts-qwen` / `scripts/setup-tts.sh`.

## Privacy

Everything runs on your machine by default and nothing leaves it. A remote engine sends the text of each spoken reply (and nothing else) to that service: read `docs/remote-tts.md` first.

## Tests

`npm test` at the repository root runs this package's tests with the rest (`packages/speech/test/`). The package depends only on `@ted-assistant/messenger` (for the `VoiceFormat` type) and imports nothing from the application.
