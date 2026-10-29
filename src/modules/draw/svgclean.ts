import { parse, type DefaultTreeAdapterMap } from "parse5";

// The sanitiser for a drawing the model wrote as SVG (drawtool.ts). The model's markup is untrusted: it can be shaped by a hostile page or mail it read.
// The input is parsed (parse5, never regex on raw markup) and the output is REBUILT from an allowlist of elements and presentation attributes, never
// the input echoed. Nothing that can run, fetch or read is kept: no script, style, foreignObject, image, a, animate/set, no on* attribute, no reference
// except a same-document #id, no DOCTYPE or entity (the parser never expands them), no processing instruction. Size, element count, nesting depth,
// path data and the cost of reference expansion (use / url(#id) chains) are capped. Pure: no I/O, no native code (the render is svgrender.ts).

type Node = DefaultTreeAdapterMap["node"];
type El = DefaultTreeAdapterMap["element"];

export const MAX_SVG_CHARS = 60_000;
export const MAX_ELEMENTS = 2000;
const MAX_DEPTH = 32;
export const MAX_PATH_CHARS = 20_000;
const MAX_TEXT_CHARS = 4000;
const MAX_COST = 20_000; // elements after following every use / url(#id) reference: bounds the work of a render
const SVG_NS = "http://www.w3.org/2000/svg";

