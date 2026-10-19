import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { distanceKm, getForecast, getMarineForecast, getSpotInfo, searchPlaces } from "./weather.ts";

// weather: read-only tools for wind, waves and spots (weather.ts), for the owner's chat and wake-ups. They only fetch public data and return
// text; nothing is sent anywhere but the coordinates and a place name. The surf-conditions skill says how to use them.
const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
const lat = z.number().min(-90).max(90).describe("latitude, degrees");
const lon = z.number().min(-180).max(180).describe("longitude, degrees");

export function createWeatherServer() {
  return createSdkMcpServer({
    name: "weather",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool("search_places", "Find the latitude, longitude, elevation and time zone of a place by name. Small spots are often not found: use the coordinates saved in the spot's note.", { name: z.string().min(2).max(100) }, async (a) => reply(await searchPlaces(a.name)), { alwaysLoad: true }),
      tool(
        "get_forecast",
        "Forecast for a point: wind and gusts in knots, wind direction (where it blows FROM), cloud, rain, temperature and pressure, daylight hours only, local time. Hourly for today and tomorrow, every 3 hours after. Several models can be requested to compare them (for example icon_seamless, ecmwf_ifs025, gfs_seamless; in Switzerland also meteoswiss_icon_ch1 and icon_d2, which only cover the first day or two).",
        { lat, lon, days: z.number().int().min(1).max(16).default(3).describe("days ahead, today included; beyond about 7 the models are guesses"), models: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(4).optional() },
        async (a) => reply(await getForecast(a)),
        { alwaysLoad: true },
      ),
      tool("get_marine_forecast", "Waves, swell, sea temperature and sea level (tide) for a coastal point. Returns a plain message for a lake or an inland point.", { lat, lon, days: z.number().int().min(1).max(8).default(3) }, async (a) => reply(await getMarineForecast(a)), { alwaysLoad: true }),
      tool(
        "get_spot_info",
        "What is known about a launch point: from a seed list of kite spots (rideable wind directions, water, notes) if it is listed, otherwise which wind directions are onshore, side-on or offshore from map data. The answer does not change: save it in the spot's note.",
        { lat, lon },
        async (a) => reply(await getSpotInfo(a)),
        { alwaysLoad: true },
      ),
      tool("get_distance", "Straight-line distance between two points.", { from_lat: lat, from_lon: lon, to_lat: lat, to_lon: lon }, async (a) => reply(distanceKm({ lat: a.from_lat, lon: a.from_lon }, { lat: a.to_lat, lon: a.to_lon })), { alwaysLoad: true }),
    ],
  });
}
