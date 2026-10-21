import { readAudit, type AuditEntry, type Source } from "../core/audit.ts";
import { isReadTool } from "../policy/policy.ts";
import { foldEdits, messagesSince, withoutDeleted, type Sent } from "../core/messages.ts";
import { settings } from "../core/settings.ts";
import { LIMITS } from "../core/sanitize.ts";
import { listTenants } from "../tenants/tenants.ts";
import { owner, tenant, type Conversation, type PipelineDeps } from "./conversationmodel.ts";
import type { Pipeline } from "./conversation.ts";

// A message waiting in the burst or the queue lives only in memory (conversation.ts), so a crash or restart between "the owner wrote" and "the reply went out" loses it. The
// owner's line is in the log before any of that happens (ownerTurn records first), so at start-up the log tells what was never answered: owner lines younger than
// REPLAY_MINUTES with no reply of the assistant after them. They become ONE turn, with a note that they arrived before a restart. Private chats only (the owner's and
// each friend's): a group message is answered when the gate decides to, and an old one is not worth a late "yes".

// What answers a line: a reply of a turn ("chat") or the notice a failed turn sends ("other"). Unprompted notices, briefs and drafts say nothing about a message of hers.
const ANSWERS: ReadonlySet<string> = new Set(["chat", "other"]);
// A question the assistant had open: the line right after one is most likely its answer ("yes"), which is not a request to run again.
const ASKED: ReadonlySet<string> = new Set(["approval", "draft"]);
const SPOKEN: ReadonlySet<string> = new Set(["chat", "other", "approval", "draft", "notice", "brief"]);
const MAX_REPLAY_LINES = 10;

// Pure: the lines of someone's own (owner, member) that were never answered and are younger than `maxAgeMs`, oldest first. Edits are folded into their original and
// deleted messages are gone (an edit is not a second message; a deleted one must not be acted on). Reactions, the ledger and approval answers are never replayed.
export function unansweredSince(log: readonly Sent[], now: number, maxAgeMs: number = settings.replayMinutes * 60_000): Sent[] {
  if (maxAgeMs <= 0) return [];
  const lines = foldEdits(withoutDeleted(log));
  let from = 0;
  lines.forEach((m, i) => { if (ANSWERS.has(m.kind)) from = i + 1; });
  const out: Sent[] = [];
  let before: Sent | undefined; // the last thing the assistant said before this line
  let answerSeen = false; // the one line right after an open question has been set aside
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!;
    if (SPOKEN.has(m.kind)) (before = m), (answerSeen = false);
    if (i < from || (m.kind !== "owner" && m.kind !== "member")) continue;
    const age = now - Date.parse(m.at);
    if (!(age >= 0 && age <= maxAgeMs)) continue; // too old (or a clock that makes no sense)
    if (before && ASKED.has(before.kind) && !answerSeen) { answerSeen = true; continue; } // the first line after an open question
    out.push(m);
  }
  return out.slice(-MAX_REPLAY_LINES);
}

// The prompt of the replayed turn: the words as they were logged, and why they are late.
export function replayPrompt(lines: readonly Sent[]): string {
  const said = lines.map((m) => `[${m.at}] ${m.text.slice(0, LIMITS.body)}`).join("\n\n");
  return `${lines.length === 1 ? "This message arrived" : `These ${lines.length} messages arrived, oldest first,`} shortly before the assistant restarted and ${lines.length === 1 ? "was" : "were"} never answered. Answer ${lines.length === 1 ? "it" : "them"} now, together if there are several. Say briefly that you are answering late. Before you act, check whether it was already done (the calendar, the mail, your notes): the restart may have come after part of it. If what follows shows the request is stale or already done, say that instead of repeating it.\n\n${said}`;
}

// A tool call that changed something (the permission check logs "allow" for what needs no approval, and the owner's yes as "ask-approved"; a read does not count).
const BUILTIN_READS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"]); // (the SDK's own tools that change nothing)
const DID = new Set(["allow", "auto-approved", "ask-approved", "ask-approved-modified", "covered-by-approval"]);
export const SORRY = "I restarted while working on your last message. Some of it may already be done; tell me if you want me to pick it up again.";

// Pure: did a run of this source act (not just read) since `sinceMs`? The audit rows carry the source (chat: the owner's; group: a group's or a friend's), not the conversation, so for a
// friend this is "anyone's friend-or-group run", which can only make replay hold back more often. If so, re-running the request could do its side effects twice.
export function actedSince(rows: readonly AuditEntry[], source: Source, sinceMs: number): boolean {
  return rows.some((e) => e.source === source && DID.has(e.decision) && Date.parse(e.ts) >= sinceMs && !isReadTool(e.tool) && !BUILTIN_READS.has(e.tool));
}
const auditRows = (source: Source, sinceMs: number): AuditEntry[] => readAudit((e) => e.source === source && Date.parse(e.ts) >= sinceMs);

// The private chats worth looking at: the owner's, and each friend's when TENANTS is on (her own gates still apply in her run).
export function directConversations(): Conversation[] {
  return [owner(), ...(settings.tenants ? listTenants().map((t) => tenant(t.id)) : [])];
}

export interface ReplayDeps {
  pipeline: Pick<Pipeline, "enqueue" | "runTurn">;
  run: PipelineDeps["run"]; // one turn of a private chat (the same function the pipeline runs)
  conversations?: () => Conversation[];
  now?: () => number;
  read?: (conv: Conversation) => readonly Sent[]; // (tests) default: the conversation's log
  tell: (conv: Conversation, text: string) => Promise<unknown>; // one short line to the chat (logged as an answer, so the next start does not repeat it)
  audit?: (source: Source, sinceMs: number) => readonly AuditEntry[]; // (tests) default: logs/audit.jsonl
}

// Queues one turn per private chat that has unanswered lines. Returns how many chats were replayed. Never throws and never waits for the turns.
export function replayUnanswered(deps: ReplayDeps): number {
  let n = 0;
  const now = (deps.now ?? Date.now)();
  for (const conv of (deps.conversations ?? directConversations)()) {
    try {
      const lines = unansweredSince(deps.read ? deps.read(conv) : messagesSince(undefined, conv.logFile), now);
      if (!lines.length) continue;
      const last = lines.at(-1)!;
      console.log(`replay: ${lines.length} unanswered message(s) in ${conv.kind}${conv.tenantId ? ` ${conv.tenantId}` : ""} from before the restart`);
      // The run may have acted (a calendar event, archived mail, a note) before it died: running the request again could do it twice. Then say so instead.
      const since = Date.parse(lines[0]!.at);
      if (actedSince((deps.audit ?? auditRows)(conv.source, since), conv.source, since)) {
        console.log(`replay: ${conv.kind} had acted since its oldest unanswered message; not re-running it`);
        void deps.tell(conv, SORRY).catch((e) => console.error("replay: failed:", (e as Error).message));
        n++;
        continue;
      }
      const prompt = replayPrompt(lines);
      void deps.pipeline
        .enqueue(conv, () =>
          deps.pipeline.runTurn(conv, {
            run: () => deps.run(conv, prompt, lines.map((m) => m.text).join("\n")),
            target: last.by ? { author: last.by, timestamp: last.ts } : undefined,
            announce: true,
          }),
        )
        .catch((e) => console.error("replay: failed:", (e as Error).message));
      n++;
    } catch (e) {
      console.error("replay: could not read a log:", (e as Error).message);
    }
  }
  return n;
}
