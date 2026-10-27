import { readAudit, type AuditEntry, type Source } from "../core/audit.ts";
import { isReadTool } from "../policy/policy.ts";
import { foldEdits, kindIs, messagesSince, withoutDeleted, type Sent } from "../core/messages.ts";
import { settings } from "../core/settings.ts";
import { auditSource } from "../core/runkind.ts";
import { LIMITS } from "../core/sanitize.ts";
import { listTenants } from "../tenants/tenants.ts";
import { group, owner, tenant, type Conversation } from "./conversationmodel.ts";
import { listGroups } from "./groupstore.ts";
import type { Pipeline } from "./conversation.ts";

// A message waiting in the burst or the queue lives only in memory (conversation.ts), so a crash or restart between "the owner wrote" and "the reply went out" loses it. The
// line is in the log before any of that happens (the intake records first), so at start-up the log tells what was never answered: lines of the owner, a friend or a group member younger than
// REPLAY_MS with no reply of the assistant after them. They go through the SAME intake again (intake.ts replay), from the burst on, with a note that they arrived before a restart.
// A private chat answers them as one turn. A group answers only the lines the log says were addressed to the assistant, or when the gate, asked again on the tail, says act; untagged chatter
// stays as unanswered as it would have been. Never an approval answer, an edit or a deleted message (below), and never a second run of something that may have been done already.

// What answers a line (a reply of a turn, or the notice a failed turn sends), what is a question the assistant had open (the line right after one is most likely its answer, "yes", which is
// not a request to run again) and what the assistant said at all: the kinds' properties `answers`, `asks` and `said` (core/messages.ts). Unprompted notices and briefs say nothing about a message of hers.
const MAX_REPLAY_LINES = 10;
const REPLAY_MS = 30 * 60_000; // at start, an owner or friend message younger than this that was never answered (the restart lost it) is answered now

// Pure: the lines of someone's own (owner, member) that were never answered and are younger than `maxAgeMs`, oldest first. Edits are folded into their original and
// deleted messages are gone (an edit is not a second message; a deleted one must not be acted on). Reactions, the ledger and approval answers are never replayed.
export function unansweredSince(log: readonly Sent[], now: number, maxAgeMs: number = REPLAY_MS): Sent[] {
  if (maxAgeMs <= 0) return [];
  const lines = foldEdits(withoutDeleted(log));
  let from = 0;
  lines.forEach((m, i) => { if (kindIs(m.kind, "answers")) from = i + 1; });
  const out: Sent[] = [];
  let before: Sent | undefined; // the last thing the assistant said before this line
  let answerSeen = false; // the one line right after an open question has been set aside
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!;
    if (kindIs(m.kind, "said")) (before = m), (answerSeen = false);
    if (i < from || !kindIs(m.kind, "inbound")) continue;
    const age = now - Date.parse(m.at);
    if (!(age >= 0 && age <= maxAgeMs)) continue; // too old (or a clock that makes no sense)
    if (before && kindIs(before.kind, "asks") && !answerSeen) { answerSeen = true; continue; } // the first line after an open question
    out.push(m);
  }
  return out.slice(-MAX_REPLAY_LINES);
}

// The prompt of a private chat's replayed turn: the words as they were logged, and why they are late.
export function replayPrompt(lines: readonly { at: string; text: string }[]): string {
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

// Every conversation worth looking at: the owner's, each friend's when TENANTS is on (her own gates still apply in her run) and every group we know.
export function replayConversations(): Conversation[] {
  return [owner(), ...(settings.tenants ? listTenants().map((t) => tenant(t.id)) : []), ...listGroups().map((g) => group(g.id))];
}

export interface ReplayDeps {
  pipeline: Pick<Pipeline, "replay">;
  conversations?: () => Conversation[];
  now?: () => number;
  read?: (conv: Conversation) => readonly Sent[]; // (tests) default: the conversation's log
  tell: (conv: Conversation, text: string) => Promise<unknown>; // one short line to the chat (logged as an answer, so the next start does not repeat it)
  audit?: (source: Source, sinceMs: number) => readonly AuditEntry[]; // (tests) default: logs/audit.jsonl
}

// Puts what each conversation lost back through the intake (pipeline.replay: the burst, the answer decision, the turn). Returns how many conversations had something to replay. Never throws
// and never waits for the turns.
export function replayUnanswered(deps: ReplayDeps): number {
  let n = 0;
  const now = (deps.now ?? Date.now)();
  for (const conv of (deps.conversations ?? replayConversations)()) {
    try {
      const lines = unansweredSince(deps.read ? deps.read(conv) : messagesSince(undefined, conv.logFile), now);
      if (!lines.length) continue;
      console.log(`replay: ${lines.length} unanswered message(s) in ${conv.kind}${conv.tenantId ? ` ${conv.tenantId}` : ""} from before the restart`);
      // The run may have acted (a calendar event, archived mail, a note) before it died: running the request again could do it twice. Then say so instead (to someone who was waiting).
      const since = Date.parse(lines[0]!.at);
      const source = auditSource({ who: conv.kind, attended: true });
      const acted = actedSince((deps.audit ?? auditRows)(source, since), source, since);
      if (acted) console.log(`replay: ${conv.kind} had acted since its oldest unanswered message; not re-running it`);
      void deps.pipeline
        .replay(conv, lines, acted ? () => deps.tell(conv, SORRY) : undefined)
        .catch((e) => console.error("replay: failed:", (e as Error).message));
      n++;
    } catch (e) {
      console.error("replay: could not read a log:", (e as Error).message);
    }
  }
  return n;
}
