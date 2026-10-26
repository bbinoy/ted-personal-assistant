import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import { settings } from "../core/settings.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { doneKey, DROP_AFTER_MS, dueReminders, fallbackText, remindAtAfter, rolledDue, type Planned } from "../tasks/remind.ts";
import { activeItems, editItem, getItem, lineOf, noteReminded, reopenItem, told, type Item, type Scope } from "../tasks/store.ts";
import { localOf } from "../tasks/when.ts";
import { holdingNow, postNotice } from "./notices.ts";

// The reminder TICK (called from wake.ts for every conversation with tasks): code decides WHEN, the conversation's next look says it (CLAUDE.md: Ted speaks, code doesn't). A reminder whose time has
// come is CLAIMED here (at most once: the `reminders` row and the item's change are one transaction), which makes the conversation's look due at once (look.ts, `remindersWaiting`); the look's prompt
// carries it as a fact (`reminderFacts`) and the look says it in its own words. Only when the look has TOLD it (it posted, or sent while it worked) is it marked sent and journaled ("Reminded about ...").
// The fixed one-line text is only the fallback when no model run says it (CLAUDE.md: "a fallback when no model run is possible at all"): the conversation has no look, or FALLBACK_MS after the claim no
// look has told it (paused budget, a cooldown, looks failing). Quiet hours and /quiet hold a reminder unless the item is urgent. Repeating items roll here as before.
const HOUR = 3_600_000;
const MAX_TRIES = 3;
export const FALLBACK_MS = 30 * 60_000;
const KEEP_MS = 90 * 24 * HOUR;

interface RemRow {
  item_id: number;
  key: string;
  state: "held" | "claimed" | "sent" | "retry" | "folded";
  tries: number;
  at: number;
  fire_at: number;
}

const scopeOf = (conv: Pick<Conversation, "key">, zone: string, now: number): Scope => ({ key: conv.key, zone, by: "system", origin: "owner", source: "heartbeat", now, why: { text: "its reminder time came" } });

/** A reminder that was told (by a look, or by the fallback line): the row is sent, and NOW the journal says so (never for a send that failed). */
function markTold(conv: Pick<Conversation, "key" | "convId">, rows: readonly { item_id: number; key: string }[], now: number, zone: string): void {
  const db = liveConvDb(conv.convId);
  if (!db || !rows.length) return;
  for (const r of rows) {
    if (db.run("UPDATE reminders SET state = 'sent', at = ? WHERE item_id = ? AND key = ? AND state IN ('claimed', 'retry')", now, r.item_id, r.key).changes === 0) continue;
    const it = getItem(conv.key, r.item_id);
    if (it) told(scopeOf(conv, zone, now), it.id, "reminded", lineOf("reminded", it, { zone, now }));
  }
}

/**
 * One conversation's reminders for this tick. Never creates a database. Returns how many fallback lines went out (a look's telling is counted by the look). Never throws.
 * `looks`: the conversation has a heartbeat look to say its reminders (wake.ts); without one the fallback line goes at once.
 */
export async function fireReminders(pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, now: Date, o: { looks?: boolean } = {}): Promise<number> {
  try {
    return await fire(pipeline, conv, now, o.looks ?? true);
  } catch (e) {
    console.error(`reminders: ${conv.kind} failed:`, (e as Error).message);
    return 0;
  }
}

