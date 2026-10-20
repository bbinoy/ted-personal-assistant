import { htmlToText, looksLikeHtml } from "./html.ts";
import { cleanText } from "./sanitize.ts";

// Clean at the door, for tool results: what a tool returns (mail, Notion, calendar, web, notes) is walked and every string is
// cleaned before the model reads it (the SDK's PostToolUse `updatedToolOutput`, agent.ts). A string that holds JSON is parsed,
// cleaned inside and written back only if something changed; mail tools' HTML is reduced to visible text. Fields that hold
// binary (`data`, image blocks) are left alone.

export interface ToolClean { output: unknown; removed: number; cut: number; hidden: number }

const MAIL_TOOL = /mailbird|gmail/i;

export function cleanToolOutput(tool: string, output: unknown): ToolClean | undefined {
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

  const result = walk(output);
  return JSON.stringify(result) === JSON.stringify(output) ? undefined : { output: result, ...t };
}
