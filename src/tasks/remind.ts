import { peekConvDb } from "../core/convdb.ts";
import type { ConvId } from "../core/convpaths.ts";
import { settings } from "../core/settings.ts";
import { nextDue, nextInstant, parseRepeat } from "./repeat.ts";
import { activeItems, type Item } from "./store.ts";
import { addDays, localOf, parseLocal, showLocal, todayIn, wallToUtc } from "./when.ts";

// REMINDERS ON TIME (docs/ARCHITECTURE.md "Tasks"): the pure part. The tick that sends them is heartbeat/remindtick.ts. Code only, no model: on every wake tick (heartbeat/wake.ts) each conversation that HAS an assistant.db (none is created) is asked what is due:
//   at       an open item whose remind_at has passed
//   snooze   a snoozed item whose snooze_until has passed: it is open again, and reminded
//   default  an open item with a due date and no reminder of its own: ONE ping on the morning of the due date at TASK_DEFAULT_REMIND (08:30), in the conversation's zone
// Each is ONE short message of its own ("⏰ Call Sam (due today)"; in a group "⏰ @Anna: ferry tickets (due today)"), sent as a notice. It is a message only: a reminder never acts (SAFETY.md).
// The quiet window and /quiet hold it (it goes out when they end, plain: the delay was asked for) unless the item is urgent; it is NOT an unprompted post (the person asked for it): it does not count toward
// MAX_UNPROMPTED_PER_DAY and is never merged into the digest. It is at-most-once: the `reminders` row (UNIQUE per item and key) and the item's new remind_at are written in ONE transaction BEFORE the send, so a
// restart or a second tick cannot send it twice; the price is that a crash between the mark and the send loses it (the item stays open, so the brief lists it). A send that fails outright is released and
// retried up to 3 times. Too late: under a tick it is plain; up to 12 hours it says "(missed while I was off)"; up to 48 hours it becomes a line of the next digest; older is only marked (the brief shows it).

const HOUR = 3_600_000;
export const MISSED_AFTER_MS = 12 * HOUR;
export const DROP_AFTER_MS = 48 * HOUR;
export const tolerance = (): number => Math.max(10, 2 * settings.heartbeatMinutes) * 60_000; // ~a tick or two: on time

export type Kind = "at" | "default" | "snooze";
export interface Planned {
  item: Item;
  kind: Kind;
  key: string; // the reminder's identity for this item: at:<remind_at>, due:<date>, snooze:<until>
  fireAt: number; // UTC ms: when it was meant to go
}
export interface PlanOptions {
  zone: string;
  defaultTime: string | "off"; // "08:30"
  done?: ReadonlySet<string>; // `${id}|${key}` of reminders already claimed, sent or folded
}

export const doneKey = (id: number, key: string): string => `${id}|${key}`;

/** When the default ping of this item's due date goes: the default time that morning (or the due time if that is earlier), in the due's zone. Undefined: no default ping for it. */
export function defaultFireAt(it: Item, o: Pick<PlanOptions, "zone" | "defaultTime">): number | undefined {
  const p = it.due ? parseLocal(it.due) : undefined;
  if (!p || o.defaultTime === "off" || it.remindAt !== undefined) return undefined;
  const time = p.time && p.time < o.defaultTime ? p.time : o.defaultTime;
  return wallToUtc(it.dueZone ?? o.zone, p.date, time);
}

/** The reminder an item is owed at `now`, if any (one per item: its own reminder, then a snooze's end, then the default morning ping). Pure. */
function planOne(it: Item, now: number, o: PlanOptions): Planned | undefined {
  const done = (key: string) => o.done?.has(doneKey(it.id, key)) ?? false;
  if (it.status === "snoozed") {
    if (it.snoozeUntil === undefined || it.snoozeUntil > now) return undefined;
    const key = `snooze:${it.snoozeUntil}`;
    return done(key) ? undefined : { item: it, kind: "snooze", key, fireAt: it.snoozeUntil };
  }
  if (it.status !== "open") return undefined;
  if (it.remindAt !== undefined) {
    const key = `at:${it.remindAt}`;
    return it.remindAt <= now && !done(key) ? { item: it, kind: "at", key, fireAt: it.remindAt } : undefined;
  }
  const at = defaultFireAt(it, o);
  if (at === undefined || at > now || now - at >= DROP_AFTER_MS || it.updatedAt > at) return undefined; // (touched after that morning: the person just dealt with it, a "missed" ping would be wrong)
  const key = `due:${parseLocal(it.due)!.date}`;
  return done(key) ? undefined : { item: it, kind: "default", key, fireAt: at };
}

export const dueReminders = (items: readonly Item[], now: number, o: PlanOptions): Planned[] => items.flatMap((it) => planOne(it, now, o) ?? []).sort((a, b) => a.fireAt - b.fireAt || a.item.id - b.item.id);

