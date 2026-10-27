import { htmlToText, looksLikeHtml } from "./html.ts";
import { cleanText } from "./sanitize.ts";

// Clean at the door, for tool results: what a tool returns (mail, Notion, calendar, web, notes) is walked and every string is
// cleaned before the model reads it (the SDK's PostToolUse `updatedToolOutput`, agent.ts). A string that holds JSON is parsed,
// cleaned inside and written back only if something changed; mail tools' HTML is reduced to visible text. Fields that hold
// binary (`data`, image blocks) are left alone. The text of one result is also capped in total (TOOL_OUTPUT_MAX_CHARS): a connector that answers with a whole
// mailbox or a whole page would otherwise fill the model's context (and its bill) with one call; the rest is cut and the result says how much and what to do.

export interface ToolClean { output: unknown; removed: number; cut: number; hidden: number }

const MAIL_TOOL = /mailbird|gmail/i;

const countable = (key: string) => !["data", "base64", "type", "mimeType"].includes(key); // (binary content, and the tags that say what a block is)

// Pure: a result whose text (every string but binary fields, in reading order) is longer than `max` characters keeps its first `max` characters; the last string of the result
// ends with a visible note of how much was cut. Strings after the budget is spent become empty, so the shape of the result stays what the caller expects.
export function capTotal(v: unknown, max: number): { value: unknown; cut: number } {
  let total = 0;
  let leaves = 0;
  const scan = (x: unknown, key = ""): void => {
    if (typeof x === "string") {
      if (countable(key)) (total += x.length, leaves++);
    } else if (Array.isArray(x)) x.forEach((y) => scan(y, key));
    else if (x && typeof x === "object" && (x as { type?: unknown }).type !== "image") Object.entries(x).forEach(([k, y]) => scan(y, k));
  };
  scan(v);
  if (total <= max) return { value: v, cut: 0 };
  const cut = total - max;
  const hint = `\n[... ${cut} characters cut: narrow the query or use page_token]`;
  let left = max;
  let seen = 0;
  const go = (x: unknown, key = ""): unknown => {
    if (typeof x === "string") {
      if (!countable(key)) return x;
      const keep = Math.min(x.length, left);
      left -= keep;
      const kept = x.slice(0, keep).replace(/[\ud800-\udbff]$/, ""); // not half of a surrogate pair
      return seen++ === leaves - 1 ? kept + hint : kept;
    }
    if (Array.isArray(x)) return x.map((y) => go(y, key));
    if (x && typeof x === "object" && (x as { type?: unknown }).type !== "image") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, go(y, k)]));
    return x;
  };
  return { value: go(v), cut };
}

// The most characters of ONE tool result the model reads (in the PostToolUse path of every tool, MCP results included); the rest is cut with a hint to narrow the query.
const TOOL_OUTPUT_MAX_CHARS = 60_000;
export function cleanToolOutput(tool: string, output: unknown, max: number = TOOL_OUTPUT_MAX_CHARS): ToolClean | undefined {
  const mail = MAIL_TOOL.test(tool);
  const gmail = /gmail/i.test(tool);
  const t = { removed: 0, cut: 0, hidden: 0 };

  const text = (s: string): string => {
    const head = s.trimStart()[0];
    if (head === "{" || head === "[") {
      try {
        const parsed = JSON.parse(s);
        const walked = walk(parsed);
        return JSON.stringify(walked) === JSON.stringify(parsed) ? s : JSON.stringify(walked, null, /^\s*[{[]\n +/.test(s) ? 2 : undefined);
      } catch {
        // not JSON: plain text below
      }
    }
    let v = s;
    if (mail && looksLikeHtml(s)) {
      const h = htmlToText(s);
      t.hidden += h.hidden;
      v = h.text;
    }
    const r = cleanText(v);
    t.removed += r.removed;
    t.cut += r.cut;
    return r.text;
  };

  const walk = (v: unknown, key = ""): unknown => {
    if (typeof v === "string") return key === "data" || key === "base64" ? v : text(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "image") return v;
      // Gmail returns attachments with their base64 content inline: the assistant never reads attachment content, so only the
      // name, type and size stay (a withheld note replaces the content).
      if (gmail && Array.isArray(o.attachments)) {
        const stripped = o.attachments.map((a) => (a && typeof a === "object" ? Object.fromEntries(Object.entries(a).map(([k, x]) => [k, k === "content" || k === "data" ? "[attachment content withheld]" : x])) : a));
        return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, k === "attachments" ? walk(stripped, k) : walk(x, k)]));
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };

  const capped = capTotal(walk(output), max);
  const result = capped.value;
  t.cut += capped.cut;
  return JSON.stringify(result) === JSON.stringify(output) ? undefined : { output: result, ...t };
}
