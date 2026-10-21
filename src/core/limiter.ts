// At most `limit` jobs at once; the rest wait, lowest `priority` number first and in arrival order within one priority. Nothing is dropped: used for voice
// notes, where every one must still be transcribed (in a group it may be addressed to the assistant), but a flood must not start many whisper processes, and as
// the one gate of model runs (rungate.ts), where a waiting job can also be called off (`signal`) and an `urgent` one never waits at all.
interface Waiting {
  priority: number;
  go: () => void;
}

export interface LimiterRun {
  priority?: number; // lower goes first (default 0)
  urgent?: boolean; // takes a place at once, over the limit if it must (it still counts, so later arrivals wait for it): for work that must never queue
  signal?: AbortSignal; // called off while waiting: the job never starts and run() rejects
}

export class Limiter {
  #running = 0;
  readonly #waiting: Waiting[] = [];
  readonly #limit: () => number;

  constructor(limit: () => number) {
    this.#limit = limit;
  }

  get queued(): number {
    return this.#waiting.length;
  }

  get running(): number {
    return this.#running;
  }

  get full(): boolean {
    return this.#running >= this.#limit() || this.#waiting.length > 0;
  }

  async run<T>(job: () => Promise<T>, o: LimiterRun = {}): Promise<T> {
    if (o.signal?.aborted) throw o.signal.reason ?? new Error("aborted");
    if (o.urgent || this.#running < this.#limit()) this.#running++;
    else await this.#wait(o.priority ?? 0, o.signal); // the finisher hands its place over (already counted for us)
    try {
      return await job();
    } finally {
      this.#running--;
      this.#pump();
    }
  }

  // A job that holds a place gives it up while `wait` runs (a look parked on an approval for the owner, maybe for hours) and takes one again afterwards, over the limit if it
  // must (urgent: it was running already, and what it waits for has just come).
  async park<T>(wait: () => Promise<T>): Promise<T> {
    this.#running--;
    this.#pump();
    try {
      return await wait();
    } finally {
      this.#running++;
    }
  }

  #wait(priority: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const off = () => {
        const i = this.#waiting.indexOf(entry);
        if (i >= 0) this.#waiting.splice(i, 1);
        reject(signal!.reason ?? new Error("aborted"));
      };
      const entry: Waiting = { priority, go: () => (signal?.removeEventListener("abort", off), resolve()) };
      signal?.addEventListener("abort", off, { once: true });
      const at = this.#waiting.findIndex((w) => w.priority > priority); // behind everything of the same or a better priority
      this.#waiting.splice(at < 0 ? this.#waiting.length : at, 0, entry);
    });
  }

  // Places free: the next in line takes each one (counted for it before it wakes, so nobody slips in between).
  #pump(): void {
    while (this.#waiting.length && this.#running < this.#limit()) {
      this.#running++;
      this.#waiting.shift()!.go();
    }
  }
}
