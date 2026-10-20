import { parse, type DefaultTreeAdapterMap } from "parse5";
import { cleanText } from "./sanitize.ts";

// HTML (a mail body, a web page) -> the text a person would SEE. parse5 is a spec-compliant parser, so we read the same tree a browser
// builds (no home-made tokenizer to disagree with); on top of it we drop what a reader never sees: comments, script/style/head/
// template/noscript, and elements hidden by the `hidden` attribute or by inline (or simple selector) CSS. The CSS check is small and
// BEST-EFFORT: there is no browser engine here, so cascades, media queries and complex selectors are not evaluated. aria-hidden is
// NOT hidden (screen readers skip it, people still see it).

type Node = DefaultTreeAdapterMap["node"];
type El = DefaultTreeAdapterMap["element"];

const MAX_HTML = 3_000_000;
const DROPPED = new Set(["script", "style", "head", "template", "noscript", "title", "iframe", "object", "applet"]);
const BLOCK = new Set(["address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tr", "ul"]);

// ---- CSS, just enough ----

type Style = Map<string, string>;

function declarations(css: string, into: Style = new Map()): Style {
  for (const d of css.split(";")) {
    const i = d.indexOf(":");
    if (i < 1) continue;
    into.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).replace(/!\s*important/i, "").trim().toLowerCase());
  }
  return into;
}

interface Rule { tag?: string; cls?: string; id?: string; style: string }

// Rules of the form `tag`, `.class`, `#id`, `tag.class` from <style> blocks, outside @media/@supports. Nothing else is evaluated.
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "").slice(0, 200_000);
  for (let at = 0; at < src.length && rules.length < 500; ) {
    const open = src.indexOf("{", at);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    for (; end < src.length && depth > 0; end++) depth += src[end] === "{" ? 1 : src[end] === "}" ? -1 : 0;
    const head = src.slice(at, open).trim();
    const body = src.slice(open + 1, end - 1);
    at = end;
    if (head.startsWith("@") || body.includes("{")) continue; // @media and friends are not evaluated
    for (const sel of head.split(",")) {
      const p = /^([a-z][a-z0-9]*)?(?:\.([\w-]+))?(?:#([\w-]+))?$/i.exec(sel.trim());
      if (p && (p[1] || p[2] || p[3])) rules.push({ tag: p[1]?.toLowerCase(), cls: p[2], id: p[3], style: body });
    }
  }
  return rules;
}

const NAMED: Record<string, string> = { white: "255,255,255", black: "0,0,0", red: "255,0,0", lime: "0,255,0", blue: "0,0,255", yellow: "255,255,0", gray: "128,128,128", grey: "128,128,128", silver: "192,192,192", navy: "0,0,128", green: "0,128,0", orange: "255,165,0", transparent: "transparent" };

// A colour as "r,g,b" ("transparent" for alpha 0), or undefined when it is not plainly one.
function colour(v: string | undefined): string | undefined {
  const t = (v ?? "").trim().toLowerCase();
  if (NAMED[t]) return NAMED[t];
  const hex = /^#([0-9a-f]{3,8})$/.exec(t)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const h = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    if (h.length === 8 && h.slice(6) === "00") return "transparent";
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(",");
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t);
  if (rgb) return rgb[4] !== undefined && parseFloat(rgb[4]) === 0 ? "transparent" : `${rgb[1]},${rgb[2]},${rgb[3]}`;
  return undefined;
}

const num = (v: string | undefined): { n: number; unit: string } | undefined => {
  const m = /^(-?\d*\.?\d+)\s*([a-z%]*)$/.exec((v ?? "").trim());
  return m ? { n: parseFloat(m[1]!), unit: m[2]! } : undefined;
};
const zero = (v: string | undefined) => num(v)?.n === 0;
const tiny = (v: string | undefined) => { const x = num(v); return !!x && (x.n === 0 || (["px", "pt"].includes(x.unit) && x.n <= 1)); };
const far = (v: string | undefined) => { const x = num(v); return !!x && x.n <= (["em", "rem", "vw", "vh", "%"].includes(x.unit) ? -50 : -1000); }; // off the page

