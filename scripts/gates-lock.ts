// One gates run at a time per machine (several agents often run `npm run gates` together and each slows the others down).
// The lock is a folder in the OS temp dir (not in the repo: worktrees differ) made with mkdir, which is atomic. It holds pid + start time.
// A lock whose pid is gone is stale and taken over; a rename makes sure only one waiter takes it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultLockDir = join(tmpdir(), "ted-gates.lock");

type Holder = { pid: number; started: number };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

function holder(dir: string): Holder | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "holder.json"), "utf8")) as Holder;
  } catch {
    return undefined; // just created and not written yet, or gone
  }
}

/** Tries once. Returns a release function, or the holder (undefined holder = being created) when the lock is taken. */
export function tryAcquire(dir = defaultLockDir): { release: () => void } | { holder: Holder | undefined } {
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const h = holder(dir);
    if (h && !alive(h.pid)) {
      const aside = `${dir}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(dir, aside); // only one waiter wins this
        rmSync(aside, { recursive: true, force: true });
      } catch {
        /* someone else took it over first */
      }
      return tryAcquire(dir);
    }
    return { holder: h };
  }
  writeFileSync(join(dir, "holder.json"), JSON.stringify({ pid: process.pid, started: Date.now() }));
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Waits (polling) until the lock is ours; `onWait` is called once with the holder. Released on exit, SIGINT and SIGTERM. */
export async function acquire(opts: { dir?: string; pollMs?: number; onWait?: (h: Holder | undefined) => void } = {}): Promise<() => void> {
  let told = false;
  for (;;) {
    const r = tryAcquire(opts.dir);
    if ("release" in r) {
      const release = r.release;
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(128 + (sig === "SIGINT" ? 2 : 15)));
      return release;
    }
    if (!told && r.holder) {
      told = true;
      opts.onWait?.(r.holder);
    }
    await new Promise((res) => setTimeout(res, opts.pollMs ?? 1000));
  }
}
