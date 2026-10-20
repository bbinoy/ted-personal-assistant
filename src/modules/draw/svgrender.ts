import { Resvg, renderAsync, type ResvgRenderOptions } from "@resvg/resvg-js";
import { MAX_PICTURE_BYTES } from "../send/shots.ts";
import { cleanSvg } from "./svgclean.ts";

// SVG to PNG with resvg (Rust): it runs no script and fetches nothing. The input is always the sanitiser's rebuilt markup (svgclean.ts), which holds
// no image, href or url() outside the document, so there is nothing to load; resvg-js has no file or network resolver of its own for what is left.
// White background (a dark-mode viewer would show a transparent PNG as black), the long side between 800 and 1600 px.

export const MAX_SIDE = 1600;
export const MIN_SIDE = 800;
const FONT_FAMILY = process.platform === "darwin" ? "Helvetica" : process.platform === "win32" ? "Arial" : "DejaVu Sans";

export type Rendered = { ok: true; png: Buffer; width: number; height: number; removed: string[] } | { ok: false; message: string };

export async function renderSvg(input: string): Promise<Rendered> {
  const c = cleanSvg(input);
  if (!c.ok) return c;
  const opts = (fitTo: ResvgRenderOptions["fitTo"]): ResvgRenderOptions => ({ background: "#ffffff", fitTo, logLevel: "off", font: { loadSystemFonts: true, defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY } });
  try {
    const size = new Resvg(c.svg, { font: { loadSystemFonts: false } }); // (fast: the size does not depend on fonts)
    const { width: w, height: h } = size;
    const long = Math.max(w, h);
    if (!(w >= 1 && h >= 1) || !isFinite(long)) return { ok: false, message: "could not render: the drawing has no size (give the <svg> a viewBox and a width and height)" };
    const scale = long > MAX_SIDE ? MAX_SIDE / long : long < MIN_SIDE ? MIN_SIDE / long : 1;
    const img = await renderAsync(c.svg, opts({ mode: "zoom", value: scale })); // (off the event loop: loading the system fonts takes a second)
    const png = img.asPng();
    if (png.length > MAX_PICTURE_BYTES) return { ok: false, message: "the picture came out too large; draw it simpler" };
    return { ok: true, png, width: img.width, height: img.height, removed: c.removed };
  } catch (e) {
    return { ok: false, message: `could not render the SVG: ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 120)}` };
  }
}
