// Starts `signal-cli daemon` on localhost, so the client has something to connect to.
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import net from "node:net";
import { withoutSecrets } from "@ted-assistant/messenger/env";
import { silentLogger, type Logger } from "./logger.ts";

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

/** Options of {@link ensureSignalDaemon}. */
export interface DaemonOptions {
  account: string; // the signal-cli account to run as
  host: string; // where it listens; must be this machine unless allowNonLoopback is set
  port: number;
  logFd?: number | (() => number); // where the daemon's output goes (a file descriptor opened for appending); default: discarded. A function is called ONLY when a daemon is started (not when one is reused) and the descriptor it returns is closed here once the child has its own copy
  logger?: Logger;
  allowNonLoopback?: boolean; // you know the socket is unauthenticated and have put your own protection around it
}

const LOOPBACK = ["127.0.0.1", "::1", "[::1]", "localhost"];

/** A running daemon, as {@link ensureSignalDaemon} reports it. */
export interface SignalDaemon {
  /** False: one was already listening and we reuse it (we do not own it, so `stop()` does nothing). */
  started: boolean;
  /** Asks the daemon we started to quit (SIGTERM). Does nothing for a reused one. */
  stop(): void;
  /** Settles when the daemon we started exits. Never settles for a reused one. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Makes sure a signal-cli daemon is listening on `host:port`, starting `signal-cli` (which must be installed and
 * registered for `account`) if needed. Installs no process handlers and never exits the process: what to do when the
 * daemon dies, and when to stop it, is the caller's decision.
 * @throws if `host` is not this machine (signal-cli's socket has no authentication, so anyone who can reach it can
 *   send as the account) unless `allowNonLoopback` is set; if signal-cli exits at once or opens no port within 30 s
 */
export async function ensureSignalDaemon(opts: DaemonOptions): Promise<SignalDaemon> {
  const { account, host, port, logFd } = opts;
  const log = opts.logger ?? silentLogger;
  if (!opts.allowNonLoopback && !LOOPBACK.includes(host.toLowerCase())) {
    throw new Error(`refusing to run signal-cli on ${host}: its socket is unauthenticated, so only 127.0.0.1, ::1 or localhost are allowed (set allowNonLoopback to override)`);
  }
  if (await portOpen(host, port)) {
    log.info("signal-cli daemon already running, reusing it");
    return { started: false, stop() {}, exited: new Promise(() => {}) };
  }
  const ours = typeof logFd === "function" ? logFd() : undefined; // opened for this spawn only: ours to close
  const out = ours ?? (typeof logFd === "number" ? logFd : "ignore");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("signal-cli", ["-a", account, "daemon", "--tcp", `${host}:${port}`, "--no-receive-stdout"], {
      stdio: ["ignore", out, out],
      env: withoutSecrets(process.env), // it parses what strangers send; it needs none of the app's keys
    });
  } finally {
    if (ours !== undefined) closeSync(ours); // the child has its own copy; ours would leak one descriptor per start
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null })); // could not be started at all (not installed)
  });
  let gone = false;
  void exited.then(() => (gone = true));
  const daemon: SignalDaemon = { started: true, stop: () => void child.kill("SIGTERM"), exited };

  for (let i = 0; i < 60; i++) {
    if (await portOpen(host, port)) {
      log.info("signal-cli daemon started");
      return daemon;
    }
    if (gone) throw new Error("signal-cli exited before it opened its port");
    await new Promise((r) => setTimeout(r, 500));
  }
  daemon.stop();
  throw new Error("signal-cli did not open its port within 30s");
}
