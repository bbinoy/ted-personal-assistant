import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { layout } from "./convpaths.ts";
import { importLeftovers, layoutState, migrate, reconcile, stragglers, type MigrateOptions, type MigrateResult } from "./migrate.ts";
import { writeFileAtomic } from "./state.ts";

// Moving the data while something still runs on the OLD layout loses writes: the old agent, and above all the old intake page (a separate launchd job, KeepAlive) that writes
// registrations and intake marks and looks up the one-time links in the old places. So the migration first makes sure nobody else is on the data:
//   the agent's own start   stops the intake job (launchctl bootout), refuses if another agent process is running, migrates, then starts the intake job again;
//   npm run migrate         refuses while the agent or the intake job is running, with the exact commands, or with --stop-services stops both, migrates and starts them again.
// All the process-level facts go through `Services`, so tests inject a fake; off macOS there is no launchd and nothing to stop.

export interface Services {
  running(label: string): boolean; // the launchd job is loaded and has a process
  stop(label: string): void; // launchctl bootout: unloaded, its process ended
  start(label: string): void; // launchctl bootstrap (if not loaded) and kickstart
  agentPids(): number[]; // OTHER processes running the agent (a src/main.ts scan and the pid file), never this one
}

const uid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);

export function realServices(root: string): Services {
  const mac = process.platform === "darwin";
  const launchctl = (args: string[]): string => execFileSync("launchctl", args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  };
  return {
    running: (label) => {
      if (!mac) return false;
      try { return /\bpid = \d+/.test(launchctl(["print", `gui/${uid()}/${label}`])); } catch { return false; }
    },
    stop: (label) => {
      if (!mac) return;
      try { launchctl(["bootout", `gui/${uid()}/${label}`]); } catch { /* not loaded */ }
      for (let i = 0; i < 10; i++) {
        try { launchctl(["print", `gui/${uid()}/${label}`]); } catch { return; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
    },
    start: (label) => {
      if (!mac) return;
      const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
      if (existsSync(plist)) try { launchctl(["bootstrap", `gui/${uid()}`, plist]); } catch { /* loaded already */ }
      try { launchctl(["kickstart", "-k", `gui/${uid()}/${label}`]); } catch { /* not installed */ }
    },
    agentPids: () => {
      const pids = new Set<number>();
      if (process.env.MIGRATE_AGENT_SCAN !== "off") try { // (off: tests, which must not see the live agent of the machine they run on; the pid file of THIS data folder is still read)
        for (const l of execFileSync("pgrep", ["-f", "src/main.ts"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).split("\n")) if (/^\d+$/.test(l.trim())) pids.add(Number(l));
      } catch { /* none */ }
      try {
        const p = Number(readFileSync(layout(root).instance.agentPid, "utf8").trim());
        if (Number.isInteger(p) && alive(p)) pids.add(p);
      } catch { /* none */ }
      pids.delete(process.pid);
      pids.delete(process.ppid); // (the shell or npm that started this process)
      return [...pids];
    },
  };
}

/** The agent writes its pid when it is up, so a migration started from a terminal knows to wait for it to stop. */
export const writeAgentPid = (root: string): void => {
  const file = layout(root).instance.agentPid;
  writeFileAtomic(file, `${process.pid}\n`);
  process.on("exit", () => rmSync(file, { force: true }));
};

export interface SafeOptions extends MigrateOptions {
  services?: Services;
  agentLabel: string;
  mode: "agent" | "cli"; // the agent's own start, or npm run migrate
  stopServices?: boolean; // cli: stop the agent and the intake job instead of refusing
  wait?: number;
}

const bootout = (label: string) => `launchctl bootout gui/${uid()}/${label}`;

/**
 * The migration (and the late-file reconcile) with the services out of the way. Returns what migrate returned (`already` when the folder was current).
 * Throws a sentence that says exactly what to stop when something else is on the data.
 */
export function migrateSafely(root: string, o: SafeOptions): MigrateResult {
  const svc = o.services ?? realServices(root);
  const intake = `${o.agentLabel}-intake`;
  const state = layoutState(root);
  const needs = state.state === "unmigrated" || (state.state === "current" && stragglers(root, o.fs).length > 0);
  if (!needs) return migrate(root, o, o.wait); // fresh (stamp it), current (nothing to do) or newer (it throws)
  const others = svc.agentPids();
  const agentUp = o.mode === "cli" ? svc.running(o.agentLabel) || others.length > 0 : false;
  const intakeUp = svc.running(intake);
  if (o.mode === "agent" && state.state === "unmigrated" && others.length > 0) throw new Error(`another agent process is running (pid ${others.join(", ")}): stop it first (${bootout(o.agentLabel)}, or kill it), then start again. The data folder is not touched`);
  if (o.mode === "cli" && (agentUp || intakeUp) && !o.stopServices) {
    const jobs = [agentUp ? o.agentLabel : "", intakeUp ? intake : ""].filter(Boolean);
    throw new Error(`${agentUp ? "the agent" : "the intake page"} is running and would write to the old places while the data moves. Stop ${jobs.length > 1 ? "them" : "it"} first: ${jobs.map(bootout).join(" ; ")}${others.length && !svc.running(o.agentLabel) ? ` ; kill ${others.join(" ")}` : ""} ; then run npm run migrate again. Or run npm run migrate -- --stop-services, which stops them, migrates, and starts them again`);
  }
  const stopped: string[] = [];
  if (intakeUp) { svc.stop(intake); stopped.push(intake); }
  if (o.mode === "cli" && agentUp) {
    svc.stop(o.agentLabel);
    stopped.push(o.agentLabel);
    for (const p of svc.agentPids()) try { process.kill(p, "SIGTERM"); } catch { /* gone */ }
  }
  const r = state.state === "unmigrated" ? migrate(root, o, o.wait) : (reconcile(root, o, o.wait), importLeftovers(root, o, o.wait), { already: true, moved: 0, orphans: [] } as MigrateResult);
  for (const label of stopped) svc.start(label); // (only after the stamp; a failed migration leaves them stopped, and says so)
  return r;
}
