import { test } from "node:test";
import assert from "node:assert/strict";
import { getForecast, getMarineForecast, getSpotInfo, searchPlaces, type WeatherIo } from "../src/modules/weather/weather.ts";
import { nearestSpot } from "../src/modules/weather/kitespots.ts";
import { exposure, featuresFrom, rings, type Ring } from "../src/modules/weather/shore.ts";
import { access } from "./util.ts";
import { ownerSkills } from "../src/skills.ts";
import { settings } from "../src/settings.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const io = (body: unknown, status = 200): WeatherIo => ({ fetch: async () => json(body, status), now: () => new Date("2026-10-19T08:30:00Z") }); // 10:30 local (UTC+2)

// Two days of hourly data from 00:00 on 19 Oct, plus a third day, in Open-Meteo's shape.
function forecastBody() {
  const time: string[] = [], wind: number[] = [], gust: number[] = [], dir: number[] = [];
  for (const day of ["2026-10-19", "2026-10-20", "2026-10-21"]) for (let h = 0; h < 24; h++) {
    time.push(`${day}T${String(h).padStart(2, "0")}:00`);
    wind.push(10 + h / 4); gust.push(15 + h / 4); dir.push(225);
  }
  const n = time.length, fill = (v: number) => Array<number>(n).fill(v);
  return {
    latitude: 47.12, longitude: 9.32, elevation: 431, timezone: "Europe/Zurich", utc_offset_seconds: 7200,
    hourly: { time, wind_speed_10m: wind, wind_gusts_10m: gust, wind_direction_10m: dir, cloud_cover: fill(40), precipitation: fill(0), temperature_2m: fill(12), pressure_msl: fill(1020) },
    daily: { time: ["2026-10-19", "2026-10-20", "2026-10-21"], sunrise: ["2026-10-19T07:46", "2026-10-20T07:47", "2026-10-21T07:49"], sunset: ["2026-10-19T18:28", "2026-10-20T18:26", "2026-10-21T18:24"] },
  };
}

test("forecast: knots, local daylight hours from now, hourly for two days then every three hours, header names the grid point", async () => {
  const out = await getForecast({ lat: 47.12, lon: 9.31, days: 3 }, io(forecastBody()));
  const lines = out.split("\n");
  assert.match(lines[0]!, /47\.12N 9\.31E \(grid 47\.12, 9\.32\) elev 431 m, Europe\/Zurich, best_match/);
  assert.match(out, /Mon 19 Oct {2}sunrise 07:46 {2}sunset 18:28/);
  const day1 = lines.slice(lines.findIndex((l) => l.startsWith("Mon 19")) + 2, lines.findIndex((l) => l.startsWith("Tue 20")));
  assert.equal(day1[0]!.slice(0, 2), "10", "starts at the current local hour"); // now is 10:30 local: the 10:00 row is the first not before 10
  assert.equal(day1.at(-1)!.slice(0, 2), "18", "ends at sunset");
  assert.match(day1[0]!, /SW 225/);
  const day3 = lines.slice(lines.findIndex((l) => l.startsWith("Wed 21")) + 2);
  assert.deepEqual(day3.map((l) => l.slice(0, 2)), ["09", "12", "15", "18"], "every three hours from the third day");
  assert.ok(!/(^|\n)0[0-6]\s/.test(out), "no night hours");
});

test("forecast: errors are short plain text the model can act on", async () => {
  assert.match(await getForecast({ lat: 1, lon: 1 }, io({ error: true, reason: "Latitude must be in range" })), /^weather service: Latitude must be in range/);
  assert.match(await searchPlaces("Yvonand", io({ generationtime_ms: 1 })), /no place found for "Yvonand".*coordinates/);
});

