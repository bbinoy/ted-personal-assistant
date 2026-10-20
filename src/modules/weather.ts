import { settings } from "../settings.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// weather (weathertools.ts): public forecast and map data, read-only. The owner's chat and groups, and a tenant whose capabilities hold `weather`.
export const weatherModule: ToolModule = {
  name: "weather",
  connection: { kind: "in-process", name: "weather", when: (ctx) => (ctx.source === "chat" || ctx.source === "group") && settings.weather && ctx.offers("mcp__weather__get_forecast") },
  rows: rowsOf("mcp__weather__", "weather", "weather")("read", "search_places get_forecast get_marine_forecast get_spot_info get_distance", { only: ["chat", "group"] }),
  free: true,
  trusted: true, // public forecast and map data: nothing a third party wrote about the owner
  skills: [{ name: "surf-conditions", shared: ["weather"], when: () => settings.weather }],
};
