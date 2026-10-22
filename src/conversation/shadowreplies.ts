import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingReaction } from "@ted-assistant/messenger";
import { convDb } from "../core/convdb.ts";
import { settings } from "../core/settings.ts";
import { answerShadow, latestProposal, listedBy, reactShadow, type Listed } from "../approvals/shadow.ts";
import { messagesSince } from "../core/messages.ts";
import { parseShadowReply } from "../approvals/shadowparse.ts";
import { hasOpen } from "../approvals/approvals.ts";
import { waitingCount } from "../approvals/pendingflow.ts";
import { dreamScope } from "../modules/memory/dreamscope.ts";
import { checkProposal, isThumbDown, isThumbUp, offerText } from "./feedback.ts";
import type { Conversation, Held } from "./conversationmodel.ts";

// The two places a message or a reaction can answer a shadow-mode proposal (approvals/shadow.ts: "I'd archive these 14"), handled in code before any model (intake.ts calls these as one-line hooks,
// like taskreplies.ts): a reply that quotes the proposal ("3,5 keep", "yes", "no") and a 👍 / 👎 on it. true: handled here (no chat turn for it). When mail was left in the inbox, the person is offered
// ONE triage note made from it, through the feedback machinery (feedback.ts): it is saved only by her 👍 on the offer, like every note the assistant proposes.

type Say = (text: string) => Promise<unknown>;
const RIGHT_AFTER_MS = 30 * 60_000; // an unquoted answer counts as about the proposal for this long

const BARE_YES = /(?:^|[^a-z])(?:yes|y|yep|yeah|yup|ok|okay|sure|approve|confirm|do|go|ahead)(?:[^a-z]|$)|👍|✅/i;
const VERB = /(?:^|[^a-z])(?:keep|archive)(?:[^a-z]|$)/i;
const NOT_ASSISTANT = new Set(["owner", "reaction", "member"]);

function unquotedTarget(conv: Conversation, text: string, now: number): number | undefined {
  if (!VERB.test(text) || BARE_YES.test(text) || hasOpen(conv.key) || waitingCount(conv.key) > 0) return undefined;
  const ts = latestProposal(conv.key, now, RIGHT_AFTER_MS);
  if (ts === undefined) return undefined;
  const lastSaid = messagesSince(undefined, conv.logFile).filter((e) => !NOT_ASSISTANT.has(e.kind)).reduce((mx, e) => Math.max(mx, e.ts), 0);
  if (lastSaid > ts) return undefined;
  const p = parseShadowReply(text, listedBy(conv.key, ts).length);
  return p.kind === "none" || p.kind === "clarify" ? undefined : ts;
}

export async function shadowReply(conv: Conversation, m: Pick<Held, "text" | "quote" | "picture" | "document" | "edit">, say: Say, now: number = Date.now()): Promise<boolean> {
  if (m.picture || m.document || m.edit) return false; // a caption or an edit never answers
  const quoted = m.quote && m.quote.timestamp !== 0 ? m.quote.timestamp : undefined;
  // An unquoted reply ("3,5 keep") straight after the proposal is about it, unless something else is open to be answered (a question, the approval inbox): otherwise the chat model would
  // read the numbers and rebuild the archive calls itself, outside the exact replay.
  // An unquoted reply counts only as the proposal's own grammar, and only while the proposal is the LAST thing the assistant said here (a reply to anything else is about that): it must say "keep" or
  // "archive" ("archive all", "3,5 keep", "keep all", "all except 2 archive"); a bare "all" / "no" / "none" / "yes" is ordinary chat, and a half-understood one is left to the chat, never answered with a clarify.
  const ts = quoted ?? unquotedTarget(conv, m.text, now);
  if (ts === undefined) return false;
  const done = answerShadow(conv, m.text, ts);
  if (!done) return false;
  await say(done.reply);
  await offerKeep(conv, done.kept, ts, say);
  return true;
}

export async function shadowReaction(conv: Conversation, r: Pick<IncomingReaction, "emoji" | "targetTimestamp"> & { isRemove?: boolean }, say: Say): Promise<boolean> {
  if (r.isRemove || (!isThumbUp(r.emoji) && !isThumbDown(r.emoji))) return false;
  const done = reactShadow(conv, isThumbUp(r.emoji), r.targetTimestamp);
  if (!done) return false;
  await say(done.reply);
  await offerKeep(conv, done.kept, r.targetTimestamp, say);
  return true;
}

// One note from what she left in the inbox, written by CODE from the SENDER ADDRESSES of the mail (subjects and display names are written by strangers and never go into a note), offered with the
// feedback machinery's own text and recorded as one of its offers, so her 👍 (or a quoted yes) on it saves it as hers (origin: owner) and a 👎 drops it. It counts toward FEEDBACK_OFFERS_PER_DAY.
// Not in a group, not when offers are off or used up, not when the conversation has no triage notes, not when no sender address can be read from the lines.
const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
export const senderAddresses = (kept: readonly Listed[]): string[] => [...new Set(kept.flatMap((k) => ADDRESS.exec(k.line.slice(k.line.lastIndexOf(" from ") + 6))?.[0].toLowerCase() ?? []))].slice(0, 3);

async function offerKeep(conv: Conversation, kept: readonly Listed[], batchTs: number, say: Say): Promise<void> {
  try {
    const senders = senderAddresses(kept);
    if (!senders.length || conv.kind === "group" || settings.feedbackOffersPerDay <= 0) return;
    const db = convDb(conv.convId);
    if ((db.get<{ n: number }>("SELECT COUNT(*) AS n FROM feedback_offers WHERE state != 'none' AND at > ?", Date.now() - 86_400_000)?.n ?? 0) >= settings.feedbackOffersPerDay) return;
    const categories = dreamScope(conv).categories;
    const file = `triage-kept-${new Date().toISOString().slice(0, 10)}.md`;
    const description = "Mail kept in the inbox when archiving was proposed";
    const text = `Keep in the inbox, do not archive mail from: ${senders.join(", ")}.`;
    if (!checkProposal({ propose: true, file, description, text }, { categories, sources: [text, description] })) return; // (the same check the confirm step makes: a category this conversation has, a short line)
    const ts = await say(offerText({ file, description, text }, existsSync(join(conv.notesDir, file))));
    if (typeof ts === "number") db.run("INSERT INTO feedback_offers (on_ts, offer_ts, state, file, description, body, at) VALUES (?, ?, 'offered', ?, ?, ?, ?)", batchTs, ts, file, description, text, Date.now());
  } catch (e) {
    console.error("shadow: could not offer a note:", (e as Error).message);
  }
}
