import { createHash } from "node:crypto";

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

export const forgetShown = (conv: string): void => void told.delete(conv);
