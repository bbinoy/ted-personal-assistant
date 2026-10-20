// Answers a voice message with a voice message: whisper.cpp hears it, Kokoro speaks the answer. Both run on this machine.
//   SIGNAL_ACCOUNT=+10000000001 SIGNAL_OWNER=+10000000000 WHISPER_MODEL=~/models/ggml-base.bin KOKORO_DIR=~/kokoro \
//     node examples/voice-reply.ts
// Needs ffmpeg, whisper-cli and a ggml model, and Kokoro (scripts/setup-tts.sh installs it). Own-account mode: in Note to Self
// the bot's own voice message would echo back as if you had sent it.
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SignalClient, attachmentPath } from "@ted-assistant/signal";
import { providerReady, synthesizeWith } from "@ted-assistant/speech/tts";
import { transcribe, voiceReady } from "@ted-assistant/speech/voice";

const { SIGNAL_ACCOUNT: account, SIGNAL_OWNER: owner, WHISPER_MODEL: model, KOKORO_DIR: kokoroDir } = process.env;
if (!account || !owner || !model || !kokoroDir) throw new Error("set SIGNAL_ACCOUNT, SIGNAL_OWNER, WHISPER_MODEL and KOKORO_DIR");

const tts = { provider: "kokoro", fallback: "none", kokoro: { dir: kokoroDir, voice: "am_onyx", speed: 1 } } as const;
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
