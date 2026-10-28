// "Clean at the door": the one shared, pure sanitiser for untrusted TEXT. It runs where text first enters (Signal messages, voice
// transcripts, mail rows, tool results, fences), so hidden or look-alike content never reaches a model. It is idempotent
// (cleaning clean text changes nothing), so a second pass at a later door is harmless. HTML is handled in html.ts.
//
// What it does NOT do: judge intent (no injection detector) or fold look-alike letters (that would mangle real text).

export interface Cleaned {
  text: string;
  removed: number; // hidden or steering characters dropped (counts only, never content)
  cut: number; // characters cut by a length cap or a run collapse (announced in the text by a marker)
}

// Invisible and steering code points: control (not newline/tab), format (zero-width, bidi, soft hyphen, word joiner, BOM,
// interlinear marks, the tag block), private use, lone surrogates, and the fillers/selectors that are Letters or Marks
// by category but draw nothing: Hangul fillers, combining grapheme joiner, Khmer inherent vowels, variation selectors.
// The few visible format characters of Arabic and Syriac (number signs, end of ayah) stay.
const DROP = /(?![\n\t\u0600-\u0605\u06DD\u070F\u08E2])[\p{Cc}\p{Cf}]|[\p{Co}\p{Cs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u;
const PICTO = /\p{Extended_Pictographic}/u;
const EMOJI_JOINABLE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]/u;
// ZWNJ and ZWJ are real letters' glue in these scripts (Persian, Hindi...): kept only between two letters of such a script.
const JOINING_SCRIPT = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thai}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Sinhala}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}]/u;
const MONGOLIAN = /\p{Script=Mongolian}/u;
// The only tag-block sequences that mean something: the England, Scotland and Wales flags (black flag + tag letters + cancel tag).
const SUBDIVISION_FLAGS = new Set(["gbeng", "gbsct", "gbwls"]);

const first = (s: string) => s.codePointAt(0)!;

// Pass 1: drop what is hidden, keep the legitimate uses of ZWJ, ZWNJ, VS15/16 and the three subdivision flags.
function strip(s: string): { text: string; removed: number } {
  const cps = Array.from(s);
  let out = "";
  let removed = 0;
  let prev = ""; // the last code point kept
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    const cp = first(c);
    if (cp === 0x1f3f4) {
      let j = i + 1;
      let word = "";
      while (j < cps.length && first(cps[j]!) >= 0xe0061 && first(cps[j]!) <= 0xe007a) word += String.fromCharCode(first(cps[j++]!) - 0xe0000);
      if (SUBDIVISION_FLAGS.has(word) && cps[j] === "\u{E007F}") {
        out += cps.slice(i, j + 1).join("");
        prev = "\u{E007F}";
        i = j;
        continue;
      }
    }
    const next = cps[i + 1] ?? "";
    let keep: boolean;
    if (cp === 0x200d) keep = (EMOJI_JOINABLE.test(prev) && PICTO.test(next)) || (JOINING_SCRIPT.test(prev) && JOINING_SCRIPT.test(next));
    else if (cp === 0x200c) keep = JOINING_SCRIPT.test(prev) && JOINING_SCRIPT.test(next);
    else if (cp === 0xfe0f || cp === 0xfe0e) keep = PICTO.test(prev) || (cp === 0xfe0f && /^[0-9#*]$/.test(prev) && next === "\u20E3"); // emoji / text presentation, keycaps
    else if (cp >= 0x180b && cp <= 0x180d) keep = MONGOLIAN.test(prev);
    else keep = !DROP.test(c);
    if (keep) {
      out += c;
      prev = c;
    } else removed++;
  }
  return { text: out, removed };
}

export const marker = (n: number) => `[... ${n} characters cut]`;
const MARKER_END = /\s?\[\.\.\. (\d+) characters cut\]$/;

// Pass 2: cap the length. Nothing is cut silently: the end says how much. A marker we wrote earlier is recognised, so
// capping twice gives the same text.
function cap(text: string, max: number): { text: string; cut: number } {
  let body = text;
  let earlier = 0;
  const m = MARKER_END.exec(text);
  if (m) {
    body = text.slice(0, m.index);
    earlier = Number(m[1]);
  }
  if (body.length <= max) return { text, cut: 0 };
  let end = max;
  if (/[\uD800-\uDBFF]/.test(body[end - 1] ?? "")) end--; // never split a surrogate pair
  const cut = body.length - end;
  return { text: `${body.slice(0, end)} ${marker(cut + earlier)}`, cut };
}

// Pass 3: absurd runs. 200+ of one character, and walls of blank lines or spaces.
function collapse(text: string): { text: string; cut: number } {
  let cut = 0;
  const t = text
    .replace(/(\S)\1{199,}/gu, (run, c: string) => {
      const n = Array.from(run).length;
      cut += n - 20;
      return `${c.repeat(20)} ${marker(n - 20)}`;
    })
    .replace(/[ \t]{81,}/g, "    ")
    .replace(/\n[ \t]*(?:\n[ \t]*){3,}/g, "\n\n\n");
  return { text: t, cut };
}

// Zalgo: a pile of combining marks on one letter. Real scripts stack a handful at most.
const MARK_PILE = /(\p{M}{8})\p{M}+/gu;

// The text-length tiers, by purpose (docs/ARCHITECTURE.md, "Text length tiers"). Characters unless the name says bytes.
export const LIMITS = {
  reason: 120, // why something failed or was decided: error text, a reason in an audit row or notice
  control: 80, // the name of a page control in an audit row or approval fact
  gist: 160, // a one-line gist: a style note, a description, a shown row
  brief: 1500, // a short report, or a question and its arguments as logged
  name: 100, // a person's or sender's name: a label, one line
  subject: 300, // a mail subject, the default for oneLine
  preview: 200, // a short preview of a message, reaction target or log entry (thread quote, wake-up log, summary input, error text in an audit row)
  line: 240, // one message as one line a model skims (gate and tail lines, helper-model context): the start says what it is about, and every extra character costs on every gate call
  logLine: 600, // one message or ledger entry in a group or notice log shown in a prompt: room for a real sentence or two
  quote: 1500, // the earlier message someone replies to, stored and shown as context
  logEntry: 4000, // one entry kept in a conversation log file (messages.ts): the log stays small, the model-visible message is not cut here
  body: 20_000, // a mail body or voice transcript
  message: 70_000, // what a person typed to us, a long message included (64 KB of text and a note; pairs with MAX_LONG_TEXT_BYTES in packages/signal)
  block: 100_000, // one fenced block of data in a prompt
  args: 6000, // tool arguments in an audit row (audit size)
  textFile: 200_000, // bytes of a text file shown to the model (the PDF cap is MAX_FILE_BYTES in packages/signal, 20 MB)
  pageView: 24_000, // one browse page view (~7k tokens; MCP results over 25k tokens would be written to a file the run cannot read)
} as const;
const HARD_INPUT = 4_000_000; // the work itself is bounded, whatever comes in

export interface CleanOptions {
  max?: number; // the length cap (default: no cap)
  line?: boolean; // one line: all whitespace becomes a single space
}

export function cleanText(input: string, o: CleanOptions = {}): Cleaned {
  let s = input;
  let cut = 0;
  if (s.length > HARD_INPUT) {
    cut += s.length - HARD_INPUT;
    s = s.slice(0, HARD_INPUT);
  }
  s = s.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n");
  const stripped = DROP.test(s) ? strip(s) : { text: s, removed: 0 }; // most text has nothing to drop
  let removed = stripped.removed;
  s = stripped.text.replace(MARK_PILE, (m, head: string) => {
    removed += Array.from(m).length - Array.from(head).length;
    return head;
  });
  s = s.normalize("NFC"); // canonical equivalence only: same text to a reader (\u00E9 as one or two code points, \u00C5 the angstrom sign); never NFKC, which rewrites \u00B2, \u00BD, fullwidth and ligatures
  const c = collapse(s);
  s = c.text;
  cut += c.cut;
  if (o.line) s = s.replace(/\s+/g, " ").trim();
  if (o.max !== undefined) {
    const k = cap(s, o.max);
    s = k.text;
    cut += k.cut;
  }
  return { text: s, removed, cut };
}

// The same, as a string, with a count-only log line when something was removed or cut ("clean: mail subject: ...").
export function clean(label: string, input: string, o: CleanOptions = {}): string {
  const r = cleanText(input, o);
  if (r.removed || r.cut) console.log(`clean: ${label}: ${r.removed ? `removed ${r.removed} hidden character(s)` : ""}${r.removed && r.cut ? ", " : ""}${r.cut ? `cut ${r.cut} character(s)` : ""}`);
  return r.text;
}

// A short single-line field (a subject, a sender's name): controls become spaces first so "a\0b" stays two words.
export const oneLine = (label: string, input: string, max: number = LIMITS.subject): string =>
  clean(label, input.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " "), { line: true, max });