test("marine: a lake gives a plain message, a coast gives a table", async () => {
  const lake = { latitude: 47.1, longitude: 9.3, timezone: "Europe/Zurich", utc_offset_seconds: 7200, hourly: { time: ["2026-10-19T12:00"], wave_height: [null] } };
  assert.match(await getMarineForecast({ lat: 47.1, lon: 9.3 }, io(lake)), /^no marine data for this point: inland or a lake/);
  const k = (v: number) => [v];
  const coast = { latitude: 43.7, longitude: -1.4, timezone: "Europe/Paris", utc_offset_seconds: 7200, hourly: { time: ["2026-10-19T12:00"], wave_height: k(1.4), wave_period: k(9), wave_direction: k(323), swell_wave_height: k(1.1), swell_wave_period: k(10), swell_wave_direction: k(310), wind_wave_height: k(0.1), sea_surface_temperature: k(19), sea_level_height_msl: k(-0.15) } };
  assert.match(await getMarineForecast({ lat: 43.7, lon: -1.4 }, io(coast)), /12 {1}1\.4 {3}9 {4}NW 323 {2}1\.1.*-0\.15/);
});

// A square lake, 0.1 degrees on a side, as one closed way.
const square: Ring = [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]];

test("shore: wind over the lake is onshore, wind from the land side is offshore, along the shore is side-on", () => {
  const r = exposure(0.0008, 0.05, [rings([square])]); // just inside the south shore
  assert.ok(!("error" in r));
  const at = (from: number) => r.table.find((x) => x.from === from)!.fetchM;
  assert.ok(at(0) > 5000, "north: across the lake");
  assert.ok(at(180) <= 350, "south: from the land");
  assert.ok(at(90) > 1500 && at(270) > 1500, "east and west run along the shore, still over water: long fetch");
});

test("shore: a point inland is moved to the nearest shore, far away it is refused", () => {
  const near = exposure(-0.004, 0.05, [rings([square])]); // about 440 m south of the lake
  assert.ok(!("error" in near) && /440|44\d m from the water/.test(near.note), JSON.stringify(near));
  assert.match((exposure(-0.1, 0.05, [rings([square])]) as { error: string }).error, /nearest water is \d+ m/);
  assert.match((exposure(0, 0, []) as { error: string }).error, /no water found/);
});

test("shore: way pieces are joined into a ring, and the map's relations and coastlines are read", () => {
  const halves: Ring[] = [square.slice(0, 3), square.slice(2)];
  assert.equal(rings(halves).length, 1);
  const g = (r: Ring) => r.map(([lon, lat]) => ({ lon, lat }));
  const { features, coast } = featuresFrom([{ type: "relation", members: [{ role: "outer", geometry: g(halves[0]!) }, { role: "outer", geometry: g(halves[1]!) }, { role: "inner", geometry: [] }] }, { type: "way", tags: { natural: "coastline" }, geometry: g(square) }]);
  assert.equal(features.length, 2);
  assert.ok(coast);
});

test("spots: the seed list finds a listed launch point and says so; an unlisted one falls back to the map", async () => {
  const lances = nearestSpot(36.0, -5.64, 5000);
  assert.ok(lances && /Tarifa/.test(lances.spot.name));
  assert.equal(nearestSpot(46.5, 8.0, 600), undefined, "nothing in the middle of the Alps");
  const info = await getSpotInfo({ lat: lances!.spot.lat, lon: lances!.spot.lon });
  assert.match(info, /Seed list: .*Tarifa.*Rideable wind \(where it blows FROM\): from [A-Z]+ to [A-Z]+/s);
  assert.match(info, /owner's own notes about this spot win/);
  const offline = await getSpotInfo({ lat: 46.5, lon: 8.0 }, { fetch: async () => new Response("busy", { status: 429 }) });
  assert.match(offline, /^not in the seed list, and no shore data: the map service did not answer/);
});

test("manifest: the weather tools are free reads in the owner's chat and in groups, nowhere else", () => {
  for (const t of ["search_places", "get_forecast", "get_marine_forecast", "get_spot_info", "get_distance"]) {
    assert.equal(access(`mcp__weather__${t}`, "chat"), "free");
    assert.equal(access(`mcp__weather__${t}`, "group"), "free");
    assert.equal(access(`mcp__weather__${t}`, "handler"), undefined);
  }
  assert.ok(ownerSkills(settings.mail).includes("ted-personal-assistant:surf-conditions"));
});
