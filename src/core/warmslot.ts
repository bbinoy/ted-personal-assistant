// One spare ("warm") Claude Code process, built ahead of time for the next message (agent.ts, gate.ts).
// It is a slot, not a pool: putting another process in closes the one it replaces, so a slot never holds more than one.
// All slots share the mechanism and the one idle time (WARM_IDLE_MINUTES in settings.ts): the owner's chat, the latest groups (another
// group becoming the latest replaces it) and the gate's Haiku. A spare is built from fixed options (system prompt, tools,
// MCP servers, output schema: the SDK cannot change them per query), so it is handed out only for the same id and the same
// key, and never to another conversation. A spare can die while idle: firstWarm below falls back to a cold start.

interface Closeable {
  close(): void;
}

interface SlotOptions {
  maxAgeMs: number; // older than this when asked for: not used
  idleMs?: () => number; // dropped this long after it was last put in (0 or unset: kept until replaced or too old)
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void; // returns its cancel (tests)
}

const unrefTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

export class SpareSlot<W extends Closeable> {
  #cur?: { id: string; key: string; at: number; warm: Promise<W> };
  #activeAt = 0; // when the conversation last did something (put, touch): the idle period counts from here
  #cancelIdle?: () => void;
  readonly #o: SlotOptions;

  constructor(o: SlotOptions) {
    this.#o = o;
  }

  #now = () => (this.#o.now ?? Date.now)();

  // Which conversation the spare is for, if there is one (for logs and tests).
  get holder(): string | undefined {
    return this.#cur?.id;
  }

  // Is there a fresh spare for this conversation already (and, when a key is given, one built for exactly that)? `lastsMs`: and one that stays fresh
  // for at least that much longer (a refresh asks with the time until its next turn).
  has(id: string, key?: string, lastsMs = 0): boolean {
    const c = this.#cur;
    return !!c && c.id === id && (key === undefined || c.key === key) && this.#now() - c.at < this.#o.maxAgeMs - lastsMs;
  }

  // Keep this warm process as the spare, closing the one it replaces. A process that fails to start empties the slot.
  // `refresh`: only renews the process (a timer rebuilding it before it goes stale), not a sign of activity: the idle period
  // keeps counting from the last real use, and a refresh after it has run out builds nothing.
  put(id: string, key: string, warm: Promise<W>, o: { refresh?: boolean } = {}): void {
    const keepActive = o.refresh && this.#cur?.id === id;
    if (o.refresh && !keepActive) return void warm.then((w) => w.close()).catch(() => {});
    this.drop();
    const entry = { id, key, at: this.#now(), warm };
    this.#cur = entry;
    if (!keepActive) this.#activeAt = entry.at;
    warm.catch(() => {
      if (this.#cur === entry) this.drop();
    });
    this.#armIdle();
  }

  // Is a refresh worth it: the spare is for this conversation and not idle-expired.
  wants(id: string): boolean {
    return this.#cur?.id === id;
  }

  // The conversation is still active: start its idle period over. No-op for a spare that is not this conversation's.
  touch(id: string): void {
    if (this.has(id)) (this.#activeAt = this.#now(), this.#armIdle());
  }

  #armIdle(): void {
    this.#cancelIdle?.();
    this.#cancelIdle = undefined;
    const idle = this.#o.idleMs?.() ?? 0;
    if (idle > 0) this.#cancelIdle = (this.#o.schedule ?? unrefTimer)(() => this.drop(), Math.max(1, idle - (this.#now() - this.#activeAt)));
  }

  // The spare, if it was built for exactly this conversation and state and is fresh. A spare serves one query, so it leaves the
  // slot; one of the same conversation that no longer fits (session moved on, too old) is closed. One of another conversation
  // is left alone: that conversation's own turn replaces it when it is done.
  take(id: string, key: string): Promise<W> | undefined {
    const c = this.#cur;
    if (!c || c.id !== id) return undefined;
    this.#clear();
    if (c.key === key && this.#now() - c.at < this.#o.maxAgeMs) return c.warm;
    c.warm.then((w) => w.close()).catch(() => {});
    return undefined;
  }

  drop(): void {
    const c = this.#cur;
    this.#clear();
    c?.warm.then((w) => w.close()).catch(() => {});
  }

  #clear(): void {
    this.#cur = undefined;
    this.#cancelIdle?.();
    this.#cancelIdle = undefined;
  }
}

// Runs the query on a warm process; if that fails before it produced anything (the process died while idle:
// "ProcessTransport is not ready for writing"), runs `cold` instead. Once a message has come, an error is the run's own
// and is thrown: running it again could repeat what it already did.
export async function* firstWarm<T>(warm: () => AsyncIterable<T>, cold: () => AsyncIterable<T>, onFallback?: (e: Error) => void): AsyncGenerator<T> {
  let any = false;
  try {
    for await (const m of warm()) {
      any = true;
      yield m;
    }
    return;
  } catch (e) {
    if (any) throw e;
    onFallback?.(e as Error);
  }
  yield* cold();
}
