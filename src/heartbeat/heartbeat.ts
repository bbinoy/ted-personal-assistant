import { isPaused } from "../core/pause.ts";
import { settings } from "../core/settings.ts";
import { writeJson } from "../core/state.ts";

// The heartbeat tick: a free timer (no model call) that starts the tick-driven jobs (every conversation's look, the dream). What a conversation does on a tick is the
// heartbeat run (src/heartbeat/look.ts, started from wake.ts): there is no separate mail check; the run reads the mail itself when it is due.

const OWNER_LIVENESS = "state/heartbeat.json"; // last tick, for `npm run doctor`

interface HeartbeatHooks {
  onTick: () => void; // tick-driven jobs (wake-ups, dream): independent of each other, never awaited
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
export function startHeartbeat(hooks: HeartbeatHooks, env: { setTimeout?: (f: () => void, ms: number) => unknown; setInterval?: (f: () => void, ms: number) => unknown } = {}) {
  const tick = () => {
    try {
      hooks.onTick(); // starts its jobs without waiting for them
    } catch (e) {
      console.error("heartbeat: tick jobs failed to start:", (e as Error).message);
    }
    if (!isPaused()) writeJson(OWNER_LIVENESS, { lastTickAt: new Date().toISOString() }); // proof of life, so `doctor` sees the heartbeat ticking
  };

  (env.setTimeout ?? setTimeout)(tick, 20_000); // first tick shortly after start
  (env.setInterval ?? setInterval)(tick, settings.heartbeatMinutes * 60_000);
  console.log(`heartbeat: a free tick every ${settings.heartbeatMinutes} min; each conversation's heartbeat run looks about every ${settings.heartbeatDayMinutes} min in the day on ${settings.heartbeatModel}`);
  return { tick };
}
