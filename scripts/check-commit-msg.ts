// The commit message rules (CONTRIBUTING.md "Git hygiene"), as a checker that the commit-msg hook runs.
//   node scripts/check-commit-msg.ts <file with the message>      (git passes this file to the hook)
// Exit 1 and a list of problems when the message breaks a rule. Merge commits and fixup/squash commits are not checked.
import { readFileSync } from "node:fs";

export const TYPES = ["feat", "fix", "refactor", "perf", "docs", "test", "chore", "ci", "build", "revert"] as const;
export const SUBJECT_MAX = 72; // GitHub shows about this much of a subject before it cuts it
export const BODY_MAX = 100;

const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9/_-]*\\))?!?: (\\S.*)$`);
// Trailers and web addresses may be long: they are not prose to wrap.
const EXEMPT = /^([A-Za-z-]+: .*|https?:\/\/\S+|\s*\S+:\/\/\S+)$/;

export function checkCommitMessage(message: string): string[] {
  const lines = message.replace(/\r/g, "").split("\n").filter((l) => !l.startsWith("#"));
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  const subject = lines[0] ?? "";
  if (!subject.trim()) return ["the message is empty"];
  if (/^(Merge\b|Revert "|fixup! |squash! )/.test(subject)) return [];
  const problems: string[] = [];
  const m = SUBJECT.exec(subject);
  if (!m) problems.push(`the subject must start with a type: ${TYPES.map((t) => `${t}:`).join(" ")} (optionally ${TYPES[0]}(scope):), then a short summary`);
  if (subject.length > SUBJECT_MAX) problems.push(`the subject is ${subject.length} characters; keep it to ${SUBJECT_MAX} so GitHub does not cut it`);
  if (m && /\.$/.test(subject)) problems.push("no full stop at the end of the subject");
  if (m && /^[A-Z]/.test(m[3]!)) problems.push("start the summary in lower case, in the imperative (add, fix, remove...)");
  if (lines.length > 1 && lines[1]!.trim() !== "") problems.push("leave a blank line between the subject and the body");
  lines.slice(2).forEach((l, i) => {
    if (l.length > BODY_MAX && !EXEMPT.test(l)) problems.push(`body line ${i + 3} is ${l.length} characters; wrap it at ${BODY_MAX} (72 is nicer)`);
  });
  return problems;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/check-commit-msg.ts <commit message file>");
    process.exit(2);
  }
  const problems = checkCommitMessage(readFileSync(file, "utf8"));
  if (problems.length) {
    console.error("Commit message not accepted:\n" + problems.map((p) => `  - ${p}`).join("\n") + "\nSee CONTRIBUTING.md, \"Git hygiene\".");
    process.exit(1);
  }
}
