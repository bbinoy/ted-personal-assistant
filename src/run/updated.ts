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

// The commit the running code is at, read once: new commits are merged into the repository minutes before the restart, and a run before it must not claim an update that is not running yet.
let started: string | undefined | null = null;
export const startHead = (): string | undefined => (started === null ? (started = git("rev-parse", "HEAD")) : started);

const seenIn = (conv: Conversation): string | undefined => convDb(conv).get<{ commit_id: string }>("SELECT commit_id FROM seen_version WHERE id = 1")?.commit_id;

/** The block for this run, or undefined. Reads only: the commit is stored by markUpdated once the run went through. */
export function updatedFact(conv: Conversation, head = startHead(), run: typeof git = git): string | undefined {
  const last = head ? seenIn(conv) : undefined;
  if (!head || !last || last === head) return undefined; // (no last: the first run here, nothing earlier to be out of date)
  const log = run("log", "--merges", "--first-parent", "--format=%s", `${last}..${head}`);
  if (log === undefined) return undefined;
  const subjects = log.split("\n").filter(Boolean).slice(0, MAX_LINES);
  return ["Ted was updated since the last run in this chat." + (subjects.length ? " Changes, newest first:" : ""), ...subjects.map((s) => `- ${s}`), "Earlier statements in this chat about what you can't do may be out of date: if a tool for it is in your list, try it."].join("\n");
}

/** The run went through (or started a fresh session): this conversation has seen the running version. */
export function markUpdated(conv: Conversation, head = startHead()): void {
  if (head && seenIn(conv) !== head) convDb(conv).run("INSERT INTO seen_version (id, commit_id) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET commit_id = excluded.commit_id", head);
}
