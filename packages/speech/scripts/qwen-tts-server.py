# A tiny local speech server around Qwen3-TTS (mlx-audio, Apple Silicon), started and stopped by tts-qwen.ts.
# It clones the voice of a reference recording you provide (never shipped with this repo) and keeps the model loaded.
# usage: qwen-tts-server.py MODEL REF_AUDIO     reference text: environment QWEN_TTS_REF_TEXT; request key: QWEN_TTS_NONCE
# Listens on 127.0.0.1 only, on a free port, and prints "READY <port>" when the model is loaded and warmed up.
# Exits when its parent goes away (stdin closes). POST /say {"text": ...} -> audio/wav; GET /health -> ok.
import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import soundfile as sf

model_id, ref_audio = sys.argv[1:3]
ref_text = os.environ.get("QWEN_TTS_REF_TEXT", "")
nonce = os.environ.get("QWEN_TTS_NONCE", "")
MAX_CHARS = 4000
voice_root = os.path.realpath(os.environ["QWEN_TTS_VOICE_ROOT"]) if os.environ.get("QWEN_TTS_VOICE_ROOT") else ""
VOICE_PATH = re.compile(r"^[a-z][a-z0-9_-]{0,63}/voices/[a-z0-9-]{1,32}$")  # <scope>/voices/<name> under the voice root (voices.ts)


def watch_parent():
    sys.stdin.buffer.read()  # blocks until the parent closes the pipe or dies
    os._exit(0)


threading.Thread(target=watch_parent, daemon=True).start()

from mlx_audio.tts.utils import load_model  # noqa: E402

t0 = time.time()
model = load_model(model_id)


def reference(voice):
    """The reference clip and its text: the default, or a voice of the library (a relative path of a fixed shape, inside the voice folder)."""
    if not voice:
        return ref_audio, ref_text
    if not voice_root or not VOICE_PATH.match(voice):
        raise ValueError("bad voice")
    d = os.path.realpath(os.path.join(voice_root, voice))
    if not d.startswith(voice_root + os.sep):
        raise ValueError("bad voice")
    with open(os.path.join(d, "ref.txt"), encoding="utf-8") as f:
        return os.path.join(d, "ref.wav"), f.read().strip()


def speak(text, voice=None):
    parts = []
    audio_path, audio_text = reference(voice)
    # the model caches the encoded reference per clip, so a voice costs its encoding once, on its first reply
    for r in model.generate(text=text, lang_code="english", ref_audio=audio_path, ref_text=audio_text):
        parts.append(np.array(r.audio))
    return np.concatenate(parts), model.sample_rate


speak("Ready.")  # warm-up: also caches the reference codes for this recording


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep the text spoken out of any log
        pass

    def _send(self, code, body, ctype="text/plain"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, b"ok") if self.path == "/health" else self._send(404, b"not found")

    def do_POST(self):
        if self.path != "/say":
            return self._send(404, b"not found")
        if nonce and self.headers.get("x-qwen-key") != nonce:
            return self._send(403, b"forbidden")
        try:
            n = int(self.headers.get("content-length", "0"))
            if n <= 0 or n > 64 * 1024:
                return self._send(400, b"bad length")
            body = json.loads(self.rfile.read(n))
            text = str(body["text"]).strip()
            voice = body.get("voice")
            if not text or len(text) > MAX_CHARS:
                return self._send(400, b"bad text")
            audio, rate = speak(text, voice)
            with tempfile.NamedTemporaryFile(suffix=".wav") as f:
                sf.write(f.name, audio, rate)
                body = open(f.name, "rb").read()
            self._send(200, body, "audio/wav")
        except Exception as e:  # noqa: BLE001
            self._send(500, f"{type(e).__name__}: {e}"[:200].encode())


srv = HTTPServer(("127.0.0.1", 0), Handler)  # one request at a time: the model is not thread-safe
print(f"READY {srv.server_address[1]} load={time.time() - t0:.1f}s", flush=True)
srv.serve_forever()
