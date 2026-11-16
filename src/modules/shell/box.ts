import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { LIMITS } from "../../core/sanitize.ts";
import type { DoctorLine } from "../types.ts";

// The box: one throwaway Linux VM (Apple's `container`) for one run of the workbench. Code builds it and moves bytes in and out; the model only writes ordinary commands.
//   * no network (`--network none`, and the box must prove it: only `lo` may exist, or it is not used), no DNS, no host folder, no environment but two variables, a read-only root
//     file system, the work folder a tmpfs inside the VM (the memory cap caps the disk too), the image's non-root user, memory 1 GB, 2 CPUs
//   * files go in and out only as bytes through the `container` CLI's stdin and stdout, never as a mount
//   * every box is named ted-box-<random>; one that outlives its run is stopped by the run's end, by the process's exit and, after a crash, by the sweep at start-up
// The commands the CLI is given are fixed strings and arguments (never built from model text into a shell on the host): the model's command is ONE argument of `bash -c` inside the VM.

export const TOOLBOX_IMAGE = "ted-toolbox:1"; // tools/toolbox/Dockerfile (npm run toolbox:build)
export const BOX_PREFIX = "ted-box-";
export const WORK = "/work";
export const COMMAND_SECONDS = 120; // a command is killed after this
export const OUT_CUT = 30_000; // bytes of output the model sees, stdout and stderr together
const BOX_LIFETIME_SECONDS = 900; // the box's own ceiling: it ends by itself if nobody stops it
const CLIENT_GRACE_MS = 15_000; // the CLI call itself gets this much longer than the command (the VM's own `timeout` ends the command first)

export interface Ran {
  code: number | null; // null: the CLI could not be started or was killed
  stdout: Buffer; // at most `keep` bytes
  stderr: Buffer;
  more: boolean; // output past `keep` was thrown away
  timedOut: boolean;
}
export interface RunOptions {
  input?: Buffer;
  timeoutMs?: number;
  keep?: number; // bytes of stdout kept (default 1 MB); the rest is drained and dropped
}
// How the `container` CLI is called: tests give a fake one.
export type Runner = (args: readonly string[], o?: RunOptions) => Promise<Ran>;

// The CLI gets a plain environment: nothing of the application's (keys, tokens) is handed to a program that talks to a VM.
const cliEnv = (): NodeJS.ProcessEnv => ({ PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: process.env.HOME, USER: process.env.USER, LANG: "en_US.UTF-8" });

export const containerRunner: Runner = (args, o = {}) =>
  new Promise((resolve) => {
    const keep = o.keep ?? 1_000_000;
    let child;
    try {
      child = spawn("container", [...args], { env: cliEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.from("container CLI not found"), more: false, timedOut: false });
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let kept = 0;
    let errKept = 0;
    let more = false;
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => {
      if (kept >= keep) return void (more = true);
      const room = keep - kept;
      out.push(d.length > room ? d.subarray(0, room) : d);
      kept += Math.min(d.length, room);
      if (d.length > room) more = true;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (errKept >= 64_000) return;
      err.push(d);
      errKept += d.length;
    });
    const timer = o.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), o.timeoutMs) : undefined;
    child.on("error", (e) => (clearTimeout(timer), resolve({ code: null, stdout: Buffer.concat(out), stderr: Buffer.from(String(e.message)), more, timedOut })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), more, timedOut })));
    child.stdin.on("error", () => {}); // (the VM may end before it has read all of its input)
    child.stdin.end(o.input);
  });

export interface Executed {
  code: number; // the command's exit code (124: killed at the time limit)
  stdout: string;
  stderr: string;
  ms: number;
  killed: boolean; // the time limit, or the box itself was lost
  total: number; // bytes the command printed (a lower bound when `cut` past the keep limit)
  cut: boolean;
}

const text = (b: Buffer) => b.toString("utf8");

