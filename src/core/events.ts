import type { Source } from "./audit.ts";
import type { HeartbeatRow } from "./looks.ts";
import { auditSink } from "./sinks/auditsink.ts";
import { journalSink } from "./sinks/journalsink.ts";
import { metricsSink } from "./sinks/metricssink.ts";

// ONE event stream. Everything the assistant does or decides is told once, here, as a typed event, and `emit` fans it out to the sinks. Each sink is a PURE projection (event -> what it
// writes) plus a writer, so the records cannot disagree about what happened:
//   audit    logs/ audit log: the admin's row for every decision and system action (its shapes are the ones `npm run report`, replay.ts and search_logs read; a friend's rows are wordless)
//   journal  the conversation's OWN log: one readable line per ACTION (never a read) with what, why and how to undo it, for "what did you do today, and why?" (a friend's in hers)
//   metrics  instance.db `looks`: one row of counts per heartbeat look
// A new kind of record is a new event type and a line in each sink's projection, not another writer scattered through the code. (Not here: the payments ledger, which is a transactional
// financial record with its own durability, modules/browse/payments.ts; the payment EVENT below is its journal line.)

export { stepOf, type ToolStep } from "./eventstep.ts";

// Why a call was made, as code worked it out (approvals/journalrender.ts): `text` from the run's provenance, the approval or the judge; `reason` only when a structured field of the call itself
// carried the model's own, already cleaned.
export interface Why {
  text: string;
  reason?: string;
  asked?: boolean; // the call was judged or put to a person (not just allowed): a browser step is journalled only then
}

// Where an event belongs: `conv` is the Conversation.key of the conversation it happened in (the owner's chat, a group id, "tenant:<id>"); a friend's rows are wordless in the audit log.
interface Where {
  conv?: string;
  friend?: boolean; // default: conv is a tenant's key
}
type Meta = Record<string, unknown>;

export type Event =
  // A permission decision or a step on the way to one (approvals/permissions.ts, approvalask.ts, approvals.ts, pendingflow.ts). `call` + `why` on the steps that let a call run: the journal keeps them until the call succeeds.
  | ({ type: "tool"; tool: string; decision: string; source: Source; meta?: Meta; call?: { input: Record<string, unknown>; final?: Record<string, unknown> }; why?: Why } & Where)
  // A tool call that SUCCEEDED (the SDK's PostToolUse, run/agentrun.ts): the journal line of an action. `what`, `cat` and `undo` are rendered by code (approvals/journalrender.ts). No audit row: the decision rows say it ran.
  | ({ type: "done"; tool: string; source: Source; input: Record<string, unknown>; what: string; cat: string; undo?: string; why?: Why } & Where)
  // One heartbeat look: the audit row "wake" and the metrics row.
  | ({ type: "look"; row: HeartbeatRow; source: Source } & Where)
  // The nightly dream of a conversation's notes.
  | ({ type: "dream"; result: "changed" | "no-change" | "failed"; source: Source; meta: Meta; text?: string } & Where)
  // A message the assistant had for the person: held for later (quiet hours, the day's limit) or sent.
  | ({ type: "notice"; state: "held" | "sent"; text: string; source: Source } & Where)
  // A card payment changed status (approved, clicked, confirmed, failed, unconfirmed): the journal line of money moving.
  | ({ type: "payment"; status: string; text: string; source: Source } & Where)
  // Something was forgotten or removed (a group's data, a friend's): the audit row, and a line in the OWNER's journal.
  | ({ type: "removal"; tool: string; decision: string; source: Source; meta: Meta; text: string } & Where)
  // Room for the task events (a standing task created, changed, done): audit row and journal line, no producer yet.
  | ({ type: "task"; id: string; state: string; text: string; source: Source } & Where)
  // An audit-only record of something the system did that is no permission decision and no journalled action (a refused send, tenant administration, a compacted session).
  | { type: "record"; tool: string; decision: string; source: Source; meta?: Meta };

export interface Sink {
  readonly name: "audit" | "journal" | "metrics";
  handle(e: Event): void;
}

// The sinks, in order. The audit sink may throw (the permission layer fails closed when its log cannot be written); the others never do, and run even after it has.
const SINKS: readonly Sink[] = [auditSink, journalSink, metricsSink];

export function emit(e: Event): void {
  let failed: unknown;
  let threw = false;
  for (const s of SINKS) {
    try {
      s.handle(e);
    } catch (err) {
      if (s.name === "audit" && !threw) (threw = true), (failed = err);
      else if (s.name !== "audit") console.error(`events: the ${s.name} sink failed (${(err as Error)?.message ?? "error"})`);
    }
  }
  if (threw) throw failed;
}

/** The common case: an audit-only record (tool, decision, source, optional meta). */
export const emitRecord = (tool: string, decision: string, source: Source, meta?: Meta): void => emit({ type: "record", tool, decision, source, ...(meta ? { meta } : {}) });
