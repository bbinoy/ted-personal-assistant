import { VoiceAbort } from "@ted-assistant/speech/tts";

// ONE overall deadline for a piece of work that must not outlive its moment (a voice reply: every engine, the conversion and the upload together).
// It is checked on a short interval, and `check()` does the same on demand, so a result that arrives late is never used. The reason of the abort is a
// VoiceAbort of kind "timeout".

const POLL_MS = 1000;

export interface Deadline {
  readonly signal: AbortSignal;
  /** Throws the abort reason if the deadline has passed. */
  check(): void;
  /** Time left in ms (0 when over). */
  remainingMs(): number;
  /** `p`, or the abort reason as soon as the deadline is over. `p` is not cancelled: whoever started it owns that (a signal passed to it). */
  guard<T>(p: Promise<T>): Promise<T>;
  /** Ends the watch (always, when the work is done). */
  stop(): void;
}

export interface DeadlineEnv {
  now?: () => number;
  setInterval?: (f: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export function startDeadline(ms: number, env: DeadlineEnv = {}): Deadline {
  const now = env.now ?? Date.now;
  const t0 = now();
  const ctl = new AbortController();
  const evaluate = (): void => {
    if (!ctl.signal.aborted && now() - t0 >= ms) ctl.abort(new VoiceAbort("timeout"));
  };
  const handle = (env.setInterval ?? ((f, t) => setInterval(f, t).unref()))(evaluate, POLL_MS);
  const stop = (): void => (env.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(handle);
  ctl.signal.addEventListener("abort", stop, { once: true });
  return {
    signal: ctl.signal,
    check: () => {
      evaluate();
      if (ctl.signal.aborted) throw ctl.signal.reason;
    },
    remainingMs: () => Math.max(0, ms - (now() - t0)),
    guard: (p) => {
      p.catch(() => {}); // (its failure after we gave up is nobody's news)
      return new Promise((resolve, reject) => {
        if (ctl.signal.aborted) return reject(ctl.signal.reason);
        const onAbort = () => reject(ctl.signal.reason);
        ctl.signal.addEventListener("abort", onAbort, { once: true });
        p.then(resolve, reject).finally(() => ctl.signal.removeEventListener("abort", onAbort));
      });
    },
    stop,
  };
}
