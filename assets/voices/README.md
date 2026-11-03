# Built-in sample voice

`default.wav` and `default.txt` are the reference voice Ted uses with `TTS_PROVIDER=qwen` when `TTS_REF_AUDIO` and `TTS_REF_TEXT` are both unset, so a fresh setup has a voice out of the box.

It is a **synthetic voice with no real person behind it**. It is not derived from any recording of a person, and not a clone of any person or character.

## Provenance

| | |
|---|---|
| Generated | 2026-10-17 |
| Model | Kokoro v1.0 (`kokoro-v1.0.onnx`, run with `kokoro-onnx`), a stock model used once to make this sample (Ted itself no longer ships Kokoro) |
| Voice | stock preset `am_onyx` (American English, male), speed 0.95 |
| Text | `default.txt`, written for this repo (original, not from any show, film or book) |
| Conversion | `ffmpeg -i raw.wav -ac 1 -ar 24000 -c:a pcm_s16le default.wav` |
| Format | mono, 24 kHz, 16-bit PCM WAV, about 10.7 s, about 500 KB |
| Check | transcribed back with whisper.cpp (`ggml-small`); the transcript matches `default.txt` word for word |

## Licence

Kokoro (model and voices) is released under the **Apache-2.0** licence, which allows using and redistributing the model and the audio it generates. The sample is shipped under the same terms as this repository.

A Qwen3-TTS VoiceDesign model (a voice made from a text description only) was considered and not used: it is a multi-gigabyte download that is not part of the setup.

## How it was generated

Once, with the stock Kokoro `am_onyx` voice (speed 0.95) reading `default.txt` into `raw.wav`, then `ffmpeg -i raw.wav -ac 1 -ar 24000 -c:a pcm_s16le assets/voices/default.wav`. The tool for this is no longer part of the repo.

## Replacing it

Point Ted at your own file instead; the sample is then ignored (set both):

```
TTS_REF_AUDIO=state/voice/ref.wav    # 5 to 20 s of clean speech, a voice you have the rights to
TTS_REF_TEXT=state/voice/ref.txt     # exactly what is said in it
```

To change the shipped sample itself, replace `default.wav` and `default.txt` together (they must match word for word), keep it mono, 24 kHz, 16-bit, about 10 s, and update this file. Only use a synthetic voice or one whose owner agreed: never a recording of a real person or a clone of a character. `npm run doctor` shows whether the built-in sample or your own file is in use.

## Example voice message

`docs/audio/voice-message.m4a` (used in the main README) is an original short message in the character's style, spoken by the same stock Kokoro `am_onyx` voice (speed 0.95), converted to AAC mono 24 kHz. It contains no recording of any real person.
