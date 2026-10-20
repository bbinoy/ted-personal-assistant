import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { cleanSvg, MAX_ELEMENTS, MAX_PATH_CHARS, MAX_SVG_CHARS } from "../src/modules/draw/svgclean.ts";
import { MAX_SIDE, renderSvg } from "../src/modules/draw/svgrender.ts";
import { MAX_PICTURE_BYTES, isPng } from "../src/shots.ts";

// The sanitiser rebuilds the model's SVG from an allowlist (svgclean.ts); the renderer runs no script and loads nothing (svgrender.ts).

const wrap = (inner: string, attrs = ` viewBox="0 0 200 100" width="200" height="100"`) => `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`;
const FORBIDDEN = /<script|<style|<image|<a[ >]|foreignobject|<animate|<set[ >]|<iframe|<!doctype|<!entity|<\?|@import|javascript:|data:|https?:|file:|\bon[a-z]+=|xlink|<html|<body|&lol/i;

// RGBA pixels of an 8-bit RGBA PNG without interlacing (what resvg writes).
function pixels(png: Buffer): { width: number; height: number; px: Buffer } {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.deepEqual([png[24], png[25], png[28]], [8, 6, 0]);
  const parts: Buffer[] = [];
  for (let i = 8; i < png.length; ) {
    const len = png.readUInt32BE(i);
    if (png.toString("latin1", i + 4, i + 8) === "IDAT") parts.push(png.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 4, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4]! : 0, b = y ? px[(y - 1) * stride + x]! : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]!;
      px[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + pred) & 255;
    }
  }
  return { width, height, px };
}

