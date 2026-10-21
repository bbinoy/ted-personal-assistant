import { isPaused } from "../core/pause.ts";
import { settings } from "../core/settings.ts";
import { writeJson } from "../core/state.ts";

// The heartbeat tick: a free timer (no model call) that starts the tick-driven jobs (every conversation's look, the dream). What a conversation does on a tick is the
// heartbeat run (src/heartbeat/look.ts, started from wake.ts): there is no separate mail check; the run reads the mail itself when it is due.

const OWNER_LIVENESS = "state/heartbeat.json"; // last tick, for `npm run doctor`

interface HeartbeatHooks {
  onTick: () => void; // tick-driven jobs (wake-ups, dream): independent of each other, never awaited
  onSleep?: (sleptMs: number) => void; // the process slept (or the clock jumped): stop what was in flight, its connections are dead (wake.ts slept)
}

// After a sleep the jobs wait this long for the network (Wi-Fi, VPN, DNS) to come back before the due looks start again.
export const SETTLE_MS = 20_000;

// Did the process sleep between two ticks? `wallGap` is the Date clock, `monoGap` a monotonic one (on macOS it stands still while the Mac sleeps), `period` the tick's own. Pure.
// Yes when the two disagree by more than a period (the drift is how long it slept), or when the ticks are more than three periods apart whatever the clocks say (a suspended
// or starved process). Returns how long, in ms, or 0.
export function sleptFor(wallGap: number, monoGap: number, period: number): number {
  const drift = wallGap - monoGap;
  if (drift > period) return drift;
  return wallGap > 3 * period ? wallGap : 0;
}

// Starts every tick-driven job (wake-ups, dream): each in its own try/catch, none awaited, so a job that throws
// (even synchronously) or hangs never keeps another from starting.
export function startJobs(jobs: Record<string, () => unknown>): void {
  for (const [name, f] of Object.entries(jobs)) {
    try {
      void Promise.resolve(f()).catch((e) => console.error(`${name}: tick failed:`, (e as Error).message));
    } catch (e) {
      console.error(`${name}: tick failed:`, (e as Error).message);
    }
  }
}

// The tick: a free timer. `env` is for tests: fake timers.
export function startHeartbeat(hooks: HeartbeatHooks, env: { setTimeout?: (f: () => void, ms: number) => unknown; setInterval?: (f: () => void, ms: number) => unknown; now?: () => number; mono?: () => number; settleMs?: number } = {}) {
  const period = settings.heartbeatMinutes * 60_000;
  const now = env.now ?? Date.now;
  const mono = env.mono ?? (() => performance.now());
  let lastWall = now();
  let lastMono = mono();
  const startJobsNow = () => {
    try {
      hooks.onTick(); // starts its jobs without waiting for them
    } catch (e) {
      console.error("heartbeat: tick jobs failed to start:", (e as Error).message);
    }
  };
  const tick = () => {
    const wall = now();
    const m = mono();
    const slept = sleptFor(wall - lastWall, m - lastMono, period);
    lastWall = wall;
    lastMono = m;
    if (slept > 0) {
      console.log(`heartbeat: the Mac slept for ${Math.round(slept / 60_000)} min`);
      try {
        hooks.onSleep?.(slept); // stops every look in flight: their connections died with the sleep
      } catch (e) {
        console.error("heartbeat: could not stop the runs after the sleep:", (e as Error).message);
      }
      (env.setTimeout ?? setTimeout)(startJobsNow, env.settleMs ?? SETTLE_MS); // the network needs a moment; the normal due-check then restarts what was cut off
    } else startJobsNow();
    if (!isPaused()) writeJson(OWNER_LIVENESS, { lastTickAt: new Date().toISOString() }); // proof of life, so `doctor` sees the heartbeat ticking
  };

  (env.setTimeout ?? setTimeout)(tick, 20_000); // first tick shortly after start
  (env.setInterval ?? setInterval)(tick, settings.heartbeatMinutes * 60_000);
  console.log(`heartbeat: a free tick every ${settings.heartbeatMinutes} min; each conversation's heartbeat run looks about every ${settings.heartbeatDayMinutes} min in the day on ${settings.heartbeatModel}`);
  return { tick };
}
