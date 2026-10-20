// What the assistant itself made in a conversation (a draft, a calendar event, a Notion page), by id, so that the approval judge can be told whether a delete is of
// something the assistant just created (probably a mistake or an obsolete draft) or of something that was the person's. In memory only, per conversation (the key is
// Conversation.key like the other per-conversation state: one conversation's ids tell nothing about another's), kept 24 hours and pruned as new ones come in.
// Code writes it from the results of the tools a module lists as creating something (modules/types.ts ModuleFloor.creates); a model, a mail or a page never does.

const TTL_MS = 24 * 60 * 60_000;
const MAX_PER_CONVERSATION = 500;
const seen = new Map<string, Map<string, number>>();

// An id as comparable text: a Notion page id with or without dashes or in its URL, a number or a string otherwise.
const norm = (v: string | number): string => {
  const s = String(v).trim();
  const hex = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/i.exec(s);
  return (hex ? hex.slice(1).join("") : s).toLowerCase();
};

const ID_KEY = /^(id|(event|message|draft|page|file|thread)_?id)$/i;

// Pure. The ids a create result holds: the values of id-like keys anywhere in it (as JSON text, escaped or not), and any page id in a Notion address.
export function idsInResult(response: unknown): string[] {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "") ?? "";
  const out = new Set<string>();
  for (const m of text.matchAll(/\\?"([A-Za-z_]{2,20})\\?"\s*:\s*\\?"?([A-Za-z0-9_@.-]{1,80})/g)) if (ID_KEY.test(m[1]!)) out.add(norm(m[2]!));
  for (const m of text.matchAll(/notion\.so\/[^\s"\\]*?([0-9a-f]{32})\b/gi)) out.add(norm(m[1]!));
  return [...out];
}

// Pure. The ids a call names (the draft, event, page or file it is about), to compare with what the assistant created.
export function idsInCall(input: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 3 || !v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (ID_KEY.test(k) && (typeof x === "string" || typeof x === "number") && String(x) !== "") out.add(norm(x));
      else walk(x, depth + 1);
    }
  };
  walk(input, 0);
  return [...out];
}

export function noteCreated(conversation: string, ids: readonly string[], now = Date.now()): void {
  if (!ids.length) return;
  for (const [c, m] of seen) {
    for (const [id, at] of m) if (now - at >= TTL_MS) m.delete(id);
    if (!m.size) seen.delete(c);
  }
  const m = seen.get(conversation) ?? seen.set(conversation, new Map()).get(conversation)!;
  for (const id of ids) m.set(id, now);
  while (m.size > MAX_PER_CONVERSATION) m.delete(m.keys().next().value!);
}

// yes: the call's id came back from the assistant's own create in this conversation within 24 hours. no: it names ids and none did. unknown: it names no id we can read.
export function createdFact(conversation: string, input: Record<string, unknown>, now = Date.now()): "yes" | "no" | "unknown" {
  const ids = idsInCall(input);
  if (!ids.length) return "unknown";
  const m = seen.get(conversation);
  return ids.some((id) => m && now - (m.get(id) ?? -Infinity) < TTL_MS) ? "yes" : "no";
}

export const forgetCreated = (): void => seen.clear(); // tests
