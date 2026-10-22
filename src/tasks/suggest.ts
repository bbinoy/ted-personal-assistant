import type { Source } from "../core/audit.ts";
import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { convIdOfKey } from "../core/convpaths.ts";
import { parseNumbered } from "../approvals/pendingparse.ts";
import { isThumbUp } from "../conversation/feedback.ts";
import { settings } from "../core/settings.ts";
import { confirmSuggestion, listItems, rejectSuggestion, TaskError, getItem, type Item, type Scope } from "./store.ts";
import { suggestionsText, tasksText } from "./render.ts";
import { showLocal, todayIn } from "./when.ts";

// Suggestions, one tap: what an unattended look noticed (a mail with a request or a deadline, a promise the person made, something someone owes them) is only ever a `suggested` item (store.ts).
// At the end of a look (heartbeat/look.ts) the ones not yet shown go out as ONE message, "💡 1. ... 2. ...", and which message listed which items is written down here (suggestion_asks in the
// conversation's assistant.db). Then CODE, not a model, reads the answer: a 👍 on that message confirms all it listed, a reply that quotes it ("1 yes", "2 no", "all yes", read by the
// approval inbox's grammar, pendingparse.ts) confirms and drops the ones named; anything else is an ordinary message. In a group any member's 👍 or reply counts. A suggestion nobody answers is
// dropped after SUGGESTION_DAYS with the history row `rejected` by `expiry` (never deleted; the same mail is not suggested again). Only an answer to the message can make a suggestion real: a
// mail, an event or a group member's words cannot (docs/SAFETY.md).

/** What the sender of the message is to the conversation (main.ts sets it): send a message in the chat and learn its timestamp, and whether the conversation is being left alone now. */
export interface SuggestRuntime {
  send(conv: SuggestConv, text: string): Promise<number>;
  holding(conv: SuggestConv, now: Date): boolean; // quiet hours or /quiet: the message waits (the items stay unasked and go out with the next look)
}
let rt: SuggestRuntime | undefined;
export const setSuggestRuntime = (r: SuggestRuntime | undefined): void => void (rt = r);

/** The parts of a Conversation this file needs. */
export interface SuggestConv {
  readonly kind: "owner" | "group" | "tenant";
  readonly key: string;
  readonly convId: string;
  readonly tenantId?: string;
}

const MAX_LISTED = 9; // one message lists at most this many (the rest go out with the next one)
const KEEP_ASKS_MS = 60 * 86_400_000;

const originOf = (c: SuggestConv): Scope["origin"] => (c.kind === "owner" ? "owner" : c.kind === "tenant" ? "friend" : "member");
const sourceOf = (c: SuggestConv): Source => (c.kind === "group" ? "group" : "chat");

/** The person-side scope for a confirm or reject made by a reply: who said it, in the conversation's clock. */
function scopeOf(c: SuggestConv, who: string | undefined, zone: string, now: number, why: string): Scope {
  return { key: c.key, zone, by: c.kind === "owner" ? "owner" : c.kind === "tenant" ? "friend" : (who?.trim() || "a member"), origin: originOf(c), source: sourceOf(c), now, why: { text: why } };
}

// ---- the message ----

/** One line of the message: "Reply to Rebecca re budget (due Fri)", with who owes whom for the two other kinds. */
export function suggestionLine(it: Item, now: number, zone: string): string {
  const bits: string[] = [];
  if (it.kind === "owed_to_me") bits.push(it.person ? `${it.person} owes you` : "owed to you");
  else if (it.kind === "i_owe") bits.push(it.person ? `you owe ${it.person}` : "you owe");
  if (it.assignee) bits.push(`for ${it.assignee}`);
  if (it.due) bits.push(`due ${showLocal(it.due, todayIn(now, zone))}`);
  return `${it.title}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

/** The whole message. A group is told that any member's 👍 counts. */
export function suggestionMessage(items: readonly Item[], now: number, zone: string, group: boolean): string {
  const from = [...new Set(items.map((i) => i.sourceKind))].filter((k) => k !== "message");
  const head = `💡 ${items.length === 1 ? "One thing" : `${items.length} things`} I noticed${from.length ? ` (${from.join(", ")})` : ""}:`;
  const tap = items.length === 1 ? (group ? "👍 from anyone to add it, or reply 'no'." : "👍 to add it, or reply 'no'.") : `${group ? "👍 from anyone" : "👍"} to add all, or reply '1 yes', '2 no'.`;
  return [head, ...items.map((it, i) => `${i + 1}. ${suggestionLine(it, now, zone)}`), "", tap].join("\n");
}

const askedIds = (convId: string): Set<number> => new Set((peekConvDb(convId)?.all<{ item_id: number }>("SELECT DISTINCT item_id FROM suggestion_asks") ?? []).map((r) => r.item_id));

/** Suggestions nobody has been shown yet, oldest first. */
export function unasked(key: string): Item[] {
  const shown = askedIds(convIdOfKey(key));
  return listItems(key, { status: "suggested", limit: 200 }, 0).filter((i) => !shown.has(i.id)).sort((a, b) => a.id - b.id);
}

// ---- expiry ----

/** Suggestions older than SUGGESTION_DAYS are dropped as `rejected` by `expiry` (the item stays in the history). Returns how many. */
export function expireSuggestions(key: string, now: number, zone = "UTC"): number {
  const db = peekConvDb(convIdOfKey(key));
  if (!db) return 0; // (nothing was ever stored: no file is made for the question)
  const cutoff = now - settings.suggestionDays * 86_400_000;
  const old = db.all<{ id: number }>("SELECT id FROM items WHERE status = 'suggested' AND created_at < ?", cutoff);
  let n = 0;
  for (const { id } of old) {
    try {
      rejectSuggestion({ key, zone, by: "expiry", origin: "owner", source: "background", now, why: { text: `nobody answered the suggestion within ${settings.suggestionDays} days` } }, id);
      n++;
    } catch (e) {
      if (!(e instanceof TaskError)) console.error(`suggestions: could not expire #${id}: ${(e as Error).message}`);
    }
  }
  return n;
}

