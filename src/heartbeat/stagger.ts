// Starts the looks of different conversations staggered: at most `concurrency` at the same time and `gapMs` between two starts. A Mac that wakes from sleep (or a restart)
// finds every conversation due at once; a dozen model runs in the same second saturate the network and the CPU of the machine that has just woken, and most of them hang.
// A slot is held while the job runs; the order is first come, first served. `sleep` and `now` are for tests (fake clocks).

export interface StaggerOptions {
  concurrency: number;
  gapMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createStagger(o: StaggerOptions) {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let active = 0;
  let nextStart = 0;
  const waiting: (() => void)[] = [];

  async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active < o.concurrency) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // the slot is handed over by release()
    try {
      const t = now();
      const at = Math.max(t, nextStart);
      nextStart = at + o.gapMs; // reserved before sleeping: the next one is a gap behind this one
      if (at > t) await sleep(at - t);
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  return { run };
}
