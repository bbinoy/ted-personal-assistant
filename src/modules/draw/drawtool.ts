import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emitRecord } from "../../core/events.ts";
import { sourceOfKey } from "../../core/ownerkey.ts";
import { adoptFile } from "../send/shots.ts";
import { MAX_SVG_CHARS } from "./svgclean.ts";
import { renderSvg } from "./svgrender.ts";

// draw: the model writes an SVG, code sanitises it (svgclean.ts), renders a PNG (svgrender.ts: no script, no network, no files), keeps it in the
// conversation's files as a held file, file1, file2... (shots.ts) and shows it back so the model can fix its layout once. Sending is the `send` tool's job
// (file: "file1"), to the conversation that asked and no other. The owner's chat and groups have it (agentrun.ts), the same code and rules.

type Told = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
const say = (text: string, isError = false): Told => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

// The tool body, apart from the server so tests can call it.
export async function drawNow(key: string, a: { svg: string }): Promise<Told> {
  const source = sourceOfKey(key);
  const r = await renderSvg(a.svg);
  if (!r.ok) {
    emitRecord("draw", "refused", source, { conversation: source, chars: a.svg.length });
    return say(`Not drawn: ${r.message}. Fix the SVG and call draw again.`, true);
  }
  const shot = adoptFile(key, r.png, "drawing.png");
  if (!shot) return say("Not drawn: too many files in this turn. Send one of the earlier ones.", true);
  emitRecord("draw", "drawn", source, { conversation: source, id: shot.id, size: r.png.length, removed: r.removed.length });
  const note = r.removed.length ? ` Parts that are not allowed were removed (${r.removed.join(", ")}); the picture may differ from what you meant.` : "";
  return {
    content: [
      { type: "image", data: r.png.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `Drawn as ${shot.id} (${r.width}x${r.height}).${note} Look at the picture: fix overlapping or cut-off text once if needed (draw again, a new id), then send it with send(file: "${shot.id}", caption). It has not been sent yet.` },
    ],
  };
}

export function createDrawServer(key: string) {
  return createSdkMcpServer({
    name: "draw",
    version: "1.0.0",
    tools: [
      tool(
        "draw",
        `Draw a picture from an SVG you write: a diagram, flowchart, chart, itinerary, schematic map, icon or rough sketch. Use it on your own judgement whenever a picture would explain the answer better than words (numbers to compare, a process, a plan over days), not only when asked; not for a simple fact or a yes or no. You get the rendered PNG back to check, with an id (file1...); then send it with the send tool (file: id). Not sent by this call. It is a sketch: no photos, no realistic or painterly images; emoji may not render; fonts are system fonts. Only plain shapes, paths, text, gradients and same-file references are drawn: no scripts, styles, images, links or filters (removed). Give the <svg> a viewBox and width and height (for example 800x600), text of at least 14 px, few colours, and no overlapping labels. Maximum ${MAX_SVG_CHARS / 1000} kB.`,
        {
          svg: z.string().min(20).max(MAX_SVG_CHARS).describe("The complete SVG markup, starting with <svg viewBox=... width=... height=...>."),
        },
        async (a) => drawNow(key, a),
      ),
    ],
  });
}
