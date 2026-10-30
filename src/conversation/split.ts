// A reply goes out as several messages, split at the blank lines the model writes (the model decides content and paragraphing, code renders it, like the Signal formatting).
// Kept together as one message: a lead-in line ending with ":" with what follows it, a list (consecutive bullet or numbered lines), a code fence, and anything the model wraps
// in the copy marker ([[whole]] ... [[/whole]]: a text to paste or pass on), whatever blank lines it holds. A tiny fragment (a lone emoji, one or two words) joins its neighbour.
const WHOLE = /\[\[whole\]\]([\s\S]*?)(?:\[\[\/whole\]\]|$)/gi;
const STRAY = /\[\[\/?whole\]\]/gi;
const ITEM = /^\s*(?:[-*•–]|\d+[.)])\s+\S/;

interface Part {
  text: string;
  whole: boolean;
}

// The text without the copy markers (what a voice note speaks, what the judge is told).
export const stripWhole = (text: string): string => text.replace(STRAY, "");

// Blank-line paragraphs of a plain stretch of text; a blank line inside a code fence does not end one.
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && !line.trim()) {
      if (cur.length) out.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

const isList = (p: string) => ITEM.test(p.split("\n")[0]!);
const endsList = (p: string) => ITEM.test(p.split("\n").at(-1)!);
const tiny = (p: string) => !/[\p{L}\p{N}]/u.test(p) || p.trim().split(/\s+/).length <= 2;

export function splitMessages(text: string): string[] {
  const parts: Part[] = [];
  let at = 0;
  const plain = (s: string) => parts.push(...paragraphs(s).map((p) => ({ text: p.trim(), whole: false })));
  for (const m of text.matchAll(WHOLE)) {
    plain(text.slice(at, m.index));
    if (m[1]!.trim()) parts.push({ text: m[1]!.trim(), whole: true });
    at = m.index + m[0].length;
  }
  plain(text.slice(at));
  // a lead-in with what follows it; a list that goes on after a blank line
  const joined: Part[] = [];
  for (const p of parts) {
    const prev = joined.at(-1);
    if (prev && !prev.whole && (prev.text.endsWith(":") || (endsList(prev.text) && !p.whole && isList(p.text)))) {
      prev.text += `\n${p.text}`;
      prev.whole = p.whole;
    } else joined.push({ ...p });
  }
  // a tiny fragment into the neighbour (the one before, else the one after)
  const out: Part[] = [];
  let carry = "";
  for (const p of joined) {
    if (!p.whole && tiny(p.text) && joined.length > 1) {
      if (out.length) out.at(-1)!.text += `\n\n${p.text}`;
      else carry = carry ? `${carry}\n\n${p.text}` : p.text;
    } else {
      out.push({ ...p, text: carry ? `${carry}\n\n${p.text}` : p.text });
      carry = "";
    }
  }
  if (carry) out.push({ text: carry, whole: false });
  return out.map((p) => stripWhole(p.text).trim()).filter(Boolean);
}
