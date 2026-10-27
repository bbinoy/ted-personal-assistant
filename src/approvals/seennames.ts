// The names of the objects the run has READ, by id, so a question or a journal line can say "Embassy reception, Fri 21 Nov, 18:00" instead of an id. One mechanism for every connector: the
// result of any read tool of a conversation is walked for objects that have an id-like key and a title-like key (subject, summary, title, name) and, for an event, its start time. Only text the
// connector returned, never the model's words. In memory, per conversation, kept a day, bounded. (A mail also keeps its sender.)

import { clip } from "../core/sanitize.ts";
import { resultText } from "../modules/browse/browseguard.ts";
import { norm } from "./created.ts";
import { whenOf } from "./format.ts";

const TTL_MS = 24 * 3_600_000;
const MAX_SEEN = 600;
const seen = new Map<string, Map<string, { title: string; from?: string; when?: string; at: number }>>();
export const forgetSeen = (): void => seen.clear(); // tests

const ID_KEYS = ["conversationId", "conversation_id", "threadId", "thread_id", "messageId", "message_id", "eventId", "event_id", "pageId", "page_id", "fileId", "file_id", "id"];
const TITLE_KEYS = ["subject", "summary", "title", "name"];
const FROM_KEY = /^(?:last_?)?(?:from|sender)(?:_?name|_?email|_?address)?$/i; // (Mailbird's list rows say `lastSender`)
const textOf = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim() || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return textOf(o.name) ?? textOf(o.displayName) ?? textOf(o.email) ?? textOf(o.address);
  }
  return undefined;
};

export function rememberNames(conv: string, response: unknown, now = Date.now()): void {
  let root: unknown = response;
  const text = typeof response === "string" ? response : resultText(response);
  if (text) {
    try {
      root = JSON.parse(text);
    } catch {
      return; // (not JSON: a rendered list we cannot read ids from)
    }
  }
  const found: [string, { title: string; from?: string; when?: string }][] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== "object" || found.length > 200) return;
    if (Array.isArray(v)) return void v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const title = TITLE_KEYS.map((k) => textOf(o[k])).find(Boolean);
    const id = ID_KEYS.map((k) => o[k]).find((x) => (typeof x === "string" && x) || typeof x === "number");
    if (title && id !== undefined) found.push([norm(id as string | number), { title, from: Object.keys(o).filter((k) => FROM_KEY.test(k)).map((k) => textOf(o[k])).find(Boolean), when: whenOf(o) }]);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(root, 0);
  if (!found.length) return;
  const m = seen.get(conv) ?? seen.set(conv, new Map()).get(conv)!;
  for (const [k, e] of m) if (now - e.at >= TTL_MS) m.delete(k);
  for (const [id, e] of found) m.set(id, { ...e, at: now });
  while (m.size > MAX_SEEN) m.delete(m.keys().next().value!);
}

// “Title” from sender, or “Title”, Fri 21 Nov, 18:00–19:00: how a person knows the thing. Undefined when the run has not seen it.
export const seenName = (conv: string, id: string | number): string | undefined => {
  const e = seen.get(conv)?.get(norm(id));
  return e ? `“${clip(e.title, 120)}”${e.from ? ` from ${clip(e.from, 50)}` : ""}${e.when ? `, ${e.when}` : ""}` : undefined;
};
