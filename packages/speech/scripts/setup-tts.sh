#!/bin/bash
# Installs local text to speech (Kokoro) for `synthesize`: a Python environment, the model and the voices.
# Everything goes into one folder (about 400 MB); nothing else is touched. Use that folder as `kokoro.dir`.
#   scripts/setup-tts.sh [DIR]        (default: $TTS_DIR, else ~/.cache/signal-kokoro)
# Needs Python 3.10+ (macOS ships 3.9: `brew install python@3.12`) and ffmpeg (`brew install ffmpeg`, or your package manager).
# The Kokoro model and voices are downloaded from the kokoro-onnx project; check their licence terms before commercial use.
set -euo pipefail
DIR="${1:-${TTS_DIR:-$HOME/.cache/signal-kokoro}}"
PY="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || true)"
[ -n "$PY" ] || { echo "Need Python 3.10 or newer (macOS: brew install python@3.12)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "Need ffmpeg (macOS: brew install ffmpeg)"; exit 1; }
mkdir -p "$DIR" && cd "$DIR"
[ -d venv ] || "$PY" -m venv venv
./venv/bin/pip install --quiet --upgrade pip
./venv/bin/pip install --quiet kokoro-onnx soundfile
BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f kokoro-v1.0.onnx ] || curl -fL -o kokoro-v1.0.onnx "$BASE/kokoro-v1.0.onnx"
[ -f voices-v1.0.bin ] || curl -fL -o voices-v1.0.bin "$BASE/voices-v1.0.bin"
echo "Done: $DIR. Pass it as kokoro.dir; ttsReady(dir) checks the setup."
