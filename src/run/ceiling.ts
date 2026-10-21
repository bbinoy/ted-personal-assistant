// A wall-clock ceiling for one model run. Nothing else bounds a turn in time (turns and budget count work, not hours), so a
// hung process or a stuck tool would block its conversation's queue until a restart. The run is abandoned at the ceiling: the
// caller's promise rejects at once (the conversation's queue moves on) and the abort signal tells the query to stop.
// Time spent waiting for the owner can be paused (pause), so a background approval wait is not counted against the run.

export class RunTimeout extends Error {
  readonly minutes: number;
  constructor(maxMs: number) {
    const minutes = Math.round((maxMs / 60_000) * 10_000) / 10_000;
    super(`run timed out after ${minutes} minutes`);
    this.minutes = minutes;
  }
}

// The owner stopped the run ("/stop", conversation/ownercommands.ts): not a failure, so nobody is told "something broke".
export class RunStopped extends Error {
  constructor() {
    super("run stopped by the owner");
  }
}

// The runs in flight by scope (a conversation's session file): what "/stop" aborts. Only runs that name a scope are listed.
const live = new Map<string, Set<(e: Error) => void>>();
// Abort every run of this scope: the query's abort signal fires and the caller's promise rejects at once with RunStopped. Returns how many were running.
export function stopRuns(scope: string): number {
  const stops = [...(live.get(scope) ?? [])];
  for (const stop of stops) stop(new RunStopped());
  return stops.length;
}

export interface Ceiling {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  pause(): () => void; // stops the clock until the returned function is called (nestable)
}

export async function withCeiling<T>(maxMs: number, run: (c: Ceiling) => Promise<T>, scope?: string): Promise<T> {
  const controller = new AbortController();
  let left = maxMs;
  let paused = 0;
  let finished = false;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fire!: (e: Error) => void;
  const timedOut = new Promise<never>((_, reject) => (fire = reject));
  timedOut.catch(() => {}); // rejected only if the timer fires; never an unhandled rejection when the run ends first
  const arm = () => {
    startedAt = Date.now();
    timer = setTimeout(() => {
      controller.abort();
      fire(new RunTimeout(maxMs));
    }, Math.max(1, left));
    timer.unref();
  };
  const pause = () => {
    if (paused++ === 0) (clearTimeout(timer), (left -= Date.now() - startedAt));
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (--paused === 0 && !finished && !controller.signal.aborted) arm();
    };
  };
  arm();
  const stop = (e: Error) => {
    controller.abort();
    fire(e);
  };
  if (scope) (live.get(scope) ?? live.set(scope, new Set()).get(scope)!).add(stop);
  const running = run({ controller, signal: controller.signal, pause });
  running.catch(() => {}); // after a timeout the abandoned run may still fail; that is not news
  try {
    return await Promise.race([running, timedOut]);
  } finally {
    finished = true;
    clearTimeout(timer);
    if (scope) live.get(scope)?.delete(stop);
  }
}

// `fn` with the clock paused while it runs (an approval waiting for the owner).
export const pausing = <A extends unknown[], R>(c: Ceiling, fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  const resume = c.pause();
  try {
    return await fn(...a);
  } finally {
    resume();
  }
};
