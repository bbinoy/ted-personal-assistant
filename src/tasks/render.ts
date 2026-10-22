import { counts, dueClass, effectiveStatus, listItems, type Item } from "./store.ts";
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

/** One item for a model or a list: "#4 [task] Call Sam | due Fri 24 Oct 14:30 | with Sam | remind Thu 23 Oct 09:00 | repeats every monday | suggested". */
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
  if (it.origin === "inferred") parts.push(`inferred from ${it.sourceKind}`);
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

// A line of the phone list: "• #4 Call Sam · Fri 24 Oct · Sam ↻".
function bullet(it: Item, now: number, zone: string, o: { due?: boolean } = {}): string {
  const bits = [`#${it.id} ${it.title}`];
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

/** "/tasks": the open items grouped Overdue / Today / Upcoming / No date / Waiting on / I owe, then how many suggestions wait. */
export function tasksText(key: string, now: number, zone: string): string {
  const open = listItems(key, { status: "open", limit: 200 }, now, zone);
  const c = counts(key, now, zone);
  const tail = c.suggested ? [``, `${c.suggested} suggestion${c.suggested === 1 ? "" : "s"} waiting: /tasks suggestions`] : [];
  if (!open.length) return ["Nothing open.", ...(c.snoozed ? [`${c.snoozed} snoozed.`] : []), ...tail, ...(c.suggested ? [] : ["Tell me what to add."])].join("\n");
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
    ...tail,
  ].join("\n");
}

/** "/tasks suggestions": what the assistant noticed and proposes, each with where it came from. */
export function suggestionsText(key: string, now: number, zone: string): string {
  const items = listItems(key, { status: "suggested", limit: 50 }, now, zone);
  if (!items.length) return "No suggestions waiting.";
  return [
    `${items.length} suggestion${items.length === 1 ? "" : "s"} (from ${[...new Set(items.map((i) => i.sourceKind))].join(", ")}):`,
    ...items.slice(0, 12).map((it) => bullet(it, now, zone)),
    ...(items.length > 12 ? [`… and ${items.length - 12} more`] : []),
    "",
    "Tell me which to keep (e.g. “keep 12”) or drop (“drop 13”).",
  ].join("\n");
}
