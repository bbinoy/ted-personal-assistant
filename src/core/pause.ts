import { instanceDb } from "./instancedb.ts";
import { untilOn, untilWords } from "./until.ts";

// ONE pause switch for everything unattended (heartbeat, triage actions, daily brief, browse, the group gate): a row of instance.db (kv "paused"), an "until" value (until.ts): "" = until /resume,
// an ISO time = until then (what the chat's "/pause 2h" writes, conversation/ownercommands.ts). It is a KILL SWITCH, so it fails safe: a value nobody can read, or a database that cannot be opened,
// counts as PAUSED (chat still answers).
const KEY = "paused";
export function isPaused(now = new Date()): boolean {
  try {
    const row = instanceDb().get<{ value: string }>("SELECT value FROM kv WHERE key = ?", KEY);
    return row ? untilOn(JSON.parse(row.value), now, true) : false;
  } catch {
    return true;
  }
}

// What the switch says, for "/status" and the doctor: undefined when not paused.
export function pauseText(now = new Date(), zone?: string): string | undefined {
  if (!isPaused(now)) return undefined;
  try {
    const row = instanceDb().get<{ value: string }>("SELECT value FROM kv WHERE key = ?", KEY);
    const v: unknown = row && JSON.parse(row.value);
    return typeof v === "string" ? `paused ${untilWords(v, zone)}` : "paused (its value cannot be read)";
  } catch {
    return "paused (the database cannot be read)";
  }
}

// Written straight (not kvSet, which only logs a failure): a pause that was not stored must not be reported as set.
export const setPause = (until: string): void =>
  void instanceDb().run("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", KEY, JSON.stringify(until), Date.now());
export const clearPause = (): void => void instanceDb().run("DELETE FROM kv WHERE key = ?", KEY);
