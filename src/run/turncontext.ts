import { createHash } from "node:crypto";
import type { Conversation } from "../conversation/conversationmodel.ts";

// What a conversation's session has been told at the start of a turn (runoptions.ts turnContext: what is connected, the last brief, the recent notices, a friend's
// mail digest). The block is part of the message, so it stays in the session's history: telling it again every turn would grow the context by a brief per message.
// So it is told when the session has not seen this exact text yet: the first turn after a restart, a fresh or compacted session, or a change. Kept in memory,
// per conversation; being wrong only costs one repetition.
const told = new Map<string, { session: string; hash: string }>();
const hashOf = (text: string) => createHash("sha1").update(text).digest("hex");

// The text to put in front of the message, or undefined when the session (`session`: the one this turn resumes) was already told exactly this.
export function unseen(conv: string, session: string | undefined, text: string | undefined): string | undefined {
  if (!text) return undefined;
  const seen = told.get(conv);
  return session && seen && seen.session === session && seen.hash === hashOf(text) ? undefined : text;
}

// The turn went through: the session (as it is saved after the turn) has the text.
export function markShown(conv: string, session: string | undefined, text: string): void {
  if (session) told.set(conv, { session, hash: hashOf(text) });
  else told.delete(conv);
}

// What the chat session was told is kept under the conversation's id, with its facts, status and notes under suffixes.
export const forgetShown = (conv: string): void => void [conv, `${conv}:facts`, `${conv}:status`, `${conv}:notes`].forEach((k) => told.delete(k));

// The facts a run is handed besides its message (heartbeat/facts.ts factsFor, set once at start by heartbeat/wiring.ts: the run folder cannot import the heartbeat one). `blocks` are claimed and
// delivered once, `status` is information; both are told to a chat session only when they differ from what it was last told (unseen / markShown, under their own keys).
export interface TurnFacts {
  blocks: string[];
  status: string[];
  untrusted: boolean; // a block quotes a third party's words (a task made from mail): the session is marked as having read untrusted text
  done(end: { ended: boolean; said: boolean; abandoned: boolean }): void; // the turn is over: settle what it was handed (said: the reply carried words)
}
let provider: ((conv: Conversation, now: Date) => TurnFacts) | undefined;
export const turnFactsFrom = (fn: typeof provider): void => void (provider = fn);
export const turnFacts = (conv: Conversation, now: Date): TurnFacts | undefined => provider?.(conv, now);

// Did a turn's reply say something to the person? [[silent]] and a bare reaction ([[react: 👍]]) say nothing, and so tell nothing.
export const spoke = (text: string): boolean => text.replace(/\[\[(silent|react:[^\]]*)\]\]/gi, "").trim() !== "";
