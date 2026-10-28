import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onPath, toolEnv } from "./internal/exec.ts";
import { synthesizeRemote, type Fetch } from "./tts-remote.ts";
import type { VoiceFormat } from "./voiceformat.ts";
import { activeVoiceRel, OWNER_SCOPE } from "./voices.ts";

// Local cloned voice: Qwen3-TTS (Apple Silicon, mlx-audio) in its own Python environment (`npm run setup:tts-qwen`).
// The model needs about 4 s to load and 3 to 4 GB of memory, so one small server (scripts/qwen-tts-server.py) is started
// on first use (or at start-up, see warmQwen) and kept loaded; it is stopped after `idleMs` without a request.
// It listens on 127.0.0.1 only, on a port it picks itself, and wants a random key (made per start) in a header, so
// no other program or web page can use it. The reference recording is yours, lives outside the repo, and never leaves the Mac.
// The audio goes through the same bounded request and ffmpeg step as the remote engines (tts-remote.ts).

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../scripts/qwen-tts-server.py");
const START_TIMEOUT_MS = 120_000; // load + warm-up; a first start after install is slower than the usual 5 s

export interface QwenConfig {
  dir: string; // holds venv/ (from setup-tts-qwen.sh)
  model: string; // Hugging Face repo of a Qwen3-TTS Base model
  refAudio: string; // path of the reference recording (a few seconds to ~20 s of clean speech)
  refText: string; // what is said in it
  builtIn?: boolean; // the reference is the synthetic sample that ships in assets/voices/ (TTS_REF_AUDIO and TTS_REF_TEXT unset)
  voiceRoot?: string; // the voice library (voices.ts): each scope (conversation) can have its own cloned voice there, <voiceRoot>/<scope>/voices/; the reference above is the default one
  timeoutMs: number; // per reply, including a cold start
  idleMs: number; // the server is stopped after this long without a request (0: kept until Ted stops)
  startTimeoutMs?: number;
  command?: string[]; // tests: replaces `venv/bin/python script model refAudio`
  fetchImpl?: Fetch;
}

const KILL_AFTER_MS = 3000; // SIGTERM first, SIGKILL if the server is still there after this

// The server and anything it started (it runs in its own process group).
function killGroup(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, sig);
  } catch {
    child.kill(sig);
  }
}

const python = (dir: string) => join(dir, "venv/bin/python");
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** What is missing for the cloned voice: the Python environment, the reference recording and its text, ffmpeg. */
export function qwenReady(c: Pick<QwenConfig, "dir" | "refAudio" | "refText">): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!existsSync(python(c.dir))) missing.push("Qwen Python environment (npm run setup:tts-qwen)");
  if (!c.refAudio || !isFile(c.refAudio)) missing.push("TTS_REF_AUDIO file");
  if (!c.refText.trim()) missing.push("TTS_REF_TEXT");
  if (!onPath("ffmpeg")) missing.push("ffmpeg");
  return { ok: missing.length === 0, missing };
}

// `p`, or the signal's reason as soon as it aborts. `p` itself is left to finish (its failure is the owner's to handle).
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

class QwenServer {
  #child?: ChildProcessWithoutNullStreams;
  #up?: Promise<{ port: number; key: string }>;
  #idle?: NodeJS.Timeout;
  #busy = 0; // requests waiting or running, so the idle stop does not fire between queued ones
  #tail: Promise<void> = Promise.resolve(); // settles when the last queued request is done
  readonly c: QwenConfig;
  constructor(c: QwenConfig) {
    this.c = c;
  }