function cssHides(s: Style): boolean {
  const g = (k: string) => s.get(k);
  const clipped = ["hidden", "clip"].some((o) => [g("overflow"), g("overflow-x"), g("overflow-y")].includes(o));
  const opacity = num(g("opacity"));
  const sized = (v: string | undefined) => (clipped ? tiny(v) : zero(v));
  return (
    g("display") === "none" ||
    ["hidden", "collapse"].includes(g("visibility") ?? "") ||
    g("mso-hide") === "all" ||
    tiny(g("font-size")) ||
    (!!opacity && opacity.n <= 0.01) ||
    (zero(g("width")) && zero(g("height"))) ||
    sized(g("width")) || sized(g("height")) || sized(g("max-height")) || sized(g("max-width")) ||
    /rect\(\s*0[a-z]*[\s,]+0[a-z]*[\s,]+0[a-z]*[\s,]+0/.test(g("clip") ?? "") ||
    /inset\(\s*(50|100)%/.test(g("clip-path") ?? "") ||
    far(g("text-indent")) || far(g("margin-left")) || far(g("margin-top")) ||
    (["absolute", "fixed"].includes(g("position") ?? "") && ["left", "top", "right", "bottom"].some((k) => far(g(k)))) ||
    /translate[xy]?\(\s*-\d{4,}/.test(g("transform") ?? "")
  );
}

// ---- the walk ----

interface Ctx { hidden: boolean; color?: string; bg?: string; pre: boolean }

const attr = (e: El, name: string) => e.attrs.find((a) => a.name === name)?.value;

export interface HtmlText { text: string; hidden: number } // hidden: parts left out (comments, hidden elements, script blocks)

export function htmlToText(html: string): HtmlText {
  const doc = parse(html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html);
  const rules: Rule[] = [];
  const queue: Node[] = [doc as Node];
  for (let n = queue.pop(); n; n = queue.pop()) { // the stylesheets first: the walk below needs them
    const e = n as El;
    if (e.nodeName === "style") rules.push(...rulesOf((e.childNodes ?? []).map((c) => (c as { value?: string }).value ?? "").join("")));
    for (const c of (e.childNodes ?? []) as Node[]) queue.push(c);
  }
  let out = "";
  let hidden = 0;
  const stack: ({ node: Node; ctx: Ctx } | { close: string })[] = [{ node: doc as Node, ctx: { hidden: false, pre: false } }];
  for (let t = stack.pop(); t; t = stack.pop()) {
    if ("close" in t) { out += t.close; continue; }
    const { node, ctx } = t;
    const name = node.nodeName;
    if (name === "#comment") { hidden++; continue; }
    if (name === "#text") { if (!ctx.hidden) out += ctx.pre ? (node as { value: string }).value : (node as { value: string }).value.replace(/[ \t\r\n\f]+/g, " "); continue; }
    if (name === "#documentType") continue;
    const el = node as El;
    let next = ctx;
    if (el.tagName) {
      if (DROPPED.has(name)) { if (!ctx.hidden && el.childNodes.length) hidden++; continue; }
      const style: Style = new Map();
      const cls = (attr(el, "class") ?? "").split(/\s+/);
      for (const r of rules) if ((!r.tag || r.tag === name) && (!r.cls || cls.includes(r.cls)) && (!r.id || r.id === attr(el, "id"))) declarations(r.style, style);
      declarations(attr(el, "style") ?? "", style);
      const bgSrc = style.get("background-color") ?? style.get("background") ?? attr(el, "bgcolor");
      const photo = /url\(/.test(style.get("background") ?? "") || style.has("background-image");
      const bg = photo ? undefined : colour(bgSrc?.split(/\s+/).find((w) => colour(w))) ?? ctx.bg;
      const color = colour(style.get("color") ?? (name === "font" ? attr(el, "color") : undefined)) ?? ctx.color;
      const mine = el.attrs.some((a) => a.name === "hidden") || cssHides(style) || color === "transparent" || (!!color && color === bg);
      if (mine && !ctx.hidden) hidden++;
      next = { hidden: ctx.hidden || mine, color, bg: bg === "transparent" ? undefined : bg, pre: ctx.pre || name === "pre" };
      if (BLOCK.has(name) && !next.hidden) {
        out += name === "li" ? "\n- " : "\n";
        stack.push({ close: name === "br" || name === "hr" ? "" : "\n" });
      } else if ((name === "td" || name === "th") && !next.hidden) out += " ";
    }
    const kids = (el.childNodes ?? []) as Node[];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, ctx: next });
  }
  const text = cleanText(out.replace(/ /g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/ {2,}/g, " ").replace(/\n{2,}/g, "\n").trim()).text;
  return { text, hidden };
}

// Does a string look like HTML (a document or markup tags), as opposed to plain text with a stray "<"?
export const looksLikeHtml = (s: string): boolean => /<(?:!doctype|!--|html|head|body|div|p|br|span|table|tr|td|a|b|i|u|ul|ol|li|h[1-6]|style|script|font|center|blockquote|img)[\s/>]/i.test(s);
