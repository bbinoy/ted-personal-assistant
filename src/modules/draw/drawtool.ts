import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { audit } from "../../audit.ts";
import { sourceOfKey } from "../../ownerkey.ts";
import { adoptDrawing } from "../send/shots.ts";
import { MAX_SVG_CHARS } from "./svgclean.ts";
import { renderSvg } from "./svgrender.ts";

// draw: the model writes an SVG, code sanitises it (svgclean.ts), renders a PNG (svgrender.ts: no script, no network, no files), keeps it in the
// conversation's turn as img1, img2... (shots.ts) and shows it back so the model can fix its layout once. Sending is the `send` tool's job
// (picture: "img1"), to the conversation that asked and no other. The owner's chat and groups have it (agentrun.ts), the same code and rules.

type Told = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
const say = (text: string, isError = false): Told => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

// The tool body, apart from the server so tests can call it.
export async function drawNow(key: string, a: { svg: string; caption?: string }): Promise<Told> {
  const source = sourceOfKey(key);
  const r = await renderSvg(a.svg);
  if (!r.ok) {
    audit("draw", "refused", source, { conversation: source, chars: a.svg.length });
    return say(`Not drawn: ${r.message}. Fix the SVG and call draw again.`, true);
  }
  const shot = adoptDrawing(key, r.png, a.caption ?? "");
  if (!shot) return say("Not drawn: too many drawings in this turn. Send one of the earlier ones.", true);
  audit("draw", "drawn", source, { conversation: source, id: shot.id, size: shot.size, removed: r.removed.length });
  const note = r.removed.length ? ` Parts that are not allowed were removed (${r.removed.join(", ")}); the picture may differ from what you meant.` : "";
  return {
    content: [
      { type: "image", data: r.png.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `Drawn as ${shot.id} (${r.width}x${r.height}).${note} Look at the picture: fix overlapping or cut-off text once if needed (draw again, a new id), then send it with send(picture: "${shot.id}", caption). It has not been sent yet.` },
    ],
  };
}

export function createDrawServer(key: string) {
  return createSdkMcpServer({
    name: "draw",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "draw",
        `Draw a picture from an SVG you write: a diagram, flowchart, chart, itinerary, schematic map, icon or rough sketch. Use it on your own judgement whenever a picture would explain the answer better than words (numbers to compare, a process, a plan over days), not only when asked; not for a simple fact or a yes or no. You get the rendered PNG back to check, with an id (img1...); then send it with the send tool (picture: id). Not sent by this call. It is a sketch: no photos, no realistic or painterly images; emoji may not render; fonts are system fonts. Only plain shapes, paths, text, gradients and same-file references are drawn: no scripts, styles, images, links or filters (removed). Give the <svg> a viewBox and width and height (for example 800x600), text of at least 14 px, few colours, and no overlapping labels. Maximum ${MAX_SVG_CHARS / 1000} kB.`,
        {
          svg: z.string().min(20).max(MAX_SVG_CHARS).describe("The complete SVG markup, starting with <svg viewBox=... width=... height=...>."),
          caption: z.string().max(300).optional().describe("A short line for the picture, used when you send it."),
        },
        async (a) => drawNow(key, a),
        { alwaysLoad: true },
      ),
    ],
  });
}
