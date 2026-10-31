// Remembers the git tree that a full `npm run gates` passed on, so the pre-push hook can skip a second identical run.
// Only a clean working tree counts (the tree hash then describes exactly what was checked). The file sits next to the lock, in the OS temp dir.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultFile = join(tmpdir(), "ted-gates-passed");

/** The tree hash of HEAD, or undefined when the working tree has uncommitted changes (untracked files that are not ignored count too). */
export function cleanTree(): string | undefined {
  const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
  return git("status", "--porcelain") === "" ? git("rev-parse", "HEAD^{tree}") : undefined;
}

export function recordPassed(tree: string | undefined, file = defaultFile): void {
  if (!tree) return;
  appendFileSync(file, `${tree}\n`);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (lines.length > 100) writeFileSync(file, `${lines.slice(-50).join("\n")}\n`);
}

export function alreadyPassed(tree: string | undefined, file = defaultFile): boolean {
  return !!tree && existsSync(file) && readFileSync(file, "utf8").split("\n").includes(tree);
}