async function fire(pipeline: Pick<Pipeline, "enqueue" | "runTurn">, conv: Conversation, now: Date, looks: boolean): Promise<number> {
  const peek = peekConvDb(conv.convId);
  if (!peek) return 0; // (no database yet: nothing to remind, and a tick never makes one)
  const t = now.getTime();
  const zone = zoneOf(conv);
  const items = activeItems(conv.key);
  const db = liveConvDb(conv.convId);
  if (!db) return 0;
  if (!items.length) {
    if (peek.num("SELECT COUNT(*) FROM reminders WHERE state IN ('held', 'retry', 'claimed')")) db.run("DELETE FROM reminders WHERE state IN ('held', 'retry', 'claimed')"); // (nothing is open any more: no mark waits for anything)
    return 0;
  }
  const rows = peek.all<RemRow>("SELECT item_id, key, state, tries, at, fire_at FROM reminders");
  const done = new Set(rows.filter((r) => r.state === "claimed" || r.state === "sent" || r.state === "folded" || r.state === "retry").map((r) => doneKey(r.item_id, r.key)));
  const sentOn = new Set(rows.filter((r) => r.state === "claimed" || r.state === "sent").map((r) => `${r.item_id}|${localOf(r.at, zone).date}`));
  const sc = scopeOf(conv, zone, t);
  const holding = holdingNow(conv, now);
  // The mark and what the item becomes are ONE transaction (at most once). The history row is written here; the journal line only once it was told.
  const claim = (p: Planned, state: "claimed" | "folded"): boolean =>
    db.tx(() => {
      const r = db.run(
        "INSERT INTO reminders (item_id, key, state, fire_at, at, late, tries) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT (item_id, key) DO UPDATE SET state = excluded.state, at = excluded.at, late = excluded.late WHERE state = 'held'",
        p.item.id, p.key, state, p.fireAt, t, state === "folded" || t - p.fireAt > FALLBACK_MS ? 1 : 0,
      );
      if (r.changes === 0) return false; // already claimed (another tick, a restart)
      if (p.kind === "snooze") reopenItem(sc, p.item.id);
      noteReminded(sc, p.item.id, remindAtAfter(p.item, t, zone));
      return true;
    });
  for (const p of dueReminders(items, t, { zone, defaultTime: settings.taskDefaultRemind, done, sentOn })) {
    if (holding && !p.item.urgent) {
      db.run("INSERT OR IGNORE INTO reminders (item_id, key, state, fire_at, at) VALUES (?, ?, 'held', ?, ?)", p.item.id, p.key, p.fireAt, t); // (seen in quiet hours: it waits for them to end)
      continue;
    }
    claim(p, t - p.fireAt >= DROP_AFTER_MS ? "folded" : "claimed"); // (two days late: only marked; the item is open and the brief and the look's due list show it)
  }

  // The fallback: a claimed reminder no look has told in time (or a conversation with no look) gets the fixed line, through the conversation's queue like any notice. Quiet hours still hold it.
  let sent = 0;
  const waiting = db.all<RemRow>("SELECT item_id, key, state, tries, at, fire_at FROM reminders WHERE state IN ('claimed', 'retry') ORDER BY fire_at");
  for (const r of waiting) {
    const it = items.find((i) => i.id === r.item_id);
    if (!it) continue;
    if (looks && t - r.at < FALLBACK_MS) continue; // (its look has the time to say it)
    if (holding && !it.urgent) continue;
    const res = await postNotice(pipeline, conv, fallbackText(it, { now: t, zone, group: conv.kind === "group" }));
    if (res.error) {
      const tries = r.tries + 1;
      db.run(tries >= MAX_TRIES ? "UPDATE reminders SET state = 'folded', tries = ? WHERE item_id = ? AND key = ?" : "UPDATE reminders SET state = 'retry', tries = ? WHERE item_id = ? AND key = ?", tries, r.item_id, r.key); // (given up: the item stays open, the brief lists it)
      console.error(`reminders: the reminder for #${r.item_id} in ${conv.kind} could not be sent (try ${tries})`);
      continue;
    }
    markTold(conv, [r], t, zone);
    sent++;
  }

  db.run("DELETE FROM reminders WHERE at < ? AND state NOT IN ('claimed', 'retry')", t - KEEP_MS);
  const plannedHeld = new Set(dueReminders(items, t, { zone, defaultTime: settings.taskDefaultRemind }).map((p) => doneKey(p.item.id, p.key)));
  for (const r of rows) if (r.state === "held" && !plannedHeld.has(doneKey(r.item_id, r.key))) db.run("DELETE FROM reminders WHERE item_id = ? AND key = ? AND state = 'held'", r.item_id, r.key); // (the item was done, moved or changed meanwhile)
  for (const it of activeItems(conv.key)) {
    const rd = rolledDue(it, t, zone);
    if (rd) editItem(sc, it.id, { due: rd.due, ...(rd.remindAt !== undefined ? { remindAt: rd.remindAt } : {}) });
  }
  return sent;
}

// ---- the look's side ----

export interface Waiting {
  item: Item;
  key: string;
  fireAt: number;
}

/** The reminders claimed and not yet told, for the conversation's look (its fact block). */
export function waitingReminders(conv: Pick<Conversation, "key" | "convId">): Waiting[] {
  const rows = peekConvDb(conv.convId)?.all<RemRow>("SELECT item_id, key, state, tries, at, fire_at FROM reminders WHERE state IN ('claimed', 'retry') ORDER BY fire_at") ?? [];
  return rows.flatMap((r) => {
    const item = getItem(conv.key, r.item_id);
    return item && (item.status === "open" || item.status === "snoozed") ? [{ item, key: r.key, fireAt: r.fire_at }] : [];
  });
}

/** Is a reminder waiting that no look has been handed yet? Then the look is due now (look.ts). One small query. */
export const remindersWaiting = (conv: Pick<Conversation, "convId">): boolean => (peekConvDb(conv.convId)?.num("SELECT COUNT(*) FROM reminders WHERE state = 'claimed' AND ts IS NULL") ?? 0) > 0; // (ts: when a look was first handed it)

/** After a look: the reminders it was handed are told when it said something (posted, or sent while it worked; a held post counts unless the item is urgent); else they wait (the fallback comes). */
export function afterLook(conv: Pick<Conversation, "key" | "convId">, handed: readonly Waiting[], said: { posted: boolean; held: boolean }, now: number, zone: string): void {
  if (!handed.length) return;
  const db = liveConvDb(conv.convId);
  if (!db) return;
  const told = handed.filter((w) => said.posted || (said.held && !w.item.urgent));
  markTold(conv, told.map((w) => ({ item_id: w.item.id, key: w.key })), now, zone);
  for (const w of handed) if (!told.includes(w)) db.run("UPDATE reminders SET ts = COALESCE(ts, ?) WHERE item_id = ? AND key = ? AND state IN ('claimed', 'retry')", now, w.item.id, w.key); // (handed, not said: no new look is started for it; the fallback line comes)
}
