import { appendLine, readText } from "../core/state.ts";

// The heartbeat run's own record: one row per look of any conversation in state/heartbeat.jsonl, counts and flags only. NEVER a message's words, a sender, a subject or a
// friend's name or id: what was said is in the conversation's log, and `npm run heartbeat-report` needs only these numbers.

export const HEARTBEAT_LOG = "state/heartbeat.jsonl";

export interface HeartbeatRow {
  at: string; // ISO: when the look began
  kind?: "owner" | "group" | "tenant"; // whose look (absent in older rows: the owner's)
  night: boolean; // inside the quiet window (for the report; the model, not code, decides how quiet to be)
  message: boolean; // something was said in the conversation: the final answer or a piece sent while it worked
  sent?: number; // pieces sent with the send tool while the run worked (the final answer is not counted); absent in older rows
  nextCheckMinutes: number; // the next look it chose, clamped
  costUsd: number;
  toolCalls: number; // tool calls that ran (the run's own and its subagents')
  archived: number; // mail archived in this look
  delegations: number; // experts it called (heartbeat/delegation.ts); their cost is in costUsd (the SDK's total includes subagents)
  outcome: "posted" | "silent" | "failed" | "preempted"; // preempted: a message to the conversation overtook the look and it was called off (conversation.ts lease)
}

export const appendRow = (row: HeartbeatRow, file: string = HEARTBEAT_LOG): void => appendLine(file, JSON.stringify(row));

// Every readable row, oldest first; a torn or foreign line is skipped.
export function readRows(file: string = HEARTBEAT_LOG): HeartbeatRow[] {
  const out: HeartbeatRow[] = [];
  for (const line of (readText(file) ?? "").split("\n")) {
    try {
      const r = JSON.parse(line) as HeartbeatRow;
      if (typeof r.at === "string" && Number.isFinite(Date.parse(r.at))) out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}
