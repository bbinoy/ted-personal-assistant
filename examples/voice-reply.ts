// Answers a voice message with a voice message: whisper.cpp hears it, the local Qwen3-TTS voice speaks the answer. Both run on this machine.
//   SIGNAL_ACCOUNT=+10000000001 SIGNAL_OWNER=+10000000000 WHISPER_MODEL=~/models/ggml-base.bin QWEN_DIR=~/qwen REF_AUDIO=~/ref.wav REF_TEXT='What is said in ref.wav' \
//     node examples/voice-reply.ts
// Needs ffmpeg, whisper-cli and a ggml model, and the Qwen voice (npm run setup:tts-qwen installs it). Own-account mode: in Note to Self
// the bot's own voice message would echo back as if you had sent it.
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SignalClient, attachmentPath } from "@ted-assistant/signal";
import { providerReady, synthesizeWith } from "@ted-assistant/speech/tts";
import { transcribe, voiceReady } from "@ted-assistant/speech/voice";

const { SIGNAL_ACCOUNT: account, SIGNAL_OWNER: owner, WHISPER_MODEL: model, QWEN_DIR: qwenDir, REF_AUDIO: refAudio, REF_TEXT: refText } = process.env;
if (!account || !owner || !model || !qwenDir || !refAudio || !refText) throw new Error("set SIGNAL_ACCOUNT, SIGNAL_OWNER, WHISPER_MODEL, QWEN_DIR, REF_AUDIO and REF_TEXT");

const tts = { provider: "qwen", qwen: { dir: qwenDir, model: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit", refAudio, refText, idleMs: 60_000 } } as const;
for (const gap of [voiceReady(model), providerReady(tts)]) if (!gap.ok) throw new Error(`missing: ${gap.missing.join(", ")}`);

// signal-cli's daemon must already be running (see ensureSignalDaemon in echo.ts).
const signal = new SignalClient({ host: "127.0.0.1", port: 7583, account, peer: { number: owner }, logger: console });
signal.onClose(() => process.exit(1));

signal.onMessage(async (m) => {
  if (!m.direct || m.from !== owner || !m.audio) return;
  const heard = await transcribe(attachmentPath(m.audio), model);
  const file = await synthesizeWith(`You said: ${heard}`, tts, console);
  try {
    await signal.send("", { attachments: [file] }); // an audio attachment shows as a voice message
  } finally {
    await rm(dirname(file), { recursive: true, force: true }); // the caller deletes the temp folder
  }
});

await signal.connect();
console.log("voice reply bot is running");
