import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { tailEntries } from "../core/messages.ts";
import { settings } from "../core/settings.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { combinedText, doneKey, dueReminders, judgeLate, remindAtAfter, reminderText, rolledDue, type Planned } from "../tasks/remind.ts";
import { activeItems, editItem, noteReminded, reopenItem, type Scope } from "../tasks/store.ts";
import { localOf, showLocal, todayIn } from "../tasks/when.ts";
import { holdingNow, holdLine, postNotice } from "./notices.ts";

// The reminder TICK (called from wake.ts for every conversation): claims what tasks/remind.ts plans as due, sends each as a notice of its own, and rolls repeating items. See remind.ts for the rules.
const HOUR = 3_600_000;
const MAX_TRIES = 3;
const MAX_SEPARATE_DEFAULTS = 3; // more default pings than this in one tick are ONE message ("Due today: ...")
const KEEP_MS = 90 * 24 * HOUR;

interface RemRow {
  item_id: number;
  key: string;
  state: "held" | "claimed" | "sent" | "retry" | "folded";
  tries: number;
  at: number;
}

const scopeOf = (conv: Conversation, zone: string, now: number): Scope => ({ key: conv.key, zone, by: "system", origin: "owner", source: "heartbeat", now, why: { text: "its reminder time came" } });

/** The ts of the notice just sent (the message a quote or a reaction will point at): found in the conversation's log, since the delivery does not hand it back. */
function sentTs(conv: Conversation, text: string, since: number): number | undefined {
  const all = tailEntries(conv.logFile); // (the end of the log: what was just appended)
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    if (e.kind === "notice" && e.text === text && Date.parse(e.at) >= since - 2000) return e.ts;
  }
  return undefined;
}

/**
 * One conversation's reminders for this tick. Never creates a database. Returns how many messages went out. Never throws.
 * `pipeline`: the notice goes through the conversation's queue like the heartbeat's (postNotice). Quiet hours and /quiet hold it back unless the item is urgent.
 */
export async function fireReminders(pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, now: Date): Promise<number> {
  try {
    return await fire(pipeline, conv, now);
  } catch (e) {
    console.error(`reminders: ${conv.kind} failed:`, (e as Error).message);
    return 0;
  }
}