export class Box {
  readonly name = `${BOX_PREFIX}${randomBytes(6).toString("hex")}`;
  private up = false;
  private readonly run: Runner;
  constructor(run: Runner = containerRunner) {
    this.run = run;
  }

  get running(): boolean {
    return this.up;
  }

  // Starts the VM and checks what must hold before anything runs in it: the work folders exist and the only network interface is loopback. Throws (and leaves no box) otherwise.
  async start(): Promise<void> {
    const r = await this.run(
      ["run", "-d", "--rm", "--name", this.name, "--network", "none", "--no-dns", "--memory", "1g", "--cpus", "2", "--read-only", "--tmpfs", WORK, "-e", `HOME=${WORK}`, "-e", `MPLCONFIGDIR=${WORK}/.mpl`, TOOLBOX_IMAGE, "sleep", String(BOX_LIFETIME_SECONDS)],
      { timeoutMs: 120_000 },
    );
    if (r.code !== 0) throw new Error(`the box did not start: ${text(r.stderr).trim().split("\n").at(-1)?.slice(0, LIMITS.reason) || `exit ${r.code}`}`);
    this.up = true;
    try {
      const setup = await this.sh(`mkdir -p ${WORK}/in ${WORK}/out && ls /sys/class/net`, 20_000);
      if (setup.code !== 0) throw new Error("the box did not set up its folders");
      const nets = text(setup.stdout).trim().split(/\s+/).filter(Boolean);
      if (nets.length !== 1 || nets[0] !== "lo") throw new Error(`the box has a network interface (${nets.join(",").slice(0, 60)}): not used`); // fails closed
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  private sh(script: string, timeoutMs: number, o: RunOptions = {}): Promise<Ran> {
    return this.run(["exec", "-w", WORK, this.name, "sh", "-c", script], { timeoutMs, ...o });
  }

  // A file into /work/in (bytes on stdin; the name is one argument, never part of a script).
  async put(name: string, bytes: Buffer): Promise<boolean> {
    const r = await this.run(["exec", "-i", this.name, "sh", "-c", 'cat > "$1"', "sh", `${WORK}/in/${posix.basename(name)}`], { input: bytes, timeoutMs: 60_000 });
    return r.code === 0;
  }

  // One command, as the box's user, killed at the time limit, with the process and file-size limits of the VM. The command is a single argument of `bash -c`.
  async exec(command: string, seconds = COMMAND_SECONDS): Promise<Executed> {
    const t0 = Date.now();
    const r = await this.run(
      ["exec", "-w", WORK, this.name, "bash", "-c", 'ulimit -u 200; ulimit -f 200000; exec timeout -k 3 "$1" bash -c "$2"', "bash", String(seconds), command],
      { timeoutMs: seconds * 1000 + CLIENT_GRACE_MS, keep: 400_000 },
    );
    const lost = r.code === null || r.timedOut;
    if (lost) await this.stop(); // the CLI call itself failed or hung: the box is not trusted any more
    const code = lost ? 124 : (r.code ?? 1);
    const total = r.stdout.length + r.stderr.length;
    const stdout = text(r.stdout.subarray(0, Math.min(r.stdout.length, OUT_CUT)));
    const left = Math.max(0, OUT_CUT - stdout.length);
    const stderr = text(r.stderr.subarray(0, Math.min(r.stderr.length, Math.max(left, 4_000))));
    return { code, stdout, stderr, ms: Date.now() - t0, killed: lost || code === 124 || code === 137, total, cut: r.more || total > stdout.length + stderr.length };
  }

  // The files under /work/out (path relative to it, size, a stamp that changes when the file does), at most `max` of them.
  async listOut(max = 50): Promise<{ path: string; size: number; stamp: string }[]> {
    const r = await this.sh(`find ${WORK}/out -type f -printf '%s\\t%T@\\t%P\\0' | head -z -n ${max}`, 20_000, { keep: 200_000 });
    if (r.code !== 0) return [];
    return text(r.stdout).split("\0").filter(Boolean).flatMap((line) => {
      const [size, stamp, ...rest] = line.split("\t");
      return Number.isFinite(Number(size)) && rest.length ? [{ path: rest.join("\t"), size: Number(size), stamp: stamp ?? "" }] : [];
    });
  }

  // A file's bytes by path (an absolute path inside /work only); undefined when it is not a plain file or is over `max` bytes.
  async pull(path: string, max: number): Promise<Buffer | undefined> {
    const p = posix.normalize(path.startsWith("/") ? path : `${WORK}/${path}`);
    if (!p.startsWith(`${WORK}/`)) return undefined;
    const r = await this.run(["exec", "-w", WORK, this.name, "sh", "-c", '[ -f "$1" ] && [ ! -L "$1" ] && cat -- "$1"', "sh", p], { timeoutMs: 60_000, keep: max + 1 });
    return r.code === 0 && !r.more && r.stdout.length <= max ? r.stdout : undefined;
  }

  async stop(): Promise<void> {
    if (!this.up) return;
    this.up = false;
    await this.run(["stop", "-t", "1", this.name], { timeoutMs: 30_000 }).catch(() => undefined);
    await this.run(["delete", "-f", this.name], { timeoutMs: 30_000 }).catch(() => undefined); // (a no-op once --rm has removed it)
  }

  // For the process's exit, where nothing can be awaited.
  stopSync(): void {
    if (!this.up) return;
    this.up = false;
    try {
      execFileSync("container", ["delete", "-f", this.name], { env: cliEnv(), timeout: 15_000, stdio: "ignore" });
    } catch {
      // gone already, or the CLI is: the box's own lifetime ends it
    }
  }
}

// At start-up: every ted-box-* container a crashed process left behind is removed. Returns how many.
export async function sweepBoxes(run: Runner = containerRunner): Promise<number> {
  const r = await run(["list", "-a", "-q"], { timeoutMs: 20_000 });
  if (r.code !== 0) return 0;
  const ids = text(r.stdout).split(/\s+/).filter((id) => id.startsWith(BOX_PREFIX));
  if (ids.length) await run(["delete", "-f", ...ids], { timeoutMs: 60_000 });
  return ids.length;
}

// The doctor's checks: the CLI and its service, the image at the expected tag, and a real box that must come up with loopback only and go away again. Off is a valid setup.
export async function toolboxCheck(line: DoctorLine, on: boolean, run: Runner = containerRunner): Promise<void> {
  if (!on) return line(true, "workbench: off", "WORKBENCH=off");
  const what = "workbench (sandboxed shell)";
  const status = await run(["system", "status"], { timeoutMs: 15_000 });
  if (status.code === null) return line(false, what, "the `container` CLI is not installed (Apple silicon, macOS 26: https://github.com/apple/container); until then the shell tool tells the user it is not available");
  if (status.code !== 0) return line(false, what, "the container service is not running: `container system start` (under launchd it starts at login)");
  const image = await run(["image", "inspect", TOOLBOX_IMAGE], { timeoutMs: 15_000 });
  if (image.code !== 0) return line(false, what, `image ${TOOLBOX_IMAGE} is missing: npm run toolbox:build`);
  const box = new Box(run);
  const t0 = Date.now();
  try {
    await box.start(); // (it checks that only `lo` exists)
    const ran = await box.exec("id -u && python3 -c 'import pandas, pdfplumber' && pdftotext -v 2>&1 | head -1");
    if (ran.code !== 0 || ran.stdout.startsWith("0\n")) return line(false, what, `the box ran, but its tools did not (exit ${ran.code}, user ${ran.stdout.split("\n")[0]}): rebuild the image`);
    line(true, what, `image ${TOOLBOX_IMAGE}, a box starts in ${((Date.now() - t0) / 1000).toFixed(1)} s with no network (loopback only) and a non-root user`);
  } catch (e) {
    line(false, what, (e as Error).message.slice(0, LIMITS.reason));
  } finally {
    await box.stop();
  }
}
