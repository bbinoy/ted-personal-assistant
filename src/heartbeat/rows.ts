import { instanceDb } from "../core/instancedb.ts";

// The heartbeat run's own record: one row per look of any conversation in the `looks` table of instance.db, counts and flags only. NEVER a message's words, a sender, a subject or a
// friend's name or id: what was said is in the conversation's log, and `npm run heartbeat-report` needs only these numbers. (Layout 2 kept them in heartbeat.jsonl with two rotated
// generations; the table is bounded by age instead: retention prunes it, pruneLooks.)

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

// Never throws: a look's record is a nicety, and the look's next wake-up must still be scheduled after it (look.ts). A number that is not finite (a cost the SDK did not report) is 0, said in the log.
const finite = (x: number, what: string): number => {
  if (Number.isFinite(x)) return x;
  console.error(`heartbeat: ${what} was ${x}; recorded as 0`);
  return 0;
};
export function appendRow(row: HeartbeatRow): void {
  try {
    insertRow({ ...row, costUsd: finite(row.costUsd, "a look's cost"), nextCheckMinutes: finite(row.nextCheckMinutes, "a look's next check"), toolCalls: finite(row.toolCalls, "tool calls"), archived: finite(row.archived, "archived"), delegations: finite(row.delegations, "delegations") });
  } catch (e) {
    console.error(`heartbeat: could not record the look (${(e as Error).message})`);
  }
}
function insertRow(row: HeartbeatRow): void {
  const at = Date.parse(row.at);
  instanceDb().run(
    "INSERT INTO looks (at, at_ms, kind, night, message, sent, next_check_minutes, cost_usd, tool_calls, archived, delegations, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.at, Number.isFinite(at) ? at : Date.now(), row.kind ?? "owner", row.night ? 1 : 0, row.message ? 1 : 0, row.sent ?? null, row.nextCheckMinutes, row.costUsd, row.toolCalls, row.archived, row.delegations, row.outcome,
  );
}

interface LookRow {
  at: string; kind: string; night: number; message: number; sent: number | null; next_check_minutes: number; cost_usd: number; tool_calls: number; archived: number; delegations: number; outcome: string;
}
const COLUMNS = "at, kind, night, message, sent, next_check_minutes, cost_usd, tool_calls, archived, delegations, outcome";
const toRow = (r: LookRow): HeartbeatRow => ({
  at: r.at, kind: r.kind as HeartbeatRow["kind"], night: r.night === 1, message: r.message === 1, ...(r.sent !== null ? { sent: r.sent } : {}),
  nextCheckMinutes: r.next_check_minutes, costUsd: r.cost_usd, toolCalls: r.tool_calls, archived: r.archived, delegations: r.delegations, outcome: r.outcome as HeartbeatRow["outcome"],
});

// Every row, oldest first (or those of the last `days`).
export function readRows(days?: number, now = Date.now()): HeartbeatRow[] {
  const db = instanceDb();
  return (days === undefined ? db.all<LookRow>(`SELECT ${COLUMNS} FROM looks ORDER BY id`) : db.all<LookRow>(`SELECT ${COLUMNS} FROM looks WHERE at_ms >= ? ORDER BY id`, now - days * 86_400_000)).map(toRow);
}

/** When the newest look of any conversation began, or undefined (the doctor). */
export const lastLookAt = (): string | undefined => instanceDb().get<{ at: string }>("SELECT at FROM looks ORDER BY id DESC LIMIT 1")?.at;

/** Retention: looks older than `days`. Returns how many went. */
export const pruneLooks = (days: number, now = Date.now()): number => instanceDb().run("DELETE FROM looks WHERE at_ms < ?", now - Math.max(1, days) * 86_400_000).changes;
