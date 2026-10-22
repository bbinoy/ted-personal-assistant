import { VoiceAbort } from "@ted-assistant/speech/tts";
import { sleepSignal } from "./sleep.ts";

// ONE overall deadline for a piece of work that must not outlive its moment (a voice reply: every engine, the conversion and the upload together).
// Its clock cannot be fooled by a sleeping Mac: a plain timer would count on from where the monotonic clock stood still, so a deadline of 75 s set
// before a lid was closed would fire minutes after the wake-up. So it is checked on a short interval against BOTH the Date clock and a monotonic one
// (on macOS the monotonic clock stands still while the Mac sleeps), and whenever the two disagree by more than a few seconds the Mac slept and the work is
// given up at once. `check()` does the same on demand, so a result that arrives late (the work finishing in the very moment of the wake-up) is never used.
// The heartbeat's sleep signal (core/sleep.ts) aborts it too, should the tick notice the sleep first.
//
// The reason of the abort is a VoiceAbort: kind "timeout" or "slept".

const POLL_MS = 1000;
const DRIFT_MS = 5000; // the two clocks may differ this much (timer jitter) before it counts as a sleep

export interface Deadline {
  readonly signal: AbortSignal;
  /** Throws the abort reason if the deadline has passed or the Mac slept; the clocks are looked at right now. */
  check(): void;
  /** Time left in ms (0 when over): the larger of the two clocks' elapsed times counts. */
  remainingMs(): number;
  /** `p`, or the abort reason as soon as the deadline is over. `p` is not cancelled: whoever started it owns that (a signal passed to it). */
  guard<T>(p: Promise<T>): Promise<T>;
  /** Ends the watch (always, when the work is done). */
  stop(): void;
}

export interface DeadlineEnv {
  now?: () => number; // the Date clock
  mono?: () => number; // a monotonic clock
  parent?: AbortSignal; // default: the shared "the Mac slept" signal (sleep.ts)
  setInterval?: (f: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export function startDeadline(ms: number, env: DeadlineEnv = {}): Deadline {
  const now = env.now ?? Date.now;
  const mono = env.mono ?? (() => performance.now());
  const parent = env.parent ?? sleepSignal();
  const wall0 = now();
  const mono0 = mono();
  const ctl = new AbortController();
  const abort = (kind: "timeout" | "slept") => void (ctl.signal.aborted || ctl.abort(new VoiceAbort(kind)));

  const evaluate = (): void => {
    if (ctl.signal.aborted) return;
    if (parent.aborted) return abort("slept");
    const wall = now() - wall0;
    const mon = mono() - mono0;
    if (wall - mon > DRIFT_MS) return abort("slept");
    if (Math.max(wall, mon) >= ms) abort("timeout");
  };
  const onParent = () => abort("slept");
  parent.addEventListener("abort", onParent, { once: true });
  const handle = (env.setInterval ?? ((f, t) => setInterval(f, t).unref()))(evaluate, POLL_MS);
  const stop = (): void => {
    (env.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(handle);
    parent.removeEventListener("abort", onParent);
  };
  ctl.signal.addEventListener("abort", stop, { once: true });
  evaluate();

  return {
    signal: ctl.signal,
    check: () => {
      evaluate();
      if (ctl.signal.aborted) throw ctl.signal.reason;
    },
    remainingMs: () => Math.max(0, ms - Math.max(now() - wall0, mono() - mono0)),
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