// Each hostile input either fails with a short message or comes out clean; either way nothing forbidden is in the output.
const HOSTILE: [string, string][] = [
  ["script", wrap(`<script>alert(1)</script><rect width="10" height="10"/>`)],
  ["script in a group", wrap(`<g><script type="text/javascript">fetch('//x')</script></g>`)],
  ["onload", wrap(`<rect width="10" height="10" onclick="x()"/>`, ` viewBox="0 0 10 10" width="10" height="10" onload="alert(1)"`)],
  ["onbegin on animate", wrap(`<rect width="5" height="5"><animate attributeName="x" onbegin="x()" from="0" to="9"/><set attributeName="fill" to="red"/></rect>`)],
  ["javascript href", wrap(`<a href="javascript:alert(1)"><rect width="10" height="10"/></a>`)],
  ["javascript href on use", wrap(`<use href="javascript:alert(1)"/><use xlink:href="javascript:alert(1)"/>`)],
  ["external image", wrap(`<image href="http://evil.example/x.png" width="10" height="10"/>`)],
  ["data uri image", wrap(`<image href="data:image/png;base64,AAAA" width="10" height="10"/>`)],
  ["external use", wrap(`<use href="http://evil.example/a.svg#x"/><use href="//evil.example/a.svg#x"/><use href="file:///etc/passwd#x"/>`)],
  ["relative use", wrap(`<use href="other.svg#x"/>`)],
  ["external url() fill", wrap(`<rect width="10" height="10" fill="url(http://evil.example/p.svg#x)"/>`)],
  ["quoted external url()", wrap(`<rect width="10" height="10" fill="url('http://evil.example/p')" stroke="URL(  data:text/html,x )"/>`)],
  ["escaped url in style", wrap(`<rect width="10" height="10" style="fill:u\\72l(http://evil.example/x)"/>`)],
  ["foreignObject", wrap(`<foreignObject width="100" height="100"><iframe src="http://evil.example"></iframe><div>hi</div></foreignObject>`)],
  ["DOCTYPE with entity", `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` + wrap(`<text x="1" y="20">&xxe;</text>`)],
  ["billion laughs", `<!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>` + wrap(`<text x="1" y="20">&lol3;</text>`)],
  ["processing instruction", `<?xml-stylesheet href="http://evil.example/x.css"?>` + wrap(`<rect width="5" height="5"/>`)],
  ["CDATA trick", wrap(`<text x="1" y="20"><![CDATA[</text><script>alert(1)</script><text>]]></text>`)],
  ["mixed-case tags", `<SVG ViewBox="0 0 10 10" width="10" height="10"><ScRiPt>alert(1)</ScRiPt><IMAGE href="http://evil.example/x"/><ForeignObject/></SVG>`],
  ["namespace tricks", `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><svg:script>alert(1)</svg:script></svg:svg>` + wrap(`<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>`)],
  ["html in svg", wrap(`<p onclick="x()">hi</p><img src="http://evil.example/x" onerror="x()"><iframe srcdoc="x"></iframe>`)],
  ["style element with @import", wrap(`<style>@import url(http://evil.example/x.css); rect{fill:url(http://evil.example/y)}</style><rect width="5" height="5" class="a"/>`)],
  ["style attribute with @import and comment", wrap(`<rect width="5" height="5" style="fill:red/*;*/;background:url(http://evil.example/x)"/><rect width="5" height="5" style="@import 'http://evil.example/x'"/>`)],
  ["css url in a normal attribute", wrap(`<rect width="5" height="5" stroke="red; background:url(http://evil.example/z)" filter="url(http://evil.example/f)"/>`)],
  ["unknown filter reference", wrap(`<rect width="5" height="5" filter="url(#f)"/><filter id="f"><feImage href="http://evil.example/x"/></filter>`)],
  ["javascript in text and title", wrap(`<title onclick="x()">t</title><text x="1" y="20" onfocus="x()">ok</text>`)],
  ["huge path", wrap(`<path d="M0 0 ${"L1 1 ".repeat(MAX_PATH_CHARS / 5 + 10)}"/>`)],
  ["deep nesting", wrap("<g>".repeat(500) + "</g>".repeat(500))],
  ["10k elements", wrap(`<rect width="1" height="1"/>`.repeat(10_000)).slice(0, MAX_SVG_CHARS)],
  ["too many elements within the size", wrap(`<g/>`.repeat(MAX_ELEMENTS + 5))],
  ["too long", wrap(`<text x="1" y="20">${"a".repeat(MAX_SVG_CHARS)}</text>`)],
  ["self-referencing use", wrap(`<g id="a"><use href="#a"/></g>`)],
  ["use loop", wrap(`<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>`)],
  ["exponential use chain", wrap(`<g id="g0"><rect width="1" height="1"/></g>` + Array.from({ length: 12 }, (_, i) => `<g id="g${i + 1}">${`<use href="#g${i}"/>`.repeat(10)}</g>`).join("") + `<use href="#g12"/>`)],
  ["exponential pattern chain", wrap(`<pattern id="p0" width="1" height="1"><rect width="1" height="1"/></pattern>` + Array.from({ length: 12 }, (_, i) => `<pattern id="p${i + 1}" width="1" height="1">${`<rect width="1" height="1" fill="url(#p${i})"/>`.repeat(10)}</pattern>`).join("") + `<rect width="9" height="9" fill="url(#p12)"/>`)],
  ["no svg at all", `<html><body><script>alert(1)</script></body></html>`],
  ["empty", "   "],
];

