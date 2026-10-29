import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withoutSecrets } from "@ted-assistant/messenger/env";

// Where the helper programs (ffmpeg, whisper-cli) are looked for besides PATH: a service started by a supervisor
// often has a thin PATH that lacks Homebrew. (macOS/Linux; Windows is untested.)
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

// The environment for a child process, with the extra directories appended to PATH and without credentials.
export function toolEnv(): NodeJS.ProcessEnv {
  return { ...withoutSecrets(process.env), PATH: [process.env.PATH ?? "", ...EXTRA_BIN_DIRS].join(":") };
}

// Whether a program is found on PATH or in the extra directories.
export function onPath(bin: string): boolean {
  return (toolEnv().PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));
}

// For ffmpeg, before -i: read only plain files. A file that is really a playlist (HLS, concat) must not make ffmpeg open a
// network address or another local file named inside it.
export const SAFE_INPUT = ["-protocol_whitelist", "file"];

export interface ToolRun {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal; // aborting kills the program and everything it started
  input?: string; // written to its stdin
}

// Runs a helper program to its end. It starts in its own process group, and on a timeout or an abort the whole group is killed (SIGKILL), so no Python
// or ffmpeg process, nor anything one of them started, runs on after the caller gave up. Rejects with the abort reason when aborted, else with an
// error that carries `code`, `signal`, `killed` and `stderr` (the last 8 kB).
export function runTool(file: string, args: string[], o: ToolRun): Promise<void> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(o.signal.reason);
    const child = spawn(file, args, { env: o.env, detached: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let killed = false;
    let done = false;
    const kill = () => {
      killed = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      return err ? reject(err) : resolve();
    };
    const onAbort = () => (kill(), finish(o.signal!.reason as Error));
    const timer = setTimeout(kill, o.timeoutMs);
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-8192)));
    child.stdin.on("error", () => {}); // the program may exit before it reads its input
    child.on("error", (e) => finish(e));
    child.on("close", (code, sig) => finish(code === 0 ? undefined : Object.assign(new Error(`exit ${code ?? "?"}`), { code, signal: sig, killed, stderr })));
    child.stdin.end(o.input ?? "");
  });
}
