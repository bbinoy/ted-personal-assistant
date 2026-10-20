# Text to speech with Kokoro, run by tts.ts: the text arrives on stdin, a WAV file is written.
# usage: kokoro-say.py MODEL VOICES VOICE SPEED OUT.wav
import faulthandler
import sys
import soundfile as sf
from kokoro_onnx import Kokoro

# If it ever hangs, the parent's timeout kills it; this prints where it was stuck, into the parent's error message.
faulthandler.dump_traceback_later(60, exit=False)
model, voices, voice, speed, out = sys.argv[1:6]
text = sys.stdin.read().strip()
k = Kokoro(model, voices)
samples, rate = k.create(text, voice=voice, speed=float(speed), lang="en-gb" if voice.startswith("b") else "en-us")
sf.write(out, samples, rate)
