// The private-terms and prompt-date checks behind `npm run check:secrets` and the commit-msg hook.
// Terms come from two ignored places in the MAIN checkout (a worktree finds it through git's common dir):
//   conversations/owner/notes/**.md             -> only the NAMES are read: each word of 4+ letters of a page's front matter `person:` (and, until the pages are migrated, of a legacy people-<slug>.md file name)
//   plans/private-terms.txt                      -> lines `deny: <term>`, `allow: <term>`, `allow-file: <path regex>`; allow always wins
// Neither there (CI, a fresh clone): the check is skipped and passes. Findings print the rule name, never the term.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Terms = { deny: string[]; allowFiles: RegExp[] };

// The main checkout's root: the parent of the git common dir (the same for every worktree).
export function mainCheckout(cwd = process.cwd()): string | undefined {
  try {
    const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...env } = process.env; // a git hook sets these: `cwd` decides, not the repository the hook runs for
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
    const add = (w: string) => { if (/^[\p{L}\p{M}]{4,}$/u.test(w)) deny.add(w[0]!.toUpperCase() + w.slice(1).toLowerCase()); };
    const files = readdirSync(notes, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? readdirSync(join(notes, e.name)).map((f) => join(e.name, f)) : [e.name]));
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const slug = f.normalize("NFC").match(/^people-(.+)\.md$/)?.[1]; // (legacy name; gone once every conversation is migrated)
      for (const w of slug?.split("-") ?? []) add(w);
      let head = "";
      try { head = readFileSync(join(notes, f), "utf8").slice(0, 600); } catch { /* unreadable: skip */ }
      const name = /^---\n[\s\S]*?^\s*person:[ \t]*["']?([^"'\n]+)/m.exec(head)?.[1];
      for (const w of name?.normalize("NFC").split(/[\s-]+/) ?? []) add(w);
    }
  }
  const list = join(root, "plans", "private-terms.txt");
  if (existsSync(list)) {
    any = true;
    for (const raw of readFileSync(list, "utf8").normalize("NFC").split("\n")) {
      const m = raw.match(/^\s*(deny|allow|allow-file):\s*(.+?)\s*$/);
      if (!m) continue;
      if (m[1] === "deny") deny.add(m[2]!);
      else if (m[1] === "allow") allow.add(m[2]!);
      else allowFiles.push(new RegExp(m[2]!));
    }
  }
  const allowed = new Set([...allow].map((t) => t.toLowerCase()));
  return any ? { deny: [...deny].filter((t) => !allowed.has(t.toLowerCase())), allowFiles } : undefined;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole word, any case (ids, addresses and voice names are lower case). Scan NFC text.
export function termRegex(t: Terms): RegExp | undefined {
  return t.deny.length ? new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${t.deny.map(escape).join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "iu") : undefined;
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
