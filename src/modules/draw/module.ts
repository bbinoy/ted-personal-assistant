import { settings } from "../../core/settings.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// draw (drawtool.ts): an SVG sanitised and rendered by code to a PNG kept for the turn; nothing leaves until `send` delivers it. Needs a conversation.
export const drawModule: ToolModule = {
  name: "draw",
  connection: { kind: "in-process", name: "draw", when: (ctx) => !!ctx.key && settings.draw && ctx.offers("mcp__draw__draw") },
  rows: rowsOf("mcp__draw__", "draw", "draw")("draw", "draw", { only: ["chat", "group"] }),
  free: true,
  skills: [{ name: "draw", shared: ["draw"], when: () => settings.draw }],
};
