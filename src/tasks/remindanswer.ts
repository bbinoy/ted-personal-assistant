import { peekConvDb } from "../core/convdb.ts";
import { settings } from "../core/settings.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { completeItem, getItem, snoozeItem, TaskError, type Scope } from "./store.ts";
import { addDays, showInstant, todayIn, wallToUtc } from "./when.ts";
import type { IncomingMessage, IncomingReaction, Target } from "@ted-assistant/messenger";

// ANSWERING A REMINDER IN CODE, no model. A reminder message (remind.ts) is remembered by its timestamp (the `reminders` table of assistant.db, so a quote resolves after a restart). Then:
//   a quoted reply of exactly "done" / "✅" / "erledigt" ... or a ✅ / 👍 reaction on it marks the item done (a repeating one moves to its next time);
//   "snooze 1h" / "snooze until 18:00" / "snooze tomorrow" / "later" (one hour) quoting it snoozes the item until then;
//   anything else is not handled here: it goes to the normal chat turn with the reminder quoted, and the model has the task tools.
// Nothing here loops: an ignored reminder is simply an open item (the brief lists it). A reminder that covers several items (a combined morning ping) is ambiguous and is left to the chat.

const DONE = /^(done|did it|finished|completed|erledigt|fertig|gemacht|hecho|fait|ok done|✅|✔️?|☑️?)$/;
const SNOOZE = /^(snooze|later|remind me later|spaeter|später|snooze it)(?:\s+(?:for\s+)?(.+))?$/;
const MAX_CHARS = 40; // a longer reply is a conversation, not an answer
const MAX_SNOOZE_MS = 30 * 86_400_000;

const tidy = (t: string): string => t.normalize("NFKC").toLowerCase().replace(/[.!\s]+$/g, "").replace(/\s+/g, " ").trim();
const strip = (emoji: string): string => emoji.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "");

export type Answer = { kind: "done" } | { kind: "snooze"; until: number };

/** The instant a snooze argument means ("1h", "30 min", "2 days", "until 18:00", "until 6pm", "tomorrow"), or undefined. Pure. */
export function snoozeUntil(arg: string, now: number, zone: string, defaultTime = settings.taskDefaultRemind === "off" ? "09:00" : settings.taskDefaultRemind): number | undefined {
  const a = arg.trim();
  if (!a) return now + 3_600_000;
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(a);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]![0] === "m" ? 60_000 : rel[2]![0] === "h" ? 3_600_000 : 86_400_000;
    const ms = n * unit;
    return ms >= 60_000 && ms <= MAX_SNOOZE_MS ? now + Math.round(ms) : undefined;
  }
  const today = todayIn(now, zone);
  if (a === "tomorrow") return wallToUtc(zone, addDays(today, 1), defaultTime);
  const at = /^(?:until\s+|till\s+|at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(a);
  if (at && (a.includes(":") || a.startsWith("until") || a.startsWith("till") || a.startsWith("at") || at[2] || at[3])) {
    let h = Number(at[1]);
    const m = Number(at[2] ?? 0);
    if (at[3]) {
      if (h < 1 || h > 12) return undefined;
      h = (h % 12) + (at[3] === "pm" ? 12 : 0);
    }
    if (h > 23 || m > 59) return undefined;
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const t = wallToUtc(zone, today, time);
    return t > now ? t : wallToUtc(zone, addDays(today, 1), time);
  }
  return undefined;
}

/** What a reply means as an answer to a reminder, or undefined (a normal message). Pure. */
export function parseAnswer(text: string, now: number, zone: string): Answer | undefined {
  const t = tidy(text);
  if (!t || t.length > MAX_CHARS) return undefined;
  if (DONE.test(t)) return { kind: "done" };
  const s = SNOOZE.exec(t);
  if (!s) return undefined;
  const until = snoozeUntil(s[2] ?? "", now, zone);
  return until === undefined ? undefined : { kind: "snooze", until };
}

export const isDoneReaction = (emoji: string): boolean => ["✅", "👍", "✔", "☑"].includes(strip(emoji));

export interface AnswerDeps {
  out: { reply(text: string, opts?: { plain?: boolean; kind?: "chat" | "notice"; target?: Target }): Promise<number> };
  zone: (conv: Conversation) => string; // the conversation's time zone (tenants/tenants.ts zoneOf)
  now?: () => number;
}
export type ReminderAnswers = ReturnType<typeof createReminderAnswers>;

export function createReminderAnswers(deps: AnswerDeps) {
  const now = deps.now ?? Date.now;
  const say = (conv: Conversation, text: string) => deps.out.reply(text, { plain: true, kind: "chat", ...(conv.target ? { target: conv.target } : {}) });

  // The item a reminder message was about; undefined when the timestamp is no reminder's, or the reminder covered several items.
  const itemOf = (conv: Conversation, ts: number): number | undefined => {
    const ids = peekConvDb(conv.convId)?.all<{ item_id: number }>("SELECT DISTINCT item_id FROM reminders WHERE ts = ?", ts) ?? [];
    return ids.length === 1 ? ids[0]!.item_id : undefined;
  };
  const scope = (conv: Conversation, by: string | undefined): Scope => ({ key: conv.key, zone: deps.zone(conv), by: by || "owner", origin: conv.kind === "group" ? "member" : conv.kind === "tenant" ? "friend" : "owner", source: conv.kind === "group" ? "group" : "chat", now: now(), why: { text: "answered a reminder" } });

  async function apply(conv: Conversation, id: number, a: Answer, by: string | undefined): Promise<boolean> {
    const it = getItem(conv.key, id);
    if (!it) return false;
    if (it.status === "done" || it.status === "dropped") return await say(conv, `“${it.title}” is already ${it.status}.`), true;
    const s = scope(conv, by);
    try {
      if (a.kind === "done") {
        const r = completeItem(s, id);
        return await say(conv, r.next ? `✅ ${it.title}: done. Next: ${r.next.replace("T", " ")}` : `✅ ${it.title}: done.`), true;
      }
      snoozeItem(s, id, a.until);
      return await say(conv, `💤 ${it.title}: back ${showInstant(a.until, s.zone, s.now!)}.`), true;
    } catch (e) {
      if (e instanceof TaskError) return false; // (something the code will not do: the chat turn gets it, with the tools)
      throw e;
    }
  }

  return {
    // A reaction on a reminder: ✅ or 👍 is done. true: dealt with (no chat turn).
    async reaction(conv: Conversation, r: Pick<IncomingReaction, "emoji" | "targetTimestamp" | "isRemove" | "from" | "fromName">): Promise<boolean> {
      if (r.isRemove || !isDoneReaction(r.emoji)) return false;
      try {
        const id = itemOf(conv, r.targetTimestamp);
        return id !== undefined && (await apply(conv, id, { kind: "done" }, r.fromName || r.from));
      } catch (e) {
        console.error("reminders: reaction failed:", (e as Error).message);
        return false;
      }
    },

    // A message that quotes a reminder and says only done / snooze. true: dealt with (no chat turn).
    async message(conv: Conversation, m: Pick<IncomingMessage, "text" | "quote" | "edited" | "image" | "file" | "audio" | "from" | "fromName">): Promise<boolean> {
      if (!m.quote || m.edited || m.image || m.file || m.audio) return false;
      try {
        const a = parseAnswer(m.text, now(), deps.zone(conv));
        if (!a) return false;
        const id = itemOf(conv, m.quote.timestamp);
        return id !== undefined && (await apply(conv, id, a, m.fromName || m.from));
      } catch (e) {
        console.error("reminders: answer failed:", (e as Error).message);
        return false;
      }
    },
  };
}
