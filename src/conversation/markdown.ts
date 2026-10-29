import type { TextStyle } from "@ted-assistant/messenger";

// Markdown subset -> text + style ranges (the messenger's TextStyle).
//
// Chat platforms like Signal have no markdown mode: formatting is sent as separate ranges
// (offsets in UTF-16 code units, which are exactly JavaScript string indices). So we strip
// the markers and record where the styled text ended up; the messenger turns the ranges into
// its platform's format.

type StyleName = TextStyle["style"];
type Style = TextStyle;
interface Rendered {
  text: string;
  styles: Style[];
}

// One inline construct per alternative; the first group that matched decides.
//   1/2 bold  3 strike  4 code  5 italic*  6 italic_  7/8 link
const INLINE =
  /(\*\*|__)(?=\S)(.+?)(?<=\S)\1|~~(?=\S)(.+?)(?<=\S)~~|`([^`\n]+)`|\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)|(?<![A-Za-z0-9_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![A-Za-z0-9_])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

function inline(source: string): Rendered {
  let text = "";
  const styles: Style[] = [];
  let last = 0;
  const add = (inner: Rendered, style?: StyleName) => {
    const base = text.length;
    text += inner.text;
    for (const s of inner.styles) styles.push({ ...s, start: s.start + base });
    if (style && inner.text.length > 0) styles.push({ start: base, length: inner.text.length, style });
  };
  for (const m of source.matchAll(INLINE)) {
    text += source.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[2] !== undefined) add(inline(m[2]), "BOLD");
    else if (m[3] !== undefined) add(inline(m[3]), "STRIKETHROUGH");
    else if (m[4] !== undefined) add({ text: m[4], styles: [] }, "MONOSPACE"); // no nesting in code
    else if (m[5] !== undefined) add(inline(m[5]), "ITALIC");
    else if (m[6] !== undefined) add(inline(m[6]), "ITALIC");
    else if (m[7] !== undefined) {
      // Signal linkifies bare URLs, so keep the URL visible instead of hiding it.
      const label = inline(m[7]);
      add(label);
      text += label.text === m[8] ? "" : ` (${m[8]})`;
    }
  }
  text += source.slice(last);
  return { text, styles };
}

export function renderMarkdown(markdown: string): Rendered {
  let text = "";
  const styles: Style[] = [];
  let inFence = false;
  let fenceStart = 0;

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (!inFence) {
        inFence = true;
        fenceStart = text.length;
      } else {
        inFence = false;
        const length = text.length - fenceStart - 1; // minus trailing newline
        if (length > 0) styles.push({ start: fenceStart, length, style: "MONOSPACE" });
      }
      continue;
    }
    if (inFence) {
      text += raw + "\n";
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue; // horizontal rule

    let line = raw;
    let bold = false;
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      line = heading[1]!;
      bold = true;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) line = `${bullet[1]}• ${bullet[2]}`;

    const r = inline(line);
    const base = text.length;
    text += r.text + "\n";
    for (const s of r.styles) styles.push({ ...s, start: s.start + base });
    if (bold && r.text.length > 0) styles.push({ start: base, length: r.text.length, style: "BOLD" });
  }
  // Collapse runs of blank lines, keeping style offsets valid.
  return tidy({ text, styles });
}

// Trim trailing whitespace and squeeze 3+ newlines to 2, remapping the ranges.
function tidy(r: Rendered): Rendered {
  const map: number[] = []; // old index -> new index
  let text = "";
  let newlines = 0;
  for (let i = 0; i < r.text.length; i++) {
    const ch = r.text[i]!;
    map[i] = text.length;
    if (ch === "\n") {
      newlines++;
      if (newlines > 2) continue;
    } else {
      newlines = 0;
    }
    text += ch;
  }
  map[r.text.length] = text.length;
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const styles: Style[] = [];
  for (const s of r.styles) {
    const start = Math.max(0, map[s.start]! - lead);
    const end = Math.min(trimmed.length, map[s.start + s.length]! - lead);
    if (end > start) styles.push({ ...s, start, length: end - start });
  }
  return { text: trimmed, styles };
}
