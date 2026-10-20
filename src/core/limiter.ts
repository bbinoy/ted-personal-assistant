// At most `limit` jobs at once; the rest wait in arrival order. Nothing is dropped: used for voice notes, where every one must
// still be transcribed (in a group it may be addressed to the assistant), but a flood must not start many whisper processes.
export class Limiter {
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #limit: () => number;

  constructor(limit: () => number) {
    this.#limit = limit;
  }

  get queued(): number {
    return this.#waiting.length;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#limit()) await new Promise<void>((go) => this.#waiting.push(go)); // the finisher hands its place over
    else this.#running++;
    try {
      return await job();
    } finally {
      const next = this.#waiting.shift();
      if (next) next(); // the place stays taken, now by the next in line
      else this.#running--;
    }
  }
}
