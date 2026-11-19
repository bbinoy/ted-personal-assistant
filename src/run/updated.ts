import { execFileSync } from "node:child_process";
import { convDb } from "../core/convdb.ts";
import { ROOT } from "../core/paths.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";

// "Ted was updated": a chat session keeps what Ted said earlier ("I can't read files you send"), so after a new version ships it still believes its old limits. The first run of a conversation
// after the code moved on from the commit that conversation last ran on gets this fact (the merge subjects in between, from git); later runs get nothing until the next update. The same for
// every conversation and trigger (agent.ts). No git, or a commit git does not know: no block, nothing fails.
const MAX_LINES = 12;

const git = (...args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

/** The block for this run, or undefined; the conversation's last-seen commit is moved to the current one either way. */
export function updatedFact(conv: Conversation, run: typeof git = git): string | undefined {
  const head = run("rev-parse", "HEAD");
  if (!head) return undefined;
  const db = convDb(conv);
  const last = db.get<{ commit_id: string }>("SELECT commit_id FROM seen_version WHERE id = 1")?.commit_id;
  if (last === head) return undefined;
  db.run("INSERT INTO seen_version (id, commit_id) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET commit_id = excluded.commit_id", head);
  if (!last) return undefined; // the first run here: nothing earlier to be out of date
  const log = run("log", "--merges", "--first-parent", "--format=%s", `${last}..${head}`);
  if (log === undefined) return undefined;
  const subjects = log.split("\n").filter(Boolean).slice(0, MAX_LINES);
  return ["Ted was updated since the last run in this chat." + (subjects.length ? " Changes, newest first:" : ""), ...subjects.map((s) => `- ${s}`), "Earlier statements in this chat about what you can't do may be out of date: if a tool for it is in your list, try it."].join("\n");
}
