import { addedByLooks, counts, dueClass, effectiveStatus, listItems, type Item } from "./store.ts";
import { parseLocal, showInstant, showLocal, todayIn } from "./when.ts";

// How tasks are SHOWN, always in the conversation's own clock: one item as a compact line (the tool replies and lists), and the phone-sized /tasks answer. Pure over the store's reads.

const KIND_TAG = { task: "", i_owe: "I owe", owed_to_me: "waiting on" } as const;

/** "Fri 24 Oct 14:30" for a due; on the day itself just the time ("14:30") or "today". */
function dueText(it: Item, now: number, zone: string, short = false): string {
  const p = it.due ? parseLocal(it.due) : undefined;
  if (!p) return "";
  const today = todayIn(now, zone);
  if (short && p.date === today) return p.time ?? "today";
  return showLocal(it.due!, today);
}

/** One item for a model or a list: "#4 [task] Call Sam | due Fri 24 Oct 14:30 | with Sam | remind Thu 23 Oct 09:00 | repeats every monday | from mail". */
export function itemLine(it: Item, now: number, zone: string): string {
  const parts = [`#${it.id} [${it.kind}] ${it.title}`];
  const due = dueText(it, now, zone);
  if (due) parts.push(`due ${due}${dueClass(it, now, zone) === "overdue" ? " (overdue)" : ""}`);
  if (it.person) parts.push(it.kind === "i_owe" ? `owed to ${it.person}` : it.kind === "owed_to_me" ? `owed by ${it.person}` : `with ${it.person}`);
  if (it.assignee) parts.push(`for ${it.assignee}`);
  if (it.remindAt !== undefined) parts.push(`remind ${showInstant(it.remindAt, zone, now)}`);
  if (it.repeat) parts.push(`repeats ${it.repeat}`);
  const status = effectiveStatus(it, now);
  if (status === "snoozed" && it.snoozeUntil !== undefined) parts.push(`snoozed until ${showInstant(it.snoozeUntil, zone, now)}`);
  else if (status !== "open") parts.push(status);
  if (it.sourceKind === "mail" || it.sourceKind === "meeting") parts.push(`from ${it.sourceKind}`);
  return parts.join(" | ");
}

/** What a mutation tool tells back after its first line: the resolved dates in the conversation's clock, so the model can see what its words became and correct them. */
export function echoLines(it: Item, now: number, zone: string): string {
  const out: string[] = [];
  if (it.due) out.push(`Due: ${dueText(it, now, zone)} (${it.due}, ${it.dueZone ?? zone})`);
  if (it.remindAt !== undefined) out.push(`Reminder: ${showInstant(it.remindAt, zone, now)} (${zone})`);
  if (it.repeat) out.push(`Repeats: ${it.repeat}`);
  if (it.snoozeUntil !== undefined && it.status === "snoozed") out.push(`Snoozed until: ${showInstant(it.snoozeUntil, zone, now)} (${zone})`);
  return out.join("\n");
}

const SECTION_MAX = 8;

// A line of the phone list: "• Call Sam · Fri 24 Oct · Sam ↻" (no number: people name an item by what it is; the number is the tools').
function bullet(it: Item, now: number, zone: string, o: { due?: boolean } = {}): string {
  const bits = [it.title];
  const due = o.due === false ? "" : dueText(it, now, zone, true);
  if (due) bits.push(due);
  if (it.person && it.kind !== "task") bits.push(it.person);
  return `• ${bits.join(" · ")}${it.repeat ? " ↻" : ""}`;
}

function section(title: string, items: readonly Item[], now: number, zone: string, o: { due?: boolean; tag?: boolean } = {}): string[] {
  if (!items.length) return [];
  const shown = items.slice(0, SECTION_MAX).map((it) => `${bullet(it, now, zone, o)}${o.tag && it.kind !== "task" ? ` (${KIND_TAG[it.kind]})` : ""}`);
  return ["", `${title} (${items.length})`, ...shown, ...(items.length > SECTION_MAX ? [`… and ${items.length - SECTION_MAX} more`] : [])];
}

/** "/tasks": the open items grouped Overdue / Today / Upcoming / No date / Waiting on / I owe. */
export function tasksText(key: string, now: number, zone: string): string {
  const open = listItems(key, { status: "open", limit: 200 }, now, zone);
  const c = counts(key, now, zone);
  if (!open.length) return ["Nothing open.", ...(c.snoozed ? [`${c.snoozed} snoozed.`] : []), "Tell me what to add."].join("\n");
  const cls = (it: Item) => dueClass(it, now, zone);
  const overdue = open.filter((i) => cls(i) === "overdue");
  const rest = open.filter((i) => cls(i) !== "overdue");
  const tasks = rest.filter((i) => i.kind === "task");
  return [
    `Tasks: ${open.length} open${c.overdue ? `, ${c.overdue} overdue` : ""}`,
    ...section("Overdue", overdue, now, zone, { tag: true }),
    ...section("Today", tasks.filter((i) => cls(i) === "today"), now, zone),
    ...section("Upcoming", tasks.filter((i) => cls(i) === "upcoming"), now, zone),
    ...section("No date", tasks.filter((i) => cls(i) === "none"), now, zone, { due: false }),
    ...section("Waiting on", rest.filter((i) => i.kind === "owed_to_me"), now, zone),
    ...section("I owe", rest.filter((i) => i.kind === "i_owe"), now, zone),
    ...(c.snoozed ? ["", `${c.snoozed} snoozed.`] : []),
  ].join("\n");
}

// ---- what a look is told about the list (a fact block written by code: heartbeat/look.ts) ----

const ADDED_WINDOW_MS = 24 * 3_600_000;

/** The facts about the list a look gets in its prompt: what looks added in the last day, with where it came from. "" when there is nothing.
 *  The titles may carry a mail's words, so it is fenced as data by the caller; `fromMail`: whether any of it came from mail (the run is then told it read untrusted text). */
export function tasksFacts(key: string, now: number, zone: string): { text: string; fromMail: boolean } {
  const added = addedByLooks(key, now - ADDED_WINDOW_MS);
  if (!added.length) return { text: "", fromMail: false };
  const lines = added.map((it) => `${itemLine(it, now, zone)} | added ${showInstant(it.createdAt, zone, now)}${it.sourceRef ? ` | source ${it.sourceRef}` : ""}`);
  return { text: `Added to the list by looks in the last 24 hours (you or another look did it; the chat log and your own posts show whether it was already mentioned):\n${lines.join("\n")}`, fromMail: added.some((it) => it.sourceKind === "mail") };
}