// ---- offering ----

/**
 * After a look: expire what is old, then tell the person the suggestions they have not seen, as ONE message, and write down which items it listed. In quiet hours (or /quiet) nothing is
 * sent and the items stay unasked, so the next look after it offers them. Never throws (the look is over; a failed send is tried again at the next look).
 */
export async function offerSuggestions(conv: SuggestConv, now: Date, zone: string): Promise<"sent" | "held" | "none"> {
  try {
    expireSuggestions(conv.key, now.getTime(), zone);
    const items = unasked(conv.key).slice(0, MAX_LISTED);
    if (!items.length || !rt) return "none";
    if (rt.holding(conv, now)) return "held";
    const ts = await rt.send(conv, suggestionMessage(items, now.getTime(), zone, conv.kind === "group"));
    const db = liveConvDb(convIdOfKey(conv.key));
    if (!db) return "none";
    db.tx(() => {
      items.forEach((it, i) => db.run("INSERT OR REPLACE INTO suggestion_asks (msg_ts, n, item_id, at) VALUES (?, ?, ?, ?)", ts, i + 1, it.id, now.getTime()));
      db.run("DELETE FROM suggestion_asks WHERE at < ?", now.getTime() - KEEP_ASKS_MS);
    });
    return "sent";
  } catch (e) {
    console.error("suggestions: could not offer:", (e as Error).message);
    return "none";
  }
}

// ---- answering ----

interface Ask {
  n: number;
  id: number;
}
const asksOf = (key: string, ts: number): Ask[] => peekConvDb(convIdOfKey(key))?.all<{ n: number; item_id: number }>("SELECT n, item_id FROM suggestion_asks WHERE msg_ts = ? ORDER BY n", ts).map((r) => ({ n: r.n, id: r.item_id })) ?? [];

/** Does this message list suggestions? (a reply quoting it, or a reaction on it, is an answer) */
export const isSuggestionMessage = (key: string, ts: number): boolean => asksOf(key, ts).length > 0;

/** Confirm or drop the named items; each one that is no longer a suggestion (answered in chat meanwhile, expired) is left alone. The reply says what happened. */
function settle(conv: SuggestConv, asks: readonly Ask[], yes: readonly number[], no: readonly number[], o: { who?: string; zone: string; now: number; how: string }): string {
  const sc = scopeOf(conv, o.who, o.zone, o.now, o.how);
  const said: string[] = [];
  const gone: string[] = [];
  const stale: number[] = [];
  const pick = (ns: readonly number[]) => ns.map((n) => asks.find((a) => a.n === n)).filter((a): a is Ask => !!a);
  for (const a of pick(yes)) {
    try {
      const r = confirmSuggestion(sc, a.id);
      said.push(r.item.title);
    } catch (e) {
      if (e instanceof TaskError) stale.push(a.n);
      else throw e;
    }
  }
  for (const a of pick(no)) {
    try {
      gone.push(rejectSuggestion(sc, a.id).item.title);
    } catch (e) {
      if (e instanceof TaskError) stale.push(a.n);
      else throw e;
    }
  }
  const out = [said.length ? `✅ Added: ${said.join("; ")}.` : "", gone.length ? `Dropped: ${gone.join("; ")}.` : "", stale.length ? `${stale.map((n) => `#${n}`).join(", ")} ${stale.length === 1 ? "was" : "were"} already handled.` : ""].filter(Boolean);
  return out.join(" ") || "Nothing to do.";
}

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

// ---- groups: /tasks ----

/** "/tasks" and "/tasks suggestions" said in a group: read-only, answered from the group's own list, in code (no model, no cost). undefined: not the command. Any member may ask. */
export function groupTasksReply(conv: SuggestConv, text: string, zone: string, now = Date.now()): string | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (conv.kind !== "group" || (t !== "/tasks" && t !== "/tasks suggestions")) return undefined;
  return (t === "/tasks" ? tasksText : suggestionsText)(conv.key, now, zone);
}

// ---- groups: "remind me" ----

export const GROUP_REMINDER_NOTE = "Saved for the group. For a private reminder, message me directly.";

/** Said once per member: a reminder asked for in a group is the group's task (everyone sees it), not a private one. Returns the sentence the first time for this member, then undefined. Persisted. */
export function groupReminderNote(key: string, member: string, now: number): string | undefined {
  const db = liveConvDb(convIdOfKey(key));
  if (!db) return undefined;
  const name = member.trim().slice(0, 80) || "a member";
  const r = db.run("INSERT OR IGNORE INTO group_remind_noted (member, at) VALUES (?, ?)", name, now);
  return r.changes > 0 ? GROUP_REMINDER_NOTE : undefined;
}
