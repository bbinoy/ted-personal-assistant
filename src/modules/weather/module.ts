import { settings } from "../../core/settings.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// weather (weathertools.ts): public forecast and map data, read-only. The owner's chat and the owner's own background look (the surf-conditions skill's "when you look unprompted"), groups, and a tenant whose capabilities hold `weather`.
export const weatherModule: ToolModule = {
  name: "weather",
  connection: { kind: "in-process", name: "weather", when: (ctx) => (ctx.source === "chat" || ctx.source === "group" || ctx.source === "background") && settings.weather && ctx.offers("mcp__weather__get_forecast") },
  rows: rowsOf("mcp__weather__", "weather", "weather")("read", "search_places get_forecast get_marine_forecast get_spot_info get_distance", { only: ["chat", "group", "background"] }),
  free: true,
  trusted: true, // public forecast and map data: nothing a third party wrote about the owner
  skills: [{ name: "surf-conditions", shared: ["weather"], when: () => settings.weather }],
};
