import { rmSync } from "node:fs";
import { dataPath, readText } from "./state.ts";
import { instanceDb } from "./instancedb.ts";
import { untilOn, untilWords } from "./until.ts";
import { instancePaths } from "./convpaths.ts";
import { dayIn } from "./timezone.ts";

// The day as YYYY-MM-DD: the Mac's by default, a conversation's own with its zone (timezone.ts).
export const localDay = (d: Date, zone?: string) =>
  zone ? dayIn(d, zone) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Local wall time (MM-DD HH:MM), like the agent's own log.
export const localTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ONE pause switch for everything unattended (heartbeat, triage actions, daily brief, browse, the group gate): a row of instance.db (kv "paused"), an "until" value (until.ts): "" = until /resume,
// an ISO time = until then (what the chat's "/pause 2h" writes, conversation/ownercommands.ts). It is a KILL SWITCH, so it fails safe: a value nobody can read, or a database that cannot be opened,
// counts as PAUSED (chat still answers). An old pause file (instance/paused) is honoured once, at the start (importPauseFile), and converted.
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

// The start (core/agentstart.ts): the old pause FILE, if there is one, becomes the row and is deleted. It held "" (until removed), a local day (YYYY-MM-DD: until that day began) or an ISO time;
// anything else stays paused until /resume.
export function importPauseFile(): boolean {
  const file = instancePaths().paused;
  const old = readText(file)?.trim();
  if (old === undefined) return false;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(old);
  const until = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).toISOString() : old.includes("T") && Number.isFinite(Date.parse(old)) ? old : "";
  setPause(until);
  rmSync(dataPath(file), { force: true });
  return true;
}
