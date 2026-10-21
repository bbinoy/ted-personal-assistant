import { emitRecord } from "../core/events.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { DENY_ALL } from "../approvals/permissions.ts";
import type { Pending } from "../approvals/pending.ts";
import { approverName, exactGuard, outcomeOf, pendingPrompt, pendingSystem } from "../approvals/pendingexec.ts";
import { isRefusal, type Payer, type Refusal } from "../tenants/payer.ts";
import { heartbeatOptions } from "./agent.ts";
import { runAgent, type AgentReply, type RunOptions } from "./agentrun.ts";

// The follow-up run of an approved pending action (approvals/pendingflow.ts): a minimal fresh run on the conversation's own tools and login (the heartbeat run's, so the same
// connectors) that makes ONE recorded call. It takes a "look" place in the run gate like any unattended run (rungate.ts), nobody can be asked inside it (DENY_ALL) and its
// permission layer is the exact guard (approvals/pendingexec.ts): the recorded tool with the recorded arguments is allowed, any other call that is not a read is denied.

// The options: the heartbeat run's tools and limits, none of its notes, experts or output format, a short fixed system prompt and the guard.
export function pendingOptions(conv: Conversation, payer: Payer, item: Pick<Pending, "tool" | "input" | "scope"> & { n?: number }, onRan: () => void): RunOptions {
  const base = heartbeatOptions(conv, payer, {});
  const guard = exactGuard(item, base.source);
  return {
    ...base,
    systemPrompt: pendingSystem(approverName(item.scope)),
    notesRead: undefined,
    experts: undefined,
    seenMail: undefined,
    outputFormat: undefined,
    maxTurns: 6,
    maxBudgetUsd: Math.min(base.maxBudgetUsd, 1),
    callGuard: guard,
    provenance: () => ({ kind: "standing", task: pendingPrompt(item, approverName(item.scope)) }),
    onToolSuccess: (tool, input) => void (guard.matches(tool, input) && onRan()),
  };
}

// Run it. `may` is the same gate as a look's (pause, cooldown, budget, a friend's key): refused = the owner is told why, nothing runs.
export async function runPending(conv: Conversation, item: Pending, may: (conv: Conversation, what: string) => Payer | Refusal, io: { run?: (prompt: string, opts: RunOptions) => Promise<AgentReply> } = {}): Promise<{ ran: boolean; line: string; refused?: string }> {
  const payer = may(conv, "approved action");
  if (isRefusal(payer)) return { ran: false, line: `not run now (${payer.refused})`, refused: payer.refused }; // (approved: it waits and is run when the gate allows)
  let ran = false;
  let reply: AgentReply | undefined;
  try {
    reply = await (io.run ?? ((prompt, opts) => runAgent(prompt, DENY_ALL, opts)))(pendingPrompt(item, approverName(item.scope)), pendingOptions(conv, payer, item, () => void (ran = true)));
  } catch (e) {
    emitRecord(item.tool, "pending-run-error", "background", { error: (e as Error)?.name ?? "error" });
    if (!ran) return { ran: false, line: "the follow-up run failed" };
  }
  const o = outcomeOf(ran, reply?.text);
  return { ran, line: o.line };
}