async function fire(pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, now: Date): Promise<number> {
  const peek = peekConvDb(conv.convId);
  if (!peek) return 0; // (no database yet: nothing to remind, and a tick never makes one)
  const t = now.getTime();
  const zone = zoneOf(conv);
  const items = activeItems(conv.key);
  if (!items.length) {
    if (peek.num("SELECT COUNT(*) FROM reminders WHERE state IN ('held', 'retry')")) liveConvDb(conv.convId)?.run("DELETE FROM reminders WHERE state IN ('held', 'retry')"); // (nothing is open any more: no mark waits for anything)
    return 0;
  }
  const rows = peek.all<RemRow>("SELECT item_id, key, state, tries, at FROM reminders");
  const done = new Set(rows.filter((r) => r.state === "claimed" || r.state === "sent" || r.state === "folded").map((r) => doneKey(r.item_id, r.key)));
  const excused = new Map(rows.filter((r) => r.state === "held" || r.state === "retry").map((r) => [doneKey(r.item_id, r.key), r]));
  const sentOn = new Set(rows.filter((r) => r.state === "claimed" || r.state === "sent").map((r) => `${r.item_id}|${localOf(r.at, zone).date}`));
  const sc = scopeOf(conv, zone, t);
  const group = conv.kind === "group";
  const holding = holdingNow(conv, now);
  const send: { p: Planned; text: string; late: boolean }[] = [];
  const db = liveConvDb(conv.convId);
  if (!db) return 0;
  const row = (p: Planned, state: RemRow["state"], late: boolean) =>
    db.run(
      "INSERT INTO reminders (item_id, key, state, fire_at, at, late) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (item_id, key) DO UPDATE SET state = excluded.state, at = excluded.at, late = excluded.late WHERE state IN ('held', 'retry')",
      p.item.id, p.key, state, p.fireAt, t, late ? 1 : 0,
    );
  // The mark and what the item becomes are ONE transaction, before the send (at most once).
  const claim = (p: Planned, state: "claimed" | "folded", late: boolean): boolean =>
    db.tx(() => {
      if (row(p, state, late).changes === 0) return false; // already claimed (another tick, a restart)
      if (p.kind === "snooze") reopenItem(sc, p.item.id);
      noteReminded(sc, p.item.id, remindAtAfter(p.item, t, zone));
      return true;
    });

  const plan = dueReminders(items, t, { zone, defaultTime: settings.taskDefaultRemind, done, sentOn });
  for (const p of plan) {
    if (holding && !p.item.urgent) {
      db.run("INSERT OR IGNORE INTO reminders (item_id, key, state, fire_at, at) VALUES (?, ?, 'held', ?, ?)", p.item.id, p.key, p.fireAt, t); // (seen in quiet hours: its delay is excused)
      continue;
    }
    const v = judgeLate(p.fireAt, t, excused.has(doneKey(p.item.id, p.key)));
    if (v === "drop" || v === "fold") {
      if (!claim(p, "folded", true)) continue;
      if (v === "fold") holdLine(conv, `${reminderText(p.item, { now: t, zone, group })} (was due ${showLocal(`${localOf(p.fireAt, zone).date}T${localOf(p.fireAt, zone).time}`, todayIn(t, zone))})`, now);
      continue;
    }
    send.push({ p, text: reminderText(p.item, { now: t, zone, group, missed: v === "missed" }), late: v === "missed" });
  }

  // Several default pings at once are one message (a morning with six tasks due is not six buzzes); everything else is a message of its own.
  const defaults = send.filter((s) => s.p.kind === "default" && !s.late);
  const combine = defaults.length > MAX_SEPARATE_DEFAULTS;
  const groups: { text: string; ps: { p: Planned; late: boolean }[] }[] = [];
  if (combine) groups.push({ text: combinedText(defaults.map((d) => d.p.item), { now: t, zone, group }), ps: defaults });
  for (const s of send) if (!(combine && defaults.includes(s))) groups.push({ text: s.text, ps: [s] });

  let sent = 0;
  for (const g of groups) {
    const claimed = g.ps.filter((x) => claim(x.p, "claimed", x.late));
    if (!claimed.length) continue;
    const res = await postNotice(pipeline, conv, g.text);
    if (res.error) {
      for (const x of claimed) release(db, conv, sc, x.p, zone, t); // not sent: given back, tried again next tick (3 times at most)
      continue;
    }
    const ts = sentTs(conv, g.text, t);
    for (const x of claimed) db.run("UPDATE reminders SET state = 'sent', ts = ? WHERE item_id = ? AND key = ?", ts ?? null, x.p.item.id, x.p.key);
    sent++;
  }

  db.run("DELETE FROM reminders WHERE at < ?", t - KEEP_MS);
  const planned = new Set(plan.map((p) => doneKey(p.item.id, p.key)));
  for (const r of rows) if ((r.state === "held" || r.state === "retry") && !planned.has(doneKey(r.item_id, r.key))) db.run("DELETE FROM reminders WHERE item_id = ? AND key = ? AND state IN ('held', 'retry')", r.item_id, r.key); // (the item was done, moved or changed meanwhile: the mark no longer means anything)
  for (const it of activeItems(conv.key)) {
    const r = rolledDue(it, t, zone);
    if (r) editItem(sc, it.id, { due: r.due, ...(r.remindAt !== undefined ? { remindAt: r.remindAt } : {}) });
  }
  return sent;
}

// A send that failed outright: the mark is undone (the item's remind_at back, the row 'retry') unless it has been tried enough.
function release(db: NonNullable<ReturnType<typeof liveConvDb>>, conv: Conversation, sc: Scope, p: Planned, _zone: string, t: number): void {
  const tries = (db.get<{ tries: number }>("SELECT tries FROM reminders WHERE item_id = ? AND key = ?", p.item.id, p.key)?.tries ?? 0) + 1;
  if (tries >= MAX_TRIES || p.kind === "snooze") return void db.run("UPDATE reminders SET tries = ? WHERE item_id = ? AND key = ?", tries, p.item.id, p.key); // (given up: it stays marked; the item is open and the brief lists it)
  db.tx(() => {
    db.run("UPDATE reminders SET state = 'retry', tries = ?, at = ? WHERE item_id = ? AND key = ?", tries, t, p.item.id, p.key);
    if (p.item.remindAt !== undefined) noteReminded(sc, p.item.id, p.item.remindAt);
  });
  console.error(`reminders: the reminder for #${p.item.id} in ${conv.kind} could not be sent (try ${tries})`);
}