test("svgclean: hostile input never comes out with anything that runs, fetches or reads", () => {
  for (const [name, input] of HOSTILE) {
    const r = cleanSvg(input);
    if (r.ok) {
      assert.doesNotMatch(r.svg.replace(/^<svg xmlns="[^"]*"/, "<svg"), FORBIDDEN, `${name}: ${r.svg}`);
      assert.match(r.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, name);
    } else {
      assert.ok(r.message.length > 0 && r.message.length < 200, `${name}: ${r.message}`);
    }
  }
});

test("svgclean: the limits stop the whole drawing with a message the model can act on", () => {
  const msg = (name: string) => {
    const r = cleanSvg(HOSTILE.find(([n]) => n === name)![1]);
    assert.equal(r.ok, false, name);
    return r.ok ? "" : r.message;
  };
  assert.match(msg("huge path"), /path data is too long/);
  assert.match(msg("deep nesting"), /nested deeper/);
  assert.match(msg("too many elements within the size"), /too many elements/);
  assert.match(msg("too long"), /too long/);
  assert.match(msg("self-referencing use"), /refers to itself/);
  assert.match(msg("use loop"), /refers to itself/);
  assert.match(msg("exponential use chain"), /expand to too many/);
  assert.match(msg("exponential pattern chain"), /expand to too many/);
  assert.match(msg("no svg at all"), /no <svg> element/);
  assert.match(msg("empty"), /empty/);
});

test("svgclean: what is removed is reported and the rest survives", () => {
  const r = cleanSvg(wrap(`<script>x()</script><rect id="r" x="1" y="2" width="10" height="10" fill="url(http://evil.example/x)" stroke="#123456" onclick="x()"/><image href="http://evil.example/x"/>`));
  assert.ok(r.ok);
  assert.equal(r.svg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect id="r" x="1" y="2" width="10" height="10" stroke="#123456"></rect></svg>`);
  assert.deepEqual([...r.removed].sort(), ["fill", "image", "onclick", "script"]);
});

test("svgclean: a same-document reference and an allowed style survive; text is escaped", () => {
  const r = cleanSvg(wrap(`<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient><g id="s"><circle r="3"/></g></defs><use href="#s" x="5"/><use xlink:href="#s"/><rect width="9" height="9" fill="url(#g)" style="stroke:blue; opacity: 0.5; background: red"/><text x="1" y="20">a &lt;b&gt; &amp; "c"</text>`));
  assert.ok(r.ok);
  assert.match(r.svg, /<use href="#s" x="5">/);
  assert.match(r.svg, /fill="url\(#g\)"/);
  assert.match(r.svg, /stroke="blue"/);
  assert.match(r.svg, /opacity="0\.5"/);
  assert.doesNotMatch(r.svg, /background/);
  assert.match(r.svg, />a &lt;b&gt; &amp; &quot;c&quot;</);
});

const BAR_CHART = `<svg viewBox="0 0 600 400" width="600" height="400" xmlns="http://www.w3.org/2000/svg" font-family="Helvetica, Arial, sans-serif">
  <rect width="600" height="400" fill="#ffffff"/>
  <text x="300" y="30" font-size="20" text-anchor="middle" font-weight="bold">Sales per quarter</text>
  <line x1="60" y1="340" x2="560" y2="340" stroke="#333" stroke-width="2"/>
  <line x1="60" y1="60" x2="60" y2="340" stroke="#333" stroke-width="2"/>
  <rect x="90" y="200" width="80" height="140" fill="#3b6fb6"/><rect x="200" y="140" width="80" height="200" fill="#3b6fb6"/>
  <rect x="310" y="100" width="80" height="240" fill="#3b6fb6"/><rect x="420" y="170" width="80" height="170" fill="#3b6fb6"/>
  <text x="130" y="192" font-size="14" text-anchor="middle">70</text><text x="240" y="132" font-size="14" text-anchor="middle">100</text>
  <text x="350" y="92" font-size="14" text-anchor="middle">120</text><text x="460" y="162" font-size="14" text-anchor="middle">85</text>
  <text x="130" y="362" font-size="14" text-anchor="middle">Q1</text><text x="240" y="362" font-size="14" text-anchor="middle">Q2</text>
  <text x="350" y="362" font-size="14" text-anchor="middle">Q3</text><text x="460" y="362" font-size="14" text-anchor="middle">Q4</text>
</svg>`;
const FLOWCHART = `<svg viewBox="0 0 400 420" width="400" height="420" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0 0 L9 3 L0 6 z" fill="#333"/></marker>
  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8f0fb"/><stop offset="1" stop-color="#c9dcf5"/></linearGradient></defs>
  <rect x="120" y="20" width="160" height="50" rx="25" fill="url(#g)" stroke="#333"/><text x="200" y="51" font-size="16" text-anchor="middle">Start</text>
  <line x1="200" y1="70" x2="200" y2="120" stroke="#333" stroke-width="2" marker-end="url(#arrow)"/>
  <polygon points="200,120 290,170 200,220 110,170" fill="#fff6d6" stroke="#333"/><text x="200" y="175" font-size="16" text-anchor="middle">Ready?</text>
  <line x1="200" y1="220" x2="200" y2="280" stroke="#333" stroke-width="2" marker-end="url(#arrow)"/><text x="212" y="255" font-size="14">yes</text>
  <rect x="120" y="280" width="160" height="50" fill="url(#g)" stroke="#333"/><text x="200" y="311" font-size="16" text-anchor="middle">Go</text>
  <path d="M290 170 C340 170 340 380 210 380" fill="none" stroke="#333" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#arrow)"/><text x="320" y="160" font-size="14">no</text>
</svg>`;

test("svgclean: a bar chart and a flowchart survive and render", async () => {
  for (const [name, svg, parts] of [["bar chart", BAR_CHART, 4], ["flowchart", FLOWCHART, 3]] as const) {
    const c = cleanSvg(svg);
    assert.ok(c.ok, name);
    assert.deepEqual(c.removed, [], name);
    assert.ok((c.svg.match(/<(rect|polygon|path)/g) ?? []).length >= parts, name);
    assert.match(c.svg, /<text/);
    const r = await renderSvg(svg);
    assert.ok(r.ok, name);
    assert.ok(isPng(r.png) && r.png.length > 500 && r.png.length <= MAX_PICTURE_BYTES, name);
  }
  const flow = cleanSvg(FLOWCHART);
  assert.ok(flow.ok);
  assert.match(flow.svg, /marker-end="url\(#arrow\)"/);
});

test("svgrender: a PNG with the magic bytes, a white background, the size rules; a broken SVG gives the short message", async () => {
  const small = await renderSvg(wrap(`<circle cx="100" cy="50" r="20" fill="#ff0000"/>`));
  assert.ok(small.ok);
  assert.deepEqual([...small.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(small.png.length <= MAX_PICTURE_BYTES);
  assert.deepEqual([small.width, small.height], [800, 400], "a small drawing is scaled up to 800 px on the long side");
  // the corner is opaque white (not transparent, not black), the middle is the red circle
  const { px } = pixels(small.png);
  assert.deepEqual([...px.subarray(0, 4)], [255, 255, 255, 255]);
  const mid = (200 * 800 + 400) * 4;
  assert.deepEqual([...px.subarray(mid, mid + 4)], [255, 0, 0, 255]);
  const big = await renderSvg(wrap(`<rect width="10" height="10"/>`, ` viewBox="0 0 5000 2000" width="5000" height="2000"`));
  assert.ok(big.ok);
  assert.deepEqual([big.width, big.height], [MAX_SIDE, 640]);
  for (const bad of ["<svg", "not svg at all", wrap(`<path d="M 0 0 L"/>`, ``), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 0" width="0" height="0"></svg>`]) {
    const r = await renderSvg(bad);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.ok(r.message.length > 0 && r.message.length < 250, r.message);
  }
});

test("svgrender: text is drawn (not a blank picture)", async () => {
  const r = await renderSvg(wrap(`<text x="10" y="60" font-size="40" fill="#000">Hello</text>`));
  assert.ok(r.ok);
  const { px } = pixels(r.png);
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i]! < 100) dark++;
  assert.ok(dark > 200, `dark pixels: ${dark}`);
});

test("svgrender: nothing is fetched or read, whatever the markup asks", async () => {
  // the sanitiser removes these before resvg sees them; the picture is still a valid, plain PNG
  const r = await renderSvg(wrap(`<image href="/etc/passwd" width="50" height="50"/><image href="http://127.0.0.1:9/x.png" width="50" height="50"/><rect width="20" height="20" fill="url(file:///etc/passwd)"/>`));
  assert.ok(r.ok);
  assert.ok(r.removed.includes("image"));
});
