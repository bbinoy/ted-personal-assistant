import { callKey } from "./permissions.ts";
import { idsInCall } from "./created.ts";

// What the owner (or whoever may answer in a group) DECLINED, per conversation, in memory: the tool and a fingerprint of the call, for 30 minutes. A decline is final until
// the person asks again in a NEW message (conversation.ts calls forgetDeclined for it) or says yes to the same call. permissions.ts reads it for every call that is
// asked about: the question and the judge are told "The owner declined this action N minutes ago.", and the judge can never auto-approve it. Code writes it, from the
// outcome of an approval; a model, a mail, a page or an emoji never does. A restart forgets it (30 minutes; the run restarts rarely and a repeated question is the safe error).

const TTL_MS = 30 * 60_000;
const MAX_PER_CONVERSATION = 100;

interface Entry {
  tool: string;
  at: number;
  exact: string; // the whole call
  context: boolean;
  ids: string[]; // the object it names (event, message, page, file...)
  title?: string; // a create names no id: its title and day stand in
  day?: string;
}
const declined = new Map<string, Entry[]>();

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined);
function dayOf(input: Record<string, unknown>): string | undefined {
  const start = input.startTime ?? input.start ?? input.start_time;
  const s = start && typeof start === "object" ? (start as { dateTime?: unknown; date?: unknown }).dateTime ?? (start as { date?: unknown }).date : start;
  return typeof s === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(s)?.[0] : undefined;
}
// `context`: for a step whose arguments say little by themselves (a browser click: the page and control are in the text code wrote for it), that text; such a step matches only itself.
const print = (tool: string, input: Record<string, unknown>, at: number, context = ""): Entry => ({ tool, at, exact: callKey("", input) + context, context: !!context, ids: idsInCall(input), title: text(input.summary) ?? text(input.title) ?? text(input.subject), day: dayOf(input) });

// The same call, or a near-equal one: the same tool on the same object (an id in common), or, for a call that names none, the same title on the same day.
function same(a: Entry, b: Entry): boolean {
  if (a.tool !== b.tool) return false;
  if (a.exact === b.exact) return true;
  if (a.context || b.context) return false;
  if (a.ids.length && b.ids.length) return a.ids.some((i) => b.ids.includes(i));
  return !!a.title && a.title === b.title && a.day === b.day;
}

const live = (list: Entry[], now: number): Entry[] => list.filter((e) => now - e.at < TTL_MS);

export function noteDeclined(conversation: string, tool: string, input: Record<string, unknown>, now = Date.now(), context?: string): void {
  const e = print(tool, input, now, context);
  const list = live(declined.get(conversation) ?? [], now).filter((x) => !same(x, e));
  list.push(e);
  declined.set(conversation, list.slice(-MAX_PER_CONVERSATION));
}

// Milliseconds since the newest matching decline; undefined when there is none within 30 minutes.
export function declinedAgo(conversation: string, tool: string, input: Record<string, unknown>, now = Date.now(), context?: string): number | undefined {
  const e = print(tool, input, now, context);
  const hit = live(declined.get(conversation) ?? [], now).filter((x) => same(x, e)).map((x) => x.at).sort((a, b) => b - a)[0];
  return hit === undefined ? undefined : Math.max(0, now - hit);
}

// The person said yes to this call: it is no longer declined.
export function clearDeclined(conversation: string, tool: string, input: Record<string, unknown>, now = Date.now(), context?: string): void {
  const e = print(tool, input, now, context);
  const list = (declined.get(conversation) ?? []).filter((x) => !same(x, e));
  if (list.length) declined.set(conversation, list);
  else declined.delete(conversation);
}

// A new message of the person's (not an answer to a question): they may be asking again, so the conversation's declines no longer stand.
export const forgetDeclined = (conversation: string): void => void declined.delete(conversation);
export const resetDeclined = (): void => declined.clear(); // tests

export const declinedMinutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));
// The code-built line the judge and the question writer read (questionfacts.ts requires the minutes in the question).
export const declinedLine = (ms: number): string => {
  const m = declinedMinutes(ms);
  return `The owner declined this action ${m} ${m === 1 ? "minute" : "minutes"} ago.`;
};