const ELEMENTS = new Set(["svg", "g", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "symbol", "use", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "title", "desc", "marker"]);
const TEXT_PARENTS = new Set(["text", "tspan", "title", "desc"]);
const HREF_PARENTS = new Set(["use", "linearGradient", "radialGradient", "pattern"]);
const ATTRS = new Set([
  "id", "viewBox", "preserveAspectRatio", "width", "height", "x", "y", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "fx", "fy", "points", "d", "transform", "offset",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit",
  "opacity", "stop-color", "stop-opacity", "visibility", "display", "clip-path", "clip-rule", "mask", "marker-start", "marker-mid", "marker-end",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "letter-spacing", "text-decoration", "dx", "dy",
  "gradientUnits", "gradientTransform", "spreadMethod", "patternUnits", "patternContentUnits", "patternTransform", "clipPathUnits", "maskUnits", "maskContentUnits", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
]);
const URL_ATTRS = new Set(["fill", "stroke", "clip-path", "mask", "marker-start", "marker-mid", "marker-end"]); // may point at a same-document #id: url(#id)
const LONG_ATTRS = new Set(["d", "points"]);
const ID = /^[A-Za-z_][\w.-]{0,63}$/;
const URL_REF = /^url\(\s*#([A-Za-z_][\w.-]{0,63})\s*\)(\s+[#\w.,()%-]+)?$/; // url(#id) with an optional fallback colour
const SAFE_VALUE = /^[\w\s#%.,+()'"-]*$/; // no colon, semicolon, backslash, slash, @, <, >, &: nothing that makes a scheme, a comment, a second declaration or markup
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export type Cleaned = { ok: true; svg: string; removed: string[] } | { ok: false; message: string };

const fail = (message: string): Cleaned => ({ ok: false, message });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const label = (s: string) => s.replace(/[^\w:.-]/g, "").slice(0, 24) || "?";

// A value of an allowed attribute, or undefined when it must go.
function value(name: string, raw: string): string | undefined {
  const v = raw.trim();
  if (name === "id") return ID.test(v) ? v : undefined;
  if (v.length > (LONG_ATTRS.has(name) ? MAX_PATH_CHARS : 200)) return undefined;
  if (/url\s*\(/i.test(v)) return URL_ATTRS.has(name) && URL_REF.test(v) ? v : undefined;
  return SAFE_VALUE.test(v) ? v : undefined;
}

// A style attribute reduced to its allowed declarations (they become plain attributes); anything with a comment, an escape or an @ goes whole.
function styleDeclarations(raw: string): [string, string][] | undefined {
  if (/[\\@]|\/\*/.test(raw)) return undefined;
  const out: [string, string][] = [];
  for (const part of raw.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    if (ATTRS.has(name) && name !== "id") out.push([name, part.slice(i + 1).trim()]);
  }
  return out;
}

interface Built {
  tag: string;
  attrs: [string, string][];
  kids: (Built | string)[];
  id?: string;
  refs: string[]; // same-document ids it points at
}

// Rebuilds one element, or undefined when it is not allowed. `state.fail` is set for a limit that stops the whole drawing.
function rebuild(el: El, depth: number, state: { count: number; fail?: string; removed: string[]; ids: Map<string, Built> }): Built | undefined {
  if (state.fail) return undefined;
  if (el.namespaceURI !== SVG_NS || !ELEMENTS.has(el.tagName)) {
    state.removed.push(label(el.tagName)); // the whole subtree goes with it
    return undefined;
  }
  if (++state.count > MAX_ELEMENTS) return void (state.fail = `too many elements (the limit is ${MAX_ELEMENTS}); draw it simpler`);
  if (depth > MAX_DEPTH) return void (state.fail = `nested deeper than ${MAX_DEPTH} levels; flatten the groups`);
  const b: Built = { tag: el.tagName, attrs: [], kids: [], refs: [] };
  const put = (name: string, raw: string) => {
    const v = value(name, raw);
    if (v === undefined) return void state.removed.push(label(name));
    b.attrs = [...b.attrs.filter(([n]) => n !== name), [name, v]];
    if (name === "id") b.id = v;
    for (const m of v.matchAll(/url\(\s*#([\w.-]+)\s*\)/g)) b.refs.push(m[1]!);
  };
  for (const a of el.attrs) {
    const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
    if (name === "href" || name === "xlink:href") {
      const m = /^#([A-Za-z_][\w.-]{0,63})$/.exec(a.value.trim());
      if (m && HREF_PARENTS.has(el.tagName)) b.refs.push(m[1]!), (b.attrs = [...b.attrs.filter(([n]) => n !== "href"), ["href", `#${m[1]}`]]);
      else state.removed.push(label(name));
    } else if (name === "style") {
      const decls = styleDeclarations(a.value);
      if (!decls) state.removed.push("style");
      for (const [n, v] of decls ?? []) put(n, v);
    } else if (ATTRS.has(name)) {
      if (LONG_ATTRS.has(name) && a.value.length > MAX_PATH_CHARS) return void (state.fail = `path data is too long (the limit is ${MAX_PATH_CHARS} characters); use fewer points`);
      put(name, a.value);
    } else if (name !== "xmlns" && name !== "version" && name !== "class") {
      state.removed.push(label(name));
    }
  }
  if (b.id) state.ids.set(b.id, b);
  for (const c of el.childNodes) {
    if (c.nodeName === "#text" && TEXT_PARENTS.has(el.tagName)) {
      const t = (c as DefaultTreeAdapterMap["textNode"]).value.replace(CONTROL, "");
      if (t.length > MAX_TEXT_CHARS) return void (state.fail = `a text is too long (the limit is ${MAX_TEXT_CHARS} characters)`);
      b.kids.push(t);
    } else if ("tagName" in c) {
      const k = rebuild(c as El, depth + 1, state);
      if (k) b.kids.push(k);
    }
  }
  return b;
}

const children = (b: Built) => b.kids.filter((k): k is Built => typeof k !== "string");

// How many elements a render would draw once every reference is followed (use and url(#id) can multiply a few elements into billions). A cycle or
// a total over the cap stops the drawing; a reference to nothing is just dropped by the renderer.
function cost(root: Built, ids: Map<string, Built>): string | undefined {
  const memo = new Map<Built, number>();
  const active = new Set<Built>();
  let cyc = false;
  const walk = (b: Built): number => {
    const known = memo.get(b);
    if (known !== undefined) return known;
    if (active.has(b)) {
      cyc = true;
      return 0;
    }
    active.add(b);
    let n = 1;
    for (const k of children(b)) n += walk(k);
    for (const r of b.refs) {
      const t = ids.get(r);
      if (t) n += walk(t);
    }
    active.delete(b);
    n = Math.min(n, MAX_COST + 1);
    memo.set(b, n);
    return n;
  };
  const total = walk(root);
  if (cyc) return "an element refers to itself (use or url(#id) in a loop)";
  return total > MAX_COST ? "the references (use, gradients, patterns) expand to too many elements; draw it simpler" : undefined;
}

function serialise(b: Built): string {
  const attrs = b.attrs.map(([n, v]) => ` ${n}="${esc(v)}"`).join("");
  const inner = b.kids.map((k) => (typeof k === "string" ? esc(k) : serialise(k))).join("");
  return `<${b.tag}${b.tag === "svg" ? ` xmlns="${SVG_NS}"` : ""}${attrs}>${inner}</${b.tag}>`;
}

const find = (n: Node): El | undefined => {
  for (const c of "childNodes" in n ? n.childNodes : []) {
    if ("tagName" in c && c.tagName === "svg" && c.namespaceURI === SVG_NS) return c;
    const f = "tagName" in c && c.tagName !== "svg" ? find(c) : undefined;
    if (f) return f;
  }
  return undefined;
};

export function cleanSvg(input: string): Cleaned {
  if (typeof input !== "string" || !input.trim()) return fail("not valid SVG: it is empty");
  if (input.length > MAX_SVG_CHARS) return fail(`the SVG is too long (${input.length} characters, the limit is ${MAX_SVG_CHARS}); draw it simpler`);
  const doc = parse(input.replace(CONTROL, ""));
  const root = find(doc);
  if (!root) return fail("not valid SVG: there is no <svg> element");
  const state = { count: 0, fail: undefined as string | undefined, removed: [] as string[], ids: new Map<string, Built>() };
  if (doc.childNodes.some((c) => c.nodeName === "#documentType")) state.removed.push("DOCTYPE");
  const built = rebuild(root, 0, state);
  if (state.fail) return fail(state.fail);
  if (!built) return fail("not valid SVG: there is no <svg> element");
  if (!built.attrs.some(([n]) => n === "viewBox") && !(built.attrs.some(([n]) => n === "width") && built.attrs.some(([n]) => n === "height"))) return fail("the <svg> needs a viewBox (like viewBox=\"0 0 800 600\") and a width and height");
  const loop = cost(built, state.ids);
  if (loop) return fail(loop);
  return { ok: true, svg: serialise(built), removed: [...new Set(state.removed)].slice(0, 12) };
}
