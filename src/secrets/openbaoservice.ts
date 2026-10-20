import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Layout } from "./openbaoadmin.ts";

// The two launchd jobs of the secret store (launchd/*.plist.template): the server, and the keeper that unseals it after a login and renews
// the tokens. User agents (~/Library/LaunchAgents): they start at login, like the agent itself, and need no root.

export interface ServiceNames {
  server: string;
  keeper: string;
}
export const serviceNames = (env: NodeJS.ProcessEnv = process.env): ServiceNames => {
  const server = env.OPENBAO_LAUNCHD_LABEL?.trim() || `com.${userInfo().username}.ted-openbao`;
  return { server, keeper: `${server}-keeper` };
};

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Pure. The server job's plist.
export function serverPlist(template: string, l: Layout, label: string): string {
  return template.replace(/__LABEL__/g, () => xml(label)).replace(/__BIN__/g, () => xml(l.bin)).replace(/__CONFIG__/g, () => xml(l.config)).replace(/__HOME__/g, () => xml(l.dir)).replace(/__LOGS__/g, () => xml(l.logs));
}

// Pure. The keeper's plist, with the (non-secret) settings it must see, since launchd gives it no .env.
export function keeperPlist(template: string, l: Layout, label: string, repoDir: string, env: Record<string, string>): string {
  const vars = Object.entries(env).map(([k, v]) => `        <key>${xml(k)}</key>\n        <string>${xml(v)}</string>`).join("\n");
  return template.replace(/__LABEL__/g, () => xml(label)).replace(/__DIR__/g, () => xml(repoDir)).replace(/__LOGS__/g, () => xml(l.logs)).replace("__ENV__", () => vars);
}

const launchctl = (args: string[]): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    execFile("/bin/launchctl", args, { encoding: "utf8", timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: stdout + stderr });
    });
  });

const domain = (): string => `gui/${userInfo().uid}`;
const plistPath = (label: string): string => join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isLoaded = async (label: string): Promise<boolean> => (await launchctl(["print", `${domain()}/${label}`])).code === 0;

// Writes the plist and (re)loads the job. Does nothing when the same plist is already loaded (restarting the server would seal it).
export async function installJob(label: string, plist: string, l: Layout): Promise<"started" | "unchanged"> {
  const path = plistPath(label);
  mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  mkdirSync(l.logs, { recursive: true, mode: 0o700 });
  for (const f of ["server.log", "keeper.log"]) if (!existsSync(join(l.logs, f))) writeFileSync(join(l.logs, f), "", { mode: 0o600 }); // launchd would create them world-readable
  if (existsSync(path) && readFileSync(path, "utf8") === plist && (await isLoaded(label))) return "unchanged";
  writeFileSync(path, plist, { mode: 0o644 });
  const lint = await new Promise<number>((res) => execFile("/usr/bin/plutil", ["-lint", path], (e) => res(e ? 1 : 0)));
  if (lint !== 0) throw new Error(`the launchd file for ${label} is not valid`);
  await launchctl(["bootout", `${domain()}/${label}`]);
  for (let i = 0; i < 10 && (await isLoaded(label)); i++) await sleep(1000); // bootout returns before the old job is gone
  for (let i = 1; ; i++) {
    const r = await launchctl(["bootstrap", domain(), path]);
    if (r.code === 0) return "started";
    if (i >= 5) throw new Error(`launchctl bootstrap failed for ${label}: ${r.out.trim().split("\n")[0]!.slice(0, 120)}`);
    await sleep(2000);
  }
}

export async function removeJob(label: string): Promise<boolean> {
  const was = existsSync(plistPath(label));
  await launchctl(["bootout", `${domain()}/${label}`]);
  rmSync(plistPath(label), { force: true });
  return was;
}

export const ensureNodePath = (repoDir: string): void => {
  const f = join(repoDir, ".node-path");
  if (!existsSync(f)) {
    writeFileSync(f, `${dirname(process.execPath)}\n`);
    chmodSync(f, 0o644);
  }
};
