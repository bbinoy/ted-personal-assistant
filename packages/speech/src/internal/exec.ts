import { existsSync } from "node:fs";
import { join } from "node:path";

// Where the helper programs (ffmpeg, whisper-cli) are looked for besides PATH: a service started by a supervisor
// often has a thin PATH that lacks Homebrew. (macOS/Linux; Windows is untested.)
export const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

// Variables that look like credentials (API keys, tokens, an ssh agent socket). The helper programs (ffmpeg, whisper, Kokoro's
// Python) open files and network data other people control and need none of these, so a bug in one cannot read them.
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i;
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_NAME.test(k)));
}

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
