# Remote speech (optional)

By default `synthesizeWith` speaks with Kokoro on your machine and nothing leaves it. With a remote provider the words to be spoken are sent to another service instead. Everything after that is unchanged: ffmpeg turns the audio into a voice message.

**Read this first.** With a remote provider, the text of each spoken reply (and nothing else) is sent over HTTPS to a third party (`elevenlabs`) or to a server you run (`http`). Only use a cloned voice you have the rights and consent for: your own, or one whose owner agreed. This package contains no cloned voice and no recording. The reference recording of a clone stays on the remote side and is only named by an id.

```ts
import { synthesizeWith, providerReady, type TtsProviderConfig } from "@ted-assistant/speech/tts";

const cfg: TtsProviderConfig = {
  provider: "http", // or "elevenlabs", or "kokoro" (the default engine)
  fallback: "none", // "kokoro": a failed remote request is spoken locally instead; never switches unless you ask
  kokoro: { dir: "/path/to/kokoro", voice: "am_onyx", speed: 1 }, // always required: it is the local engine and the fallback
  http: { url: "https://tts.example.com/say", token: process.env.TTS_TOKEN, timeoutMs: 60_000 },
};
if (!providerReady(cfg).ok) throw new Error("ffmpeg is missing");
const file = await synthesizeWith("Hello there", cfg, console); // an .m4a in a fresh temp folder: delete that folder after sending
```

Keys and tokens are sent only in a request header and are blanked out of any error message. Redirects are refused, so a token cannot be sent to another host. The answer is capped at 25 MiB and its format is checked by content type and by its first bytes. `http://` is accepted only for localhost (`isSafeUrl`).

## ElevenLabs

```ts
{ provider: "elevenlabs", fallback: "none", kokoro, elevenlabs: { apiKey, voiceId, modelId: "eleven_multilingual_v2", timeoutMs: 60_000 } }
```

Calls `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}` with `{text, model_id}` and takes the MP3 it returns. Usage is billed by ElevenLabs by character; a 401, quota or rate-limit answer is a failure like any other. Their terms apply, and a voice clone needs the rights to the voice.

## Your own server (`http`)

The contract, so you can implement it on any server (a serverless GPU running F5-TTS or Chatterbox, say):

```
POST {url}
Content-Type: application/json
Authorization: Bearer {token}      (only if a token is set)

{"text": "the words to speak", "voice": "optional", "reference_id": "optional"}
```

- `text`: plain text, at most about 3,500 characters (`MAX_SPOKEN_CHARS`).
- `voice`: a voice name your server understands. `reference_id`: the id, on your server, of the reference recording for a cloned voice. Both are left out when unset.
- Success: status 200 and the audio as the body, WAV, MP3 or OGG, up to 25 MB. The format is read from the `Content-Type` (`audio/wav`, `audio/mpeg`, `audio/ogg`), or from the first bytes if that is missing or generic.
- Anything else (any other status, an empty or non-audio body, no answer within the timeout, a redirect) is a failure. Use 401/403 for a bad token and 429 for quota; they are named in the error.

`examples/remote-tts-server.ts` (in the repository) is a sample that follows the contract and answers with a sine-wave beep, not speech: run it, point `http.url` at `http://localhost:8787/tts` and you should receive a beep as a voice message.
