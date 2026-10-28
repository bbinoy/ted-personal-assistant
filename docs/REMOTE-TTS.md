# Remote speech (optional)

By default Ted speaks with the local Qwen3-TTS voice on your Mac (Kokoro stands in until `npm run setup:tts-qwen` has been run) and nothing leaves it. If you want a different voice, `TTS_PROVIDER` can send the words Ted is about to speak to a remote service instead. Everything after that is unchanged: ffmpeg turns the audio into AAC and Signal shows a voice message.

**Read this first.** With a remote provider, the text of each spoken reply (and nothing else: no mail, no notes, no history) is sent over HTTPS to a third party (`elevenlabs`) or to a server you run (`http`). Only use a cloned voice you have the rights and consent for: your own, or one whose owner agreed. This repo contains no cloned voice, no recording of a person and no celebrity voice, and will not; its only voice sample is a synthetic one (`assets/voices/`). The reference recording of a clone stays on the remote side and is only named by an id.

| Setting | |
|---|---|
| `TTS_PROVIDER` | `qwen` (default; local cloned voice, below), `kokoro`, `elevenlabs` or `http` |

Keys and tokens live in `.env` only, are sent only in a request header, and are blanked out of any error message. A wrong setting stops the agent at start-up. `npm run doctor` shows which provider is chosen.

## ElevenLabs

```
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...        # from your ElevenLabs account
ELEVENLABS_VOICE_ID=...       # a stock voice, or a clone you made there with a voice you have the rights to
# ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Ted calls `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` with `{text, model_id}` and takes the MP3 it returns. Usage is billed by ElevenLabs by character; a 401, quota or rate-limit answer is a failure like any other (the words are sent as text).

## Your own server (`http`)

```
TTS_PROVIDER=http
TTS_HTTP_URL=https://tts.example.com/say    # https; http:// only for localhost
TTS_HTTP_TOKEN=...                           # optional bearer token
# TTS_HTTP_VOICE=...                         # optional, passed as "voice"
# TTS_HTTP_REFERENCE_ID=...                  # optional, passed as "reference_id"
```

The contract, so you can implement it on any server (a serverless GPU running F5-TTS or Chatterbox, say):

```
POST {TTS_HTTP_URL}
Content-Type: application/json
Authorization: Bearer {TTS_HTTP_TOKEN}      (only if a token is set)

{"text": "the words to speak", "voice": "optional", "reference_id": "optional"}
```

- `text`: plain text, at most about 3,500 characters.
- `voice`: a voice name your server understands. `reference_id`: the id, on your server, of the reference recording for a cloned voice. The recording itself never travels and is never in this repo. Both are left out when unset.
- Success: status 200 and the audio as the body, WAV, MP3 or OGG, up to 25 MB. The format is read from the `Content-Type` (`audio/wav`, `audio/mpeg`, `audio/ogg`), or from the first bytes if that is missing or generic.
- Anything else (any other status, an empty or non-audio body, no answer within the timeout, a redirect) is a failure. Use 401/403 for a bad token and 429 for quota; they are named in the log.
- Redirects are not followed, so the token cannot be sent to another host.

### Try the plumbing locally

`examples/remote-tts-sample-server.ts` is a sample that follows the contract and answers with a sine-wave beep, not speech:

```
TTS_SAMPLE_TOKEN=some-long-random-string node examples/remote-tts-sample-server.ts
# .env: TTS_PROVIDER=http  TTS_HTTP_URL=http://localhost:8787/tts  TTS_HTTP_TOKEN=some-long-random-string
```

Restart the agent, then ask Ted for a voice answer: you should receive a beep as a voice message. Replace `render` with a real model on a server you control.

## Local cloned voice (`qwen`)

Nothing leaves the Mac. Ted speaks in the voice of a reference recording. Without settings it uses the **built-in sample voice** (`assets/voices/default.wav`): a synthetic voice with no real person behind it, made with the stock Kokoro voice `am_onyx` (Apache-2.0; see `assets/voices/README.md`). For a voice of your own, provide a recording (your own voice, or one whose owner agreed; this repo ships no recording of anyone) with Qwen3-TTS running locally through mlx-audio. Apple Silicon only. English only: keep `TTS_LANGUAGES=en`, other languages still go out as text.

```
npm run setup:tts-qwen        # venv + mlx-audio + model into state/tts-qwen/ (about 2.5 GB; never run by npm install or CI)
```
```
# .env
TTS_PROVIDER=qwen
# Optional: both unset = the built-in sample voice. Set both to use your own recording instead.
TTS_REF_AUDIO=state/voice/ref.wav     # 5 to 20 s of clean speech; a path (relative to the harness folder, or absolute)
TTS_REF_TEXT=state/voice/ref.txt      # exactly what is said in it: the words, or the path of a text file
# TTS_QWEN_MODEL=mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit   # or ...-1.7B-Base-8bit: better, slower, more memory
```
Keep your own reference under `state/` (git-ignored) or elsewhere outside the repo. To change the voice, point these two settings at another recording and restart Ted. Setting only one of the two counts as your own reference (the sample is never mixed in), so set both. `npm run doctor` says whether the "built-in sample voice" or your own file is in use.

How it runs: the model takes about 4 s to load and 3 to 4 GB of memory, so Ted starts one small server (`packages/speech/scripts/qwen-tts-server.py`) at start-up and keeps it loaded, like the warm Claude processes. It listens on 127.0.0.1 on a free port and wants a random key made at each start. It is stopped after 60 minutes (`WARM_IDLE_MINUTES` in `src/core/settings.ts`) without a spoken reply, which frees the memory; the next reply starts it again (a few seconds slower). `WARM=off` skips the start-up launch (it then starts on the first spoken reply). Owner chat and groups use the same code path.

If the server is not set up, not ready, fails or exceeds 60 seconds, Ted logs it and speaks the same words with Kokoro when that is installed (a remote provider never switches: a failed request is sent as text). `TTS_SPEED` does not apply to this voice. `npm run doctor` shows whether the voice is ready. Use Kokoro alone with `TTS_PROVIDER=kokoro`.

Back to the [README](../README.md) · [Safety](SAFETY.md) · [Setup](SETUP.md)

## Languages

The default Kokoro voice (`am_onyx`) speaks English only; read with it, German or French sounds wrong. `TTS_LANGUAGES` (default `en`) lists the languages your voice speaks. The assistant is told to use voice only for those, and as a safety net the code checks the language of every reply it was about to speak (a script check for non-Latin text, otherwise one small Haiku call for text of 40 letters or more); a reply in another language is sent as text and the skip is logged. When the check itself fails or times out (the model is down), the voice is not given up: the reply is assumed to be in the conversation's last language, or in the first language of `TTS_LANGUAGES`, and the line `voice: the language of the reply could not be told, speaking it as en` is logged (if the last language was one the voice does not speak, the reply is sent as text). With a multilingual voice (for example ElevenLabs `eleven_multilingual_v2`, or your own server), set e.g. `TTS_LANGUAGES=en,de,fr`. Short text (under 40 letters) is never held back.
