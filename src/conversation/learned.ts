import { commitBatch, learnedMessage, planBatch } from "../memory/learned.ts";
import type { Conversation } from "./conversationmodel.ts";

// "What I learned overnight" for a friend (she has no daily brief; the owner's list is a section of the brief, the `memory_changes_since_brief` tool): after her dream, and at each look after it, ONE short
// message with what the dream and the background looks changed in her notes, if anything (memory/learned.ts). Quiet hours and /quiet hold it (the changes stay untold and go out with the next look),
// and an empty list says nothing. Like the suggestions message (tasks/suggest.ts) the sender is main.ts's, so this file never imports the messenger. A group has none.

export interface LearnedRuntime {
  send(conv: Conversation, text: string): Promise<number>; // the message's timestamp: a reply that quotes it answers for its numbers
  holding(conv: Conversation, now: Date): boolean;
}
let rt: LearnedRuntime | undefined;
export const setLearnedRuntime = (r: LearnedRuntime | undefined): void => void (rt = r);

// Who is owed a list because her dream finished while she was left alone (held): the looks that follow try again. Without it a look offers only when a dream change is waiting, so an inferred
// note saved at noon is not announced at noon: it goes out after the next dream.
const owed = new Set<string>();

/** Tells a friend what changed in her notes since the last list. `afterDream`: her dream just ran (always offers); otherwise (a look) only what a dream left, or an earlier hold, is offered. Never throws (a failed send leaves the changes untold). */
export async function offerLearned(conv: Conversation, now: Date, o: { afterDream?: boolean } = {}): Promise<"sent" | "held" | "none"> {
  if (conv.kind !== "tenant" || !rt) return "none";
  try {
    const batch = planBatch(conv.convId, conv.notesDir, now.getTime());
    if (!batch) return "none";
    if (!o.afterDream && !owed.has(conv.convId) && !batch.items.some((i) => i.source === "dream")) return "none";
    if (batch.items.length && rt.holding(conv, now)) return owed.add(conv.convId), "held";
    owed.delete(conv.convId);
    if (!batch.items.length) return commitBatch(conv.convId, batch, now.getTime()), "none"; // (only changes that no longer hold)
    const ts = await rt.send(conv, learnedMessage(batch.items));
    commitBatch(conv.convId, batch, now.getTime(), ts);
    return "sent";
  } catch (e) {
    console.error("learned: could not tell:", (e as Error).message);
    return "none";
  }
}
