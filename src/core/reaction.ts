import { fence } from "./fence.ts";
import { OWNER } from "./settings.ts";

// The model may answer with an emoji reaction on the owner's message instead of (or before) a text,
// for acknowledgements that need no words: thanks, ok, a joke that landed. It writes
// "[[react: 👍]]" at the very start of its reply. Pure and strict: exactly one emoji, only at the
// start, so ordinary text can never be mistaken for it.

const MARK = /^\s*\[\[react:\s*([^\]]{1,16}?)\s*\]\]\s*/;

export const isOneEmoji = (s: string) => {
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)];
  return parts.length === 1 && /\p{Extended_Pictographic}/u.test(s);
};

// { reaction, text }: the emoji to react with (if any) and what remains to be said.
export function splitReaction(reply: string): { reaction?: string; text: string } {
  const m = MARK.exec(reply);
  if (!m || !isOneEmoji(m[1]!)) return { text: reply };
  return { reaction: m[1]!, text: reply.slice(m[0].length).trim() };
}

// What the owner said by reacting, for the approval judge's provenance: the reaction itself, never the text of the message it is on.
export const reactionMessage = (emoji: string): string => `${OWNER} reacted ${emoji}`;

// The prompt for a reaction the owner put on a message: what they reacted with, and the message
// (from the message log; it is fenced because it may quote mail). It carries no instruction on
// what to do: the model judges, and the owner's notes can tune it.
export function reactionPrompt(emoji: string, msg?: { at: string; kind: string; text: string }): string {
  const about = msg
    ? `to this message of yours (${msg.kind}, sent ${msg.at.slice(0, 16).replace("T", " ")} UTC):\n${fence("reacted_message", msg.text)}`
    : "to a message that is no longer in your log (or to one of their own).";
  return `${reactionMessage(emoji)} ${about}`;
}
