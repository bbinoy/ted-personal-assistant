import { emitRecord } from "../core/events.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { DENY_ALL } from "../approvals/permissions.ts";
import { approverName } from "../approvals/pendingexec.ts";
import { batchGuard, shadowPrompt, shadowSystem } from "../approvals/shadowexec.ts";
import { isRefusal, type Payer, type Refusal } from "../tenants/payer.ts";
import { heartbeatOptions } from "./agent.ts";
import { runAgent, type AgentReply, type RunOptions } from "./agentrun.ts";

// The follow-up run of archives the person approved in the gentle first week (approvals/shadow.ts): one small fresh run on the conversation's own tools and login (the heartbeat run's, so the same
// connectors) that makes the recorded calls and nothing else. It takes a "look" place in the run gate like any unattended run (rungate.ts), nobody can be asked inside it (DENY_ALL) and its
// permission layer is the batch guard (approvals/shadowexec.ts). It has NO shadow gate: this is the approved execution, not a look.

type Call = { tool: string; input: Record<string, unknown> };
const MAX_CALLS = 60;

export function shadowRunOptions(conv: Conversation, payer: Payer, calls: readonly Call[], onRan: (i: number) => void): RunOptions {
  const base = heartbeatOptions(conv, payer, {});
  const guard = batchGuard(calls, base.source);
  const name = approverName(conv.key);
  return {
    ...base,
    systemPrompt: shadowSystem(name),
    notesRead: undefined,
    experts: undefined,
    seenMail: undefined,
    outputFormat: undefined,
    maxTurns: Math.min(MAX_CALLS + 6, calls.length + 6),
    maxBudgetUsd: Math.min(base.maxBudgetUsd, 2),
    callGuard: guard,
    provenance: () => ({ kind: "standing", task: shadowPrompt(calls, name) }),
    onToolSuccess: (tool, input) => {
      const i = guard.indexOf(tool, input);
      if (i >= 0) onRan(i);
    },
  };
}

/** Run them. `may` is the same gate as a look's (pause, cooldown, budget, a friend's key): refused = nothing runs and `refused` says why. */
export async function runShadow(conv: Conversation, calls: readonly Call[], may: (conv: Conversation, what: string) => Payer | Refusal, io: { run?: (prompt: string, opts: RunOptions) => Promise<AgentReply> } = {}): Promise<{ ran: boolean[]; refused?: string }> {
  const ran = calls.map(() => false);
  if (calls.length === 0 || calls.length > MAX_CALLS) return { ran };
  const payer = may(conv, "approved archives");
  if (isRefusal(payer)) return { ran, refused: payer.refused };
  try {
    await (io.run ?? ((prompt, opts) => runAgent(prompt, DENY_ALL, opts)))(shadowPrompt(calls, approverName(conv.key)), shadowRunOptions(conv, payer, calls, (i) => void (ran[i] = true)));
  } catch (e) {
    emitRecord("shadow", "run-error", "background", { error: (e as Error)?.name ?? "error" });
  }
  return { ran };
}