  ensure(): Promise<{ port: number; key: string }> {
    this.#up ??= this.#start().catch((e) => {
      this.stop();
      throw e;
    });
    return this.#up;
  }

  #start(): Promise<{ port: number; key: string }> {
    const key = randomBytes(24).toString("hex");
    const [cmd, ...args] = this.c.command ?? [python(this.c.dir), SCRIPT, this.c.model, this.c.refAudio];
    const child = spawn(cmd!, args, { env: { ...toolEnv(), QWEN_TTS_REF_TEXT: this.c.refText, QWEN_TTS_VOICE_ROOT: this.c.voiceRoot ?? "", QWEN_TTS_NONCE: key, PYTHONUNBUFFERED: "1" }, detached: true, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.#child = child;
    return new Promise((resolve, reject) => {
      let out = "";
      let err = "";
      const fail = (why: string) => reject(new Error(`Qwen voice server ${why}${err.trim() ? `: ${err.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}` : ""}`));
      const timer = setTimeout(() => (killGroup(child, "SIGKILL"), fail(`did not start within ${Math.round((this.c.startTimeoutMs ?? START_TIMEOUT_MS) / 1000)} s`)), this.c.startTimeoutMs ?? START_TIMEOUT_MS);
      child.stderr.on("data", (d: Buffer) => (err = (err + d).slice(-2000)));
      child.stdout.on("data", (d: Buffer) => {
        out += d;
        const m = /^READY (\d+)/m.exec(out);
        if (m) (clearTimeout(timer), resolve({ port: Number(m[1]), key }));
      });
      child.on("error", (e) => (clearTimeout(timer), fail(`could not start (${e.message})`)));
      child.on("exit", (code, sig) => {
        clearTimeout(timer);
        if (this.#child === child) (this.#child = undefined, this.#up = undefined); // died while idle: the next request starts a new one
        fail(`exited (code ${code ?? "?"}, signal ${sig ?? "none"})`);
      });
    });
  }

  /** Stops the server (and so frees its memory). The next request starts a new one. */
  stop(): void {
    clearTimeout(this.#idle);
    const child = this.#child;
    this.#child = undefined;
    this.#up = undefined;
    if (child && child.exitCode === null) {
      child.stdin.end();
      killGroup(child, "SIGTERM");
      // A server deep in a generation may not answer SIGTERM at once: it must not run on, holding 3 to 4 GB.
      const hard = setTimeout(() => child.exitCode === null && child.signalCode === null && killGroup(child, "SIGKILL"), KILL_AFTER_MS);
      hard.unref();
      child.once("exit", () => clearTimeout(hard));
    }
  }

  #touch(): void {
    clearTimeout(this.#idle);
    if (this.c.idleMs > 0 && this.#busy === 0) {
      this.#idle = setTimeout(() => this.stop(), this.c.idleMs);
      this.#idle.unref();
    }
  }

  async warm(): Promise<void> {
    await this.ensure();
    this.#touch();
  }

  // The server speaks one text at a time, so replies queue here: a reply's timeout runs from its turn, not while it waits behind another.
  async say(text: string, scope: string = OWNER_SCOPE, format?: VoiceFormat, signal?: AbortSignal): Promise<string> {
    this.#busy++;
    clearTimeout(this.#idle);
    const prev = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((r) => (release = r));
    try {
      await (signal ? raceAbort(prev, signal) : prev); // giving up while waiting leaves the server and the running reply alone
      return await this.#speak(text, scope, format, signal);
    } finally {
      void prev.then(release); // an aborted waiter still hands over only after the one before it, so the order holds
      this.#busy--;
      this.#touch();
    }
  }

  async #speak(text: string, scope: string, format?: VoiceFormat, signal?: AbortSignal): Promise<string> {
    const started = Date.now();
    let up = false;
    try {
      const { port, key } = await (signal ? raceAbort(this.ensure(), signal) : this.ensure()); // a cold start is not waited for past the caller's deadline (it goes on, for the next reply)
      up = true;
      const voice = this.c.voiceRoot ? activeVoiceRel(this.c.voiceRoot, scope) : undefined; // read per reply: a switch needs no restart
      const left = Math.max(1000, this.c.timeoutMs - (Date.now() - started));
      return await synthesizeRemote(
        { url: `http://127.0.0.1:${port}/say`, headers: { "x-qwen-key": key }, body: voice ? { text, voice } : { text }, secrets: [key], timeoutMs: left, fetchImpl: this.c.fetchImpl, format, signal },
        "Qwen voice server",
      );
    } catch (e) {
      // A server that timed out or was given up on may still be busy with the old text, and one that died is gone: start fresh next time.
      // (Not while it is still starting: that start is kept for the next reply.)
      if (!(signal?.aborted && !up)) this.stop();
      throw e;
    }
  }
}

const servers = new Map<string, QwenServer>();
const serverFor = (c: QwenConfig): QwenServer => {
  const id = JSON.stringify([c.dir, c.model, c.refAudio, c.refText, c.voiceRoot, c.command]);
  let s = servers.get(id);
  if (!s) servers.set(id, (s = new QwenServer(c)));
  return s;
};

/** Speaks `text` in the cloned voice (the active one of the conversation `scope`: "owner" or a group id) and returns the path of a voice message (an .m4a unless `format` says otherwise) in a fresh temp folder (the caller deletes it). Starts the server if needed. */
export const synthesizeQwen = (text: string, c: QwenConfig, scope: string = OWNER_SCOPE, format?: VoiceFormat, signal?: AbortSignal): Promise<string> => serverFor(c).say(text, scope, format, signal);

/** Starts the server ahead of the first reply (at start-up). Never throws: a failure is returned for the log, and the first reply tries again. */
export async function warmQwen(c: QwenConfig): Promise<string | undefined> {
  const s = serverFor(c);
  try {
    await s.warm();
    return undefined;
  } catch (e) {
    s.stop();
    return (e as Error).message;
  }
}

/** Stops every Qwen server (shutdown, tests). */
export function stopQwen(): void {
  for (const s of servers.values()) s.stop();
  servers.clear();
}
