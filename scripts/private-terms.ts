// The private-terms and prompt-date checks behind `npm run check:secrets` and the commit-msg hook.
// Terms come from two ignored places in the MAIN checkout (a worktree finds it through git's common dir):
//   conversations/owner/notes/people-<slug>.md  -> only the FILE NAMES are read: each slug word of 4+ letters, capitalised
//   plans/private-terms.txt                      -> lines `deny: <term>`, `allow: <term>`, `allow-file: <path regex>`; allow always wins
// Neither there (CI, a fresh clone): the check is skipped and passes. Findings print the rule name, never the term.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Terms = { deny: string[]; allowFiles: RegExp[] };

// The main checkout's root: the parent of the git common dir (the same for every worktree).
export function mainCheckout(cwd = process.cwd()): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirname(resolve(cwd, common));
  } catch {
    return undefined;
  }
}

// undefined when neither source exists (CI, a fresh clone).
export function loadTerms(root: string | undefined): Terms | undefined {
  if (!root) return undefined;
  const deny = new Set<string>();
  const allow = new Set<string>();
  const allowFiles: RegExp[] = [];
  let any = false;
  const notes = join(root, "conversations", "owner", "notes");
  if (existsSync(notes)) {
    any = true;
    for (const f of readdirSync(notes)) {
      const slug = f.match(/^people-(.+)\.md$/)?.[1];
      for (const w of slug?.split("-") ?? []) if (/^\p{L}{4,}$/u.test(w)) deny.add(w[0]!.toUpperCase() + w.slice(1).toLowerCase());
    }
  }
  const list = join(root, "plans", "private-terms.txt");
  if (existsSync(list)) {
    any = true;
    for (const raw of readFileSync(list, "utf8").split("\n")) {
      const m = raw.match(/^\s*(deny|allow|allow-file):\s*(.+?)\s*$/);
      if (!m) continue;
      if (m[1] === "deny") deny.add(m[2]!);
      else if (m[1] === "allow") allow.add(m[2]!);
      else allowFiles.push(new RegExp(m[2]!));
    }
  }
  return any ? { deny: [...deny].filter((t) => !allow.has(t)), allowFiles } : undefined;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole word, case-sensitive.
export function termRegex(t: Terms): RegExp | undefined {
  return t.deny.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${t.deny.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "u") : undefined;
}

// Prompts (assistants/, plugin/) use invented dates: only May, as "3 May" or "2026-05-03".
const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
export const promptDates = {
  name: "prompt date outside May (use an invented one like 3 May)",
  re: new RegExp(`\\b\\d{1,2}(?:-\\d{1,2})? (?:${MONTHS})\\b|\\b(?:${MONTHS}) \\d{1,2}\\b|\\b20[2-3]\\d-(?!05-)(?:0[1-9]|1[0-2])-[0-3]\\d`),
  files: /^(assistants|plugin)\//,
  // the one exception: a rule that needs a real month (clocks change on the last Sunday of October)
  allow: [{ file: /^plugin\/skills\/calendar\/SKILL\.md$/, line: /last Sunday of October/ }],
};
