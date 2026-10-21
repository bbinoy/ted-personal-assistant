import type { Extra, Kind } from "../core/messages.ts";
import { cleanIncoming, group, owner, tenant, type Batch, type Conversation, type Incoming, type PipelineDeps } from "./conversationmodel.ts";
import { createDelivery } from "./delivery.ts";
import { createIntake } from "./intake.ts";
import { createQueue } from "./queue.ts";

// The conversation model lives in conversationmodel.ts; these are re-exported for the modules and tests that import them from here.
export { cleanIncoming, group, owner, tenant, type Batch, type Conversation, type Incoming };

// The one pipeline every conversation goes through: the owner's private chat and each group. What differs
// between them is DATA on a Conversation, and a Conversation is made only by owner(), group(id) and tenant(id), so trust
// cannot be mixed up by building one by hand. What is the same is the code: read receipt, voice message in,
// record, run, [[voice]] / [[react]] / [[silent]], quote threading, typing, error notice, one turn at a time.
// A burst of messages is one turn in both (burst below): a short settling pause, then everything that arrived is answered together.
//   owner   its own chat with the assistant; the full toolset (policy source "chat"); approvals exist; always answered
//   group   one group chat; no private data (policy source "group"); the participation gate decides (group.ts)
//   tenant  a friend's private chat (tenants.ts): the owner's turn path, the group's isolation, her own folder and API key


// The pipeline is three small factories composed here: queue.ts (burst, one turn at a time, the look's lease), delivery.ts (typing, the reply, notices, one run) and
// intake.ts (what arrives: edits, deletes, reactions, commands, approval answers). Each owns its own state and takes what it needs explicitly.
export function createPipeline(deps: PipelineDeps) {
  const queue = createQueue(deps);
  const delivery = createDelivery(deps);
  const { handleIncoming } = createIntake(deps, queue, delivery);
  const { enqueue, busy, lease, burst, burstQueued, wait, dropPending } = queue;
  const { holdTyping, runTurn, sendWhile, canSpeak, reactTo, warn } = delivery;
  const record = (conv: Conversation, kind: Kind, ts: number, text: string, extra?: Extra) => deps.record(conv.target, kind, ts, text, extra);

  // `react`: a quick reaction of our own, no run needed (the gate chose it).
  return { handleIncoming, enqueue, busy, lease, burst, burstQueued, wait, holdTyping, runTurn, sendWhile, record, canSpeak, react: reactTo, warn, dropPending };
}

export type Pipeline = ReturnType<typeof createPipeline>;
