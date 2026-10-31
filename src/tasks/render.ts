import { addedByLooks, counts, dueClass, effectiveStatus, listItems, type Item } from "./store.ts";
import { addDays, parseLocal, showInstant, showLocal, todayIn } from "./when.ts";

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
const PEEK = 3; // titles shown on a collapsed bucket's line
const PEEK_CHARS = 20;
const WEEK = 7; // "this week" = up to 7 days after today

export type Bucket = "Today" | "This week" | "Later" | "No date";
export const BUCKETS: readonly Bucket[] = ["Today", "This week", "Later", "No date"];

function bucketOf(it: Item, now: number, zone: string): Bucket {
  const c = dueClass(it, now, zone);
  if (c === "overdue" || c === "today") return "Today"; // (overdue rows come first inside it)
  if (c === "none") return "No date";
  return parseLocal(it.due)!.date <= addDays(todayIn(now, zone), WEEK) ? "This week" : "Later";
}

/** THE grouping of open items, shared by the task page and /tasks: Today (overdue first, then due today), This week (up to 7 days on), Later, No date. */
export function groupOpen(open: readonly Item[], now: number, zone: string): Record<Bucket, Item[]> {
  const late = (i: Item): boolean => dueClass(i, now, zone) === "overdue";
  const out: Record<Bucket, Item[]> = { Today: [], "This week": [], Later: [], "No date": [] };
  for (const i of open) out[bucketOf(i, now, zone)].push(i);
  out.Today = [...out.Today.filter(late), ...out.Today.filter((i) => !late(i))];
  return out;
}

// A line of the phone list: "- Call Sam . Fri 24 Oct . Sam . overdue" (no number: people name an item by what it is; the number is the tools').
function bullet(it: Item, now: number, zone: string): string {
  const bits = [it.title];
  const due = dueText(it, now, zone, true);
  if (due) bits.push(due);
  if (it.person && it.kind !== "task") bits.push(`${KIND_TAG[it.kind]} ${it.person}`);
  if (dueClass(it, now, zone) === "overdue") bits.push("overdue");
  if (it.urgent) bits.push("urgent");
  return `• ${bits.join(" · ")}${it.repeat ? " ↻" : ""}`;
}

const cut = (t: string): string => (t.length > PEEK_CHARS ? `${t.slice(0, PEEK_CHARS - 1).trimEnd()}…` : t);

/** "/tasks": the same buckets as the task page. Today in full (overdue first, marked), the others one line each with a count and the first few titles. `link`: the task page's address, owner only. */
export function tasksText(key: string, now: number, zone: string, o: { link?: string } = {}): string {
  const open = listItems(key, { status: "open", limit: 200 }, now, zone);
  const c = counts(key, now, zone);
  if (!open.length) return ["Nothing open.", ...(c.snoozed ? [`${c.snoozed} snoozed.`] : []), "Tell me what to add."].join("\n");
  const g = groupOpen(open, now, zone);
  const today = g.Today;
  const peek = (b: Bucket): string[] => {
    const xs = g[b];
    if (!xs.length) return [];
    const names = xs.slice(0, PEEK).map((i) => cut(i.title)).join(", ");
    return [`${b} (${xs.length}): ${names}${xs.length > PEEK ? ` +${xs.length - PEEK}` : ""}`];
  };
  const rest = (["This week", "Later", "No date"] as const).flatMap(peek);
  return [
    `Tasks: ${open.length} open${c.overdue ? `, ${c.overdue} overdue` : ""}`,
    ...(today.length ? ["", `Today (${today.length})`, ...today.slice(0, SECTION_MAX).map((i) => bullet(i, now, zone)), ...(today.length > SECTION_MAX ? [`… and ${today.length - SECTION_MAX} more`] : [])] : []),
    ...(rest.length ? ["", ...rest] : []),
    ...(c.snoozed ? ["", `${c.snoozed} snoozed.`] : []),
    ...(o.link ? ["", `Task page: ${o.link}`] : []),
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
