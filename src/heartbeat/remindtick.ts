import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import type { Conversation, Pipeline } from "../conversation/conversation.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { doneKey, DROP_AFTER_MS, dueReminders, fallbackText, remindAtAfter, rolledDue, type Planned } from "../tasks/remind.ts";
import { activeItems, editItem, getItem, lineOf, noteReminded, reopenItem, told, type Item, type Scope } from "../tasks/store.ts";
import { classifySendError } from "../conversation/outbound.ts";
import { holdingNow, postNotice } from "./notices.ts";

// The reminder TICK (called from wake.ts for every conversation with tasks): WAKE WITH A REASON. Code decides WHEN, the conversation's next look decides what to do (CLAUDE.md: Ted speaks, code doesn't). A reminder whose
// time has come (the item's own reminder, or a snooze's end) is CLAIMED here (at most once: the `reminders` row and the item's change are one transaction), which makes the conversation's look due at once (look.ts,
// `remindersWaiting`); the look's trigger line names the item and its time (`reminderWhy`) and its prompt carries the facts (`reminderFacts`); the look says it, does it, or finds it covered. When the look
// ended well the claim is settled: journaled ("Reminded about ...") if it spoke, only marked if it chose to stay silent; a failed or called-off look leaves it for the next one.
// The fixed one-line text is ONLY the fallback for "no model run is possible" (CLAUDE.md §4): the conversation has no look, or the model is unavailable now (paused, a cooldown, the day's budget, a refused key: `looks` false).
// Quiet hours and /quiet hold a reminder unless the item is urgent. Repeating items roll here as before.
const HOUR = 3_600_000;
const MAX_TRIES = 3;
const LATE_MS = 30 * 60_000; // a reminder claimed this long after its time counts as late (doctor)
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
 * `looks`: a model run can say its reminders now (wake.ts: the conversation has a look and mayRun allows it); otherwise the fixed fallback line goes at once.
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
  const sc = scopeOf(conv, zone, t);
  const holding = holdingNow(conv, now);
  // The mark and what the item becomes are ONE transaction (at most once). The history row is written here; the journal line only once it was told.
  const claim = (p: Planned, state: "claimed" | "folded"): boolean =>
    db.tx(() => {
      const r = db.run(
        "INSERT INTO reminders (item_id, key, state, fire_at, at, late, tries) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT (item_id, key) DO UPDATE SET state = excluded.state, at = excluded.at, late = excluded.late WHERE state = 'held'",
        p.item.id, p.key, state, p.fireAt, t, state === "folded" || t - p.fireAt > LATE_MS ? 1 : 0,
      );
      if (r.changes === 0) return false; // already claimed (another tick, a restart)
      if (p.kind === "snooze") reopenItem(sc, p.item.id);
      noteReminded(sc, p.item.id, remindAtAfter(p.item, t, zone));
      return true;
    });
  for (const p of dueReminders(items, t, { zone, done })) {
    if (holding && !p.item.urgent) {
      db.run("INSERT OR IGNORE INTO reminders (item_id, key, state, fire_at, at) VALUES (?, ?, 'held', ?, ?)", p.item.id, p.key, p.fireAt, t); // (seen in quiet hours: it waits for them to end)
      continue;
    }
    claim(p, t - p.fireAt >= DROP_AFTER_MS ? "folded" : "claimed"); // (two days late: only marked; the item is open and the brief and the look's due list show it)
  }

  // The fallback, only when no model run is possible (no look, paused, cooldown, budget, key refused): a claimed reminder gets the fixed line, through the conversation's queue like any notice. Quiet hours still hold it.
  let sent = 0;
  const waiting = looks ? [] : db.all<RemRow>("SELECT item_id, key, state, tries, at, fire_at FROM reminders WHERE state IN ('claimed', 'retry') ORDER BY fire_at");
  for (const r of waiting) {
    const it = items.find((i) => i.id === r.item_id);
    if (!it) continue;
    if (holding && !it.urgent) continue;
    const res = await postNotice(pipeline, conv, fallbackText(it, { now: t, zone }));
    // An unsure failure (a timeout, a connection lost mid-send) may have gone out: it counts as told, at most once (outbound.ts). Only a failure that proves nothing went out is tried again.
    if (res.error && classifySendError(res.error, conv.kind === "group") !== "unsure") {
      const tries = r.tries + 1;
      db.run(tries >= MAX_TRIES ? "UPDATE reminders SET state = 'folded', tries = ? WHERE item_id = ? AND key = ?" : "UPDATE reminders SET state = 'retry', tries = ? WHERE item_id = ? AND key = ?", tries, r.item_id, r.key); // (given up: the item stays open, the brief lists it)
      console.error(`reminders: the reminder for #${r.item_id} in ${conv.kind} could not be sent (try ${tries})`);
      continue;
    }
    markTold(conv, [r], t, zone);
    sent++;
  }

  db.run("DELETE FROM reminders WHERE at < ? AND state NOT IN ('claimed', 'retry')", t - KEEP_MS);
  const plannedHeld = new Set(dueReminders(items, t, { zone }).map((p) => doneKey(p.item.id, p.key)));
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

/** After a look that ended (the caller leaves an abandoned one alone: the next look is handed them again): the reminders it was handed are told when it said something (posted, held for later, or sent while it worked); else it judged them covered and they are only marked, not journaled. */
export function afterLook(conv: Pick<Conversation, "key" | "convId">, handed: readonly Waiting[], said: { posted: boolean; held: boolean }, now: number, zone: string): void {
  if (!handed.length) return;
  const db = liveConvDb(conv.convId);
  if (!db) return;
  const told = handed.filter(() => said.posted || said.held);
  markTold(conv, told.map((w) => ({ item_id: w.item.id, key: w.key })), now, zone);
  for (const w of handed) if (!told.includes(w)) db.run("UPDATE reminders SET state = 'folded', ts = COALESCE(ts, ?) WHERE item_id = ? AND key = ? AND state IN ('claimed', 'retry')", now, w.item.id, w.key); // (the look chose to say nothing: nothing was left undone, so no fixed line follows)
}