// Lines of a batch format that a body could forge: a separator and a "[2]" marker. Defused, text kept.
export const defuseLines = (body: string): string => body.replace(/^[ \t]*-{5,}[ \t]*$/gm, "---").replace(/^([ \t]*)\[(\d+)\]/gm, "$1($2)");

// Tags a model might treat as a speaker or a system voice. Written inside data, they get a backslash.
const ROLE_TAGS = "system|system-reminder|assistant|user|human|instructions?|function_results|tool_result|tool_use|antml:[a-z_]+";

// Text that cannot close or forge a fence: the fence's own tag (closing or opening, any case, spaces tolerated) and role tags.
export function defuseTags(body: string, tag?: string): string {
  const names = tag ? `${tag}|${ROLE_TAGS}` : ROLE_TAGS;
  return body.replace(new RegExp(`<(\\s*\\/?\\s*)(${names})`, "gi"), "<\\$1$2");
}

// Group members write "(the owner)" / "(a member)" next to a name in our log lines; text of theirs must not fake it.
export const defuseSpeakers = (text: string): string => text.replace(/\((the owner|a member)\)/gi, "[$1]");

// Bidirectional-text controls can make text display in a different order than it reads
// (an approval that looks harmless on the phone but says something else). Never shown.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Characters that take no room on a screen (zero-width space, word joiner, BOM, soft hyphen, fillers) would make two different
// addresses or titles look identical. They are shown as their code point instead of staying invisible. (Not U+200C/U+200D: emoji
// sequences and some scripts need them.) Other control characters are dropped.
const INVISIBLE = /[­͏ᅟᅠ᠎​⁠-⁤ㅤ﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// An approval must never hide content silently: whatever is cut is announced.
const safe = (text: string): string =>
  text
    .replace(BIDI, "")
    .replace(CONTROL, "")
    .replace(INVISIBLE, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}… (+${s.length - max} more characters not shown)` : s);

// One line: all whitespace becomes a single space.
export function clip(text: string, max: number): string {
  return cut(safe(text).replace(/\s+/g, " ").trim(), max);
}

// The same sanitising, but line breaks stay (runs of spaces shrink, three or more breaks become one blank line).
export function clipText(text: string, max: number): string {
  const kept = safe(text)
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cut(kept, max);
}
