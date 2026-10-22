import type { IncomingReaction } from "@ted-assistant/messenger";
import { zoneOf } from "../tenants/tenants.ts";
import { parseNumbered } from "../approvals/pendingparse.ts";
import { asksOf, groupTasksReply, settle } from "../tasks/suggest.ts";
import { getItem } from "../tasks/store.ts";
import { isThumbUp } from "./feedback.ts";
import type { SuggestConv } from "../tasks/suggest.ts";
import type { Conversation, Held } from "./conversationmodel.ts";

// The two places a message or a reaction can be about the task list, handled in code before any model (intake.ts calls these as one-line hooks): a reply that quotes the "💡" message of
// suggestions or a 👍 on it (tasks/suggest.ts), and "/tasks" said in a group (the owner's and a friend's /tasks is ownercommands.ts; a group has no other command). true: handled here.
export async function taskReply(conv: Conversation, m: Pick<Held, "text" | "quote" | "fromName" | "picture" | "document" | "edit">, say: (text: string) => Promise<unknown>): Promise<boolean> {
  if (m.picture || m.document || m.edit) return false; // a caption or an edit never answers
  const zone = zoneOf(conv);
  const listed = conv.kind === "group" ? groupTasksReply(conv, m.text, zone) : undefined;
  if (listed !== undefined) return void (await say(listed)), true;
  return answerSuggestions(conv, m.text, m.quote, { say, who: m.fromName, zone });
}

export const taskReaction = (conv: Conversation, r: Pick<IncomingReaction, "emoji" | "targetTimestamp" | "isRemove" | "fromName">, say: (text: string) => Promise<unknown>): Promise<boolean> => reactSuggestions(conv, r, { say, who: r.fromName, zone: zoneOf(conv) });

// ---- answering the "💡" message (the tasks folder holds the message and the store calls; the grammar of the answer is the approval inbox's) ----

export interface Answerer {
  say(text: string): Promise<unknown>;
  who?: string; // the member who answered (a group); the owner and a friend are themselves
  zone: string;
  now?: number;
}

/**
 * A reply that quotes a suggestions message. true: it was an answer (said back, the message is not also a chat turn). A reply that is not in the answer grammar ("1 yes, but make it Friday") is an
 * ordinary message (false); a bare yes / 👍 means all of them, a bare no is only clear for a single suggestion.
 */
export async function answerSuggestions(conv: SuggestConv, text: string, quote: { timestamp: number } | undefined, a: Answerer): Promise<boolean> {
  if (!quote || quote.timestamp === 0) return false;
  const asks = asksOf(conv.key, quote.timestamp);
  if (!asks.length) return false;
  const now = a.now ?? Date.now();
  const nums = asks.map((x) => x.n);
  const parsed = parseNumbered(text, nums, nums);
  const how = "a reply to the suggestions I listed";
  const o = { who: a.who, zone: a.zone, now, how };
  try {
    if (parsed.kind === "none") return false;
    if (parsed.kind === "clarify") return void (await a.say(parsed.why)), true;
    if (parsed.kind === "bare") {
      if (parsed.yes) return void (await a.say(settle(conv, asks, nums, [], o))), true;
      if (asks.length === 1) return void (await a.say(settle(conv, asks, [], nums, o))), true;
      return void (await a.say("Which ones? Say e.g. '1 no' or 'all no'; nothing was done.")), true;
    }
    return void (await a.say(settle(conv, asks, parsed.yes, parsed.no, o))), true;
  } catch (e) {
    console.error("suggestions: could not apply the answer:", (e as Error).message);
    return void (await a.say("I could not do that just now (it is logged).").catch(() => undefined)), true;
  }
}

/** A 👍 on a suggestions message confirms every suggestion it listed that is still waiting. true: it was one (no chat turn for it). Other emoji and removed reactions are not answers here. */
export async function reactSuggestions(conv: SuggestConv, r: { emoji: string; targetTimestamp: number; isRemove?: boolean }, a: Answerer): Promise<boolean> {
  if (r.isRemove || !isThumbUp(r.emoji)) return false;
  const asks = asksOf(conv.key, r.targetTimestamp);
  if (!asks.length) return false;
  const nums = asks.map((x) => x.n);
  const waiting = asks.filter((x) => getItem(conv.key, x.id)?.status === "suggested");
  if (!waiting.length) return true; // answered already: a second 👍 is not news (and not a chat turn)
  try {
    await a.say(settle(conv, asks, nums, [], { who: a.who, zone: a.zone, now: a.now ?? Date.now(), how: "a 👍 on the suggestions I listed" }));
  } catch (e) {
    console.error("suggestions: could not apply the 👍:", (e as Error).message);
  }
  return true;
}