/** The next reminder to go (for /status): the soonest of the items' own reminders, snooze ends and default pings still ahead. */
export function nextReminder(items: readonly Item[], now: number, o: PlanOptions): { at: number; item: Item } | undefined {
  let best: { at: number; item: Item } | undefined;
  for (const it of items) {
    const at = it.status === "snoozed" ? it.snoozeUntil : it.status === "open" ? (it.remindAt ?? defaultFireAt(it, o)) : undefined;
    if (at === undefined || at <= now) continue;
    if (it.status === "open" && it.remindAt === undefined && o.done?.has(doneKey(it.id, `due:${parseLocal(it.due)!.date}`))) continue;
    if (!best || at < best.at) best = { at, item: it };
  }
  return best;
}

export type Verdict = "ok" | "missed" | "fold" | "drop";
/** How late a reminder is, in what it may say. `excused`: it was held by quiet hours (or retried), so the delay was asked for. Pure. */
export function judgeLate(fireAt: number, now: number, excused: boolean, tol = tolerance()): Verdict {
  const late = now - fireAt;
  if (late >= DROP_AFTER_MS) return "drop";
  if (late >= MISSED_AFTER_MS) return "fold";
  return excused || late <= tol ? "ok" : "missed";
}

// ---- the words ----

/** "due today" / "due tomorrow" / "due Fri 24 Oct 14:30" / "was due Wed 21 Oct". */
function duePhrase(it: Item, now: number, zone: string): string {
  const p = it.due ? parseLocal(it.due) : undefined;
  if (!p) return "";
  const today = todayIn(now, zone);
  if (p.date === today) return `due today${p.time ? ` ${p.time}` : ""}`;
  if (p.date === addDays(today, 1)) return `due tomorrow${p.time ? ` ${p.time}` : ""}`;
  return `${p.date < today ? "was due" : "due"} ${showLocal(it.due!, today)}`;
}

/** The one short message. A group names the assignee (the reminder is for them). */
export function reminderText(it: Item, o: { now: number; zone: string; group: boolean; missed?: boolean }): string {
  const who = o.group && it.assignee ? `@${it.assignee}: ` : "";
  const due = duePhrase(it, o.now, o.zone);
  return `⏰ ${who}${it.title}${due ? ` (${due})` : ""}${o.missed ? " (missed while I was off)" : ""}`;
}
export const combinedText = (items: readonly Item[], o: { now: number; zone: string; group: boolean }): string => `⏰ Due today: ${items.map((it) => `${o.group && it.assignee ? `@${it.assignee} ` : ""}${it.title}`).join("; ")}`;

// ---- what an item does after it has fired ----

const wall = (it: Item, due: string, zone: string): number => {
  const p = parseLocal(due)!;
  return wallToUtc(it.dueZone ?? zone, p.date, p.time ?? "00:00");
};

/** The item's remind_at after a reminder fired at `now`: unchanged when it is still ahead; cleared for a one-off; the next occurrence for a repeating item (one live item, never a pile of copies). */
export function remindAtAfter(it: Item, now: number, zone: string): number | null {
  if (it.remindAt === undefined) return null;
  if (it.remindAt > now) return it.remindAt;
  const rule = it.repeat ? parseRepeat(it.repeat) : undefined;
  if (!rule?.ok) return null;
  if (it.due) return wall(it, nextDue(rule.rule, it.due, todayIn(now, zone)), zone) + (it.remindAt - wall(it, it.due, zone)); // the reminder keeps its distance from the due
  const at = localOf(it.remindAt, zone);
  return nextInstant(rule.rule, Math.max(now, it.remindAt), zone, at.date, at.time); // (a rule without a time of its own keeps the reminder's clock time)
}

/** A repeating item whose due DAY is over moves to its next due (its reminder with it): the missed occurrence stays in the history, the list shows one item. Returns the new due, or undefined. */
export function rolledDue(it: Item, now: number, zone: string): { due: string; remindAt?: number } | undefined {
  if (it.status !== "open" || !it.repeat || !it.due) return undefined;
  const p = parseLocal(it.due)!;
  const today = todayIn(now, zone);
  if (p.date >= today) return undefined;
  const rule = parseRepeat(it.repeat);
  if (!rule.ok) return undefined;
  const due = nextDue(rule.rule, it.due, today);
  if (it.remindAt === undefined) return { due };
  const moved = wall(it, due, zone) + (it.remindAt - wall(it, it.due, zone));
  return { due, ...(it.remindAt < moved ? { remindAt: moved } : {}) };
}

interface RemRow {
  item_id: number;
  key: string;
  state: "held" | "claimed" | "sent" | "retry" | "folded";
  tries: number;
}

/** For /status: when the next reminder goes, in words ("Fri 24 Oct 08:30 (#3 Call Sam)"), or undefined when none is scheduled. */
export function nextReminderText(key: string, convId: ConvId, now: number, zone: string): string | undefined {
  const db = peekConvDb(convId);
  if (!db) return undefined;
  const done = new Set(db.all<RemRow>("SELECT item_id, key, state, tries FROM reminders WHERE state IN ('claimed', 'sent', 'folded')").map((r) => doneKey(r.item_id, r.key)));
  const n = nextReminder(activeItems(key), now, { zone, defaultTime: settings.taskDefaultRemind, done });
  if (!n) return undefined;
  const l = localOf(n.at, zone);
  return `${showLocal(`${l.date}T${l.time}`, todayIn(now, zone))} (#${n.item.id} ${n.item.title.slice(0, 40)})`;
}
