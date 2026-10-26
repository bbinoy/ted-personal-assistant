import { peekConvDb } from "../core/convdb.ts";
import type { ConvId } from "../core/convpaths.ts";
import { settings } from "../core/settings.ts";
import { nextDue, nextInstant, parseRepeat } from "./repeat.ts";
import { activeItems, type Item } from "./store.ts";
import { addDays, localOf, parseLocal, showLocal, todayIn, wallToUtc } from "./when.ts";

// REMINDERS ON TIME (docs/ARCHITECTURE.md "Tasks"): the pure part, WHEN. The tick that claims them is heartbeat/remindtick.ts, and the conversation's look says them (CLAUDE.md: Ted speaks, code doesn't).
// On every wake tick each conversation that HAS an assistant.db (none is created) is asked what is due:
//   at       an open item whose remind_at has passed
//   snooze   a snoozed item whose snooze_until has passed: it is open again, and reminded
//   default  an open item with a due date and no reminder of its own: ONE reminder on the morning of the due date at TASK_DEFAULT_REMIND (08:30), in the conversation's zone
// A reminder never acts (SAFETY.md). Too late (48 hours) it is only marked; the item stays open and the look's due list shows it.

const HOUR = 3_600_000;
export const DROP_AFTER_MS = 48 * HOUR;

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
  sentOn?: ReadonlySet<string>; // `${id}|${local date}` of reminders already sent that day: the default ping of that date is then not sent as well
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
  const date = parseLocal(it.due)!.date;
  const key = `due:${date}`;
  if (o.sentOn?.has(`${it.id}|${date}`)) return undefined; // (its own reminder, or a snooze, already told the person today: one ping a day is enough)
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

/** The fixed line of the fallback (no look said it in time, or the conversation has no look): the one place a reminder is code's words. A group names the assignee. */
export function fallbackText(it: Item, o: { now: number; zone: string; group: boolean }): string {
  const who = o.group && it.assignee ? `@${it.assignee}: ` : "";
  const due = duePhrase(it, o.now, o.zone);
  return `⏰ ${who}${it.title}${due ? ` (${due})` : ""}`;
}

/** The reminder and due facts for a look's prompt (heartbeat/look.ts): what is due to be said now, and the open items due or overdue, in the conversation's clock. "" when there is nothing. */
export function reminderFacts(waiting: readonly { item: Item; fireAt: number }[], open: readonly Item[], o: { now: number; zone: string; group: boolean }): string {
  const today = todayIn(o.now, o.zone);
  const at = (ms: number): string => showLocal(`${localOf(ms, o.zone).date}T${localOf(ms, o.zone).time}`, today);
  const tag = (it: Item): string => [o.group && it.assignee ? `for ${it.assignee}` : "", duePhrase(it, o.now, o.zone), it.urgent ? "URGENT: may break quiet hours, set urgent" : ""].filter(Boolean).join("; ");
  const out: string[] = [];
  if (waiting.length) out.push(`Reminders due now (the person asked to be reminded: say each one in your message now, in your own words${o.group ? ", naming who it is for" : ""}; it was due at the time given, so say so if that was a while ago):\n${waiting.map((w) => `#${w.item.id} ${w.item.title} (reminder for ${at(w.fireAt)}${tag(w.item) ? `; ${tag(w.item)}` : ""})`).join("\n")}`);
  const shown = new Set(waiting.map((w) => w.item.id));
  const dueSoon = open.filter((it) => !shown.has(it.id) && it.due && parseLocal(it.due)!.date <= addDays(today, 1)).slice(0, 12);
  if (dueSoon.length) out.push(`Open items due by tomorrow or overdue (for your awareness: mention one only when it helps now and your recent posts did not already):\n${dueSoon.map((it) => `#${it.id} ${it.title} (${tag(it)})`).join("\n")}`);
  return out.join("\n\n");
}

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
  at: number;
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
