import { wordless, writeAuditRow, type Source } from "../audit.ts";
import { isFriendKey } from "../ownerkey.ts";
import type { Event, Sink } from "../events.ts";

// The audit sink: the admin's log of decisions and system actions, in exactly the row shapes `npm run report`, replay.ts (actedSince) and search_logs file=audit read:
// { ts, source, tool, decision, meta? }. A friend's rows carry no words (audit.ts WORDS become their length): the log is the admin's, not hers to put words in; her words go to HER journal.

export interface AuditRow {
  tool: string;
  decision: string;
  source: Source;
  meta?: Record<string, unknown>;
}

const isFriend = (e: { conv?: string; friend?: boolean }): boolean => e.friend ?? (e.conv !== undefined && isFriendKey(e.conv));
const row = (tool: string, decision: string, source: Source, meta: Record<string, unknown> | undefined, friend: boolean): AuditRow => ({ tool, decision, source, ...(meta ? { meta: friend ? wordless(meta) : meta } : {}) });

// Pure: the audit rows an event stands for (none for a success, a notice or a payment: the decision rows already say what ran, and the payments ledger is its own record).
export function project(e: Event): AuditRow[] {
  switch (e.type) {
    case "tool":
      return [row(e.tool, e.decision, e.source, e.meta, isFriend(e))];
    case "look":
      return [row("wake", e.row.outcome, e.source, undefined, false)]; // (a friend's rows carry no words: there are none)
    case "dream":
      return [row("dream_run", e.result, e.source, e.meta, isFriend(e))];
    case "removal":
      return [row(e.tool, e.decision, e.source, e.meta, false)];
    case "task":
      return [row("task", e.state, e.source, { id: e.id }, isFriend(e))];
    case "expired":
      return [row(e.tool, "approval-expired", e.source, { wait: e.wait, label: e.label }, isFriend(e))];
    case "record":
      return [row(e.tool, e.decision, e.source, e.meta, false)];
    default:
      return [];
  }
}

export const auditSink: Sink = {
  name: "audit",
  handle(e) {
    for (const r of project(e)) writeAuditRow(r.tool, r.decision, r.source, r.meta);
  },
};
