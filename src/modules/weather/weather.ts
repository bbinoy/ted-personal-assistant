import { distanceM, nearestSpot } from "./kitespots.ts";
import { shoreExposure } from "./shore.ts";

// The weather tools' bodies: data in, compact text out (weathertools.ts registers them). Units, local time, daylight and compass names are code;
// whether a day is good is the model's judgment (the surf-conditions skill), so there are no verdicts and no scores here.
// Open-Meteo is free for non-commercial use without a key; a hosted or multi-tenant deployment needs its own agreement.
export interface WeatherIo { fetch: typeof fetch; now: () => Date; sleep?: (ms: number) => Promise<void> }
const real: WeatherIo = { fetch: (...a) => fetch(...a), now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const RETRY_AFTER_MAX_MS = 10_000; // a service asking for a longer pause than this gets "busy, try again in a minute" instead of a stalled tool call
// Pure: how long to wait before the next try after a 429 or a 5xx: the service's Retry-After (seconds, or an HTTP date) when it sends one, else a growing pause; never more than the bound.
export function retryDelayMs(retryAfter: string | null | undefined, attempt: number, now = Date.now()): number {
  const backoff = 1500 * (attempt + 1);
  if (!retryAfter) return backoff;
  const secs = Number(retryAfter);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS) : backoff;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number | null | undefined): string => (deg == null ? "-" : `${COMPASS[Math.round(deg / 22.5) % 16]} ${Math.round(deg)}`);
const point = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
const num = (v: number | null | undefined, digits = 0): string => (v == null ? "-" : v.toFixed(digits));
const pad = (s: string, n: number) => s.padEnd(n);
const dayName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function getJson(url: string, io: WeatherIo): Promise<{ ok: true; data: Json } | { ok: false; error: string }> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await io.fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "ted-personal-assistant" } });
      const text = await res.text();
      if (res.status >= 500 || res.status === 429 || !text) {
        const wait = retryDelayMs(res.headers.get("retry-after"), i, io.now().getTime());
        if (res.status === 429 && wait >= RETRY_AFTER_MAX_MS) return { ok: false, error: "weather service busy (rate limited), try again in a minute" };
        await (io.sleep ?? real.sleep!)(wait);
        continue;
      }
      const data = JSON.parse(text) as Json;
      if (data.error) return { ok: false, error: `weather service: ${String(data.reason ?? "error")}` };
      return { ok: true, data };
    } catch (e) {
      if (i === 2) return { ok: false, error: `weather service not reachable: ${(e as Error).message}` };
    }
  }
  return { ok: false, error: "weather service busy, try again in a minute" };
}

export async function searchPlaces(name: string, io: WeatherIo = real): Promise<string> {
  const r = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5`, io);
  if (!r.ok) return r.error;
  const hits = (r.data.results ?? []) as Json[];
  if (!hits.length) return `no place found for "${name}": try a nearby town, a village on the shore, or a different spelling. A small spot may have to be given as coordinates.`;
  return hits.map((h) => `${h.name}, ${[h.admin1, h.country].filter(Boolean).join(", ")}: lat ${Number(h.latitude).toFixed(3)} lon ${Number(h.longitude).toFixed(3)} elev ${Math.round(h.elevation ?? 0)} m, tz ${h.timezone}`).join("\n");
}

export interface ForecastArgs { lat: number; lon: number; days?: number; models?: string[] }
export async function getForecast({ lat, lon, days = 3, models }: ForecastArgs, io: WeatherIo = real): Promise<string> {
  const vars = "wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,precipitation,temperature_2m,pressure_msl";
  const list = models?.length ? models : [""];
  const r = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&wind_speed_unit=kn&forecast_days=${days}&hourly=${vars}&daily=sunrise,sunset${models?.length ? `&models=${models.join(",")}` : ""}`, io);
  if (!r.ok) return r.error;
  const d = r.data, h = d.hourly as Record<string, (number | string | null)[]>;
  const col = (v: string, m: string): (number | null)[] => (h[m ? `${v}_${m}` : v] ?? h[v] ?? []) as (number | null)[];
  const m0 = list[0]!;
  const daily = d.daily as Record<string, string[]>;
  const sunrise = daily[m0 ? `sunrise_${m0}` : "sunrise"] ?? daily.sunrise ?? [];
  const sunset = daily[m0 ? `sunset_${m0}` : "sunset"] ?? daily.sunset ?? [];
  const nowLocal = new Date(io.now().getTime() + Number(d.utc_offset_seconds) * 1000).toISOString().slice(0, 13);
  const out = [`${lat.toFixed(2)}N ${lon.toFixed(2)}E (grid ${Number(d.latitude).toFixed(2)}, ${Number(d.longitude).toFixed(2)}) elev ${Math.round(Number(d.elevation))} m, ${String(d.timezone)}, ${m0 ? list.join("+") : "best_match"}${list.length > 1 ? " (gust and everything after wind are from the first model)" : ""}. wind/gust kn, dir = where it blows FROM, rain mm/h, temp C, pressure hPa (msl)`];
  const dayKeys = sunrise.map((s) => s.slice(0, 10));
  let lastDay = "";
  for (let i = 0; i < (h.time as string[]).length; i++) {
    const t = (h.time as string[])[i]!;
    const day = t.slice(0, 10), hour = Number(t.slice(11, 13));
    const di = dayKeys.indexOf(day);
    if (t.slice(0, 13) < nowLocal || di < 0 || t < sunrise[di]!.slice(0, 13) || t > sunset[di]!) continue; // daylight only
    if (di >= 2 && hour % 3 !== 0) continue; // hourly for two days, then every three hours
    if (day !== lastDay) {
      lastDay = day;
      out.push(`${dayName(day)}  sunrise ${sunrise[di]!.slice(11)}  sunset ${sunset[di]!.slice(11)}`);
      out.push(`hr ${list.length > 1 ? list.map((m) => pad(`wind:${m.replace(/_seamless|_ifs025/, "")}`, 14)).join("") : "wind "}gust dir     cloud rain temp pres`);
    }
    const w = list.length > 1 ? list.map((m) => pad(num(col("wind_speed_10m", m)[i]), 14)).join("") : pad(num(col("wind_speed_10m", m0)[i]), 5);
    out.push(`${pad(String(hour).padStart(2, "0"), 3)}${w}${pad(num(col("wind_gusts_10m", m0)[i]), 5)}${pad(compass(col("wind_direction_10m", m0)[i]), 8)}${pad(num(col("cloud_cover", m0)[i]), 6)}${pad(num(col("precipitation", m0)[i], 1), 5)}${pad(num(col("temperature_2m", m0)[i]), 5)}${num(col("pressure_msl", m0)[i])}`);
  }
  return out.join("\n");
}

export async function getMarineForecast({ lat, lon, days = 3 }: { lat: number; lon: number; days?: number }, io: WeatherIo = real): Promise<string> {
  const r = await getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=${days}&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction,wind_wave_height,sea_surface_temperature,sea_level_height_msl`, io);
  if (!r.ok) return r.error;
  const d = r.data, h = d.hourly as Record<string, (number | string | null)[]>;
  const v = (k: string, i: number) => h[k]![i] as number | null;
  if (!(h.wave_height ?? []).some((x) => x != null)) return "no marine data for this point: inland or a lake? (for a lake only air and wind data exist)";
  const times = h.time as string[];
  const nowLocal = new Date(io.now().getTime() + Number(d.utc_offset_seconds) * 1000).toISOString().slice(0, 13);
  const out = [`${lat.toFixed(2)}N ${lon.toFixed(2)}E (grid ${Number(d.latitude).toFixed(2)}, ${Number(d.longitude).toFixed(2)}), ${String(d.timezone)}. wave/swell m, period s, dir = where waves come FROM, sea temp C, sea level m vs mean (tide + surge)`];
  let lastDay = "";
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    if (t.slice(0, 13) < nowLocal) continue;
    const day = t.slice(0, 10), hour = Number(t.slice(11, 13));
    const dayNo = Math.floor((Date.parse(`${day}T00:00Z`) - Date.parse(`${times[0]!.slice(0, 10)}T00:00Z`)) / 864e5);
    if (hour < 6 || hour > 20 || (dayNo >= 2 && hour % 3 !== 0)) continue;
    if (day !== lastDay) {
      lastDay = day;
      out.push(dayName(day));
      out.push("hr wave  per  dir     swell sper sdir    windwave sea  level");
    }
    out.push(`${pad(String(hour).padStart(2, "0"), 3)}${pad(num(v("wave_height", i), 1), 6)}${pad(num(v("wave_period", i)), 5)}${pad(compass(v("wave_direction", i)), 8)}${pad(num(v("swell_wave_height", i), 1), 6)}${pad(num(v("swell_wave_period", i)), 5)}${pad(compass(v("swell_wave_direction", i)), 8)}${pad(num(v("wind_wave_height", i), 1), 9)}${pad(num(v("sea_surface_temperature", i)), 5)}${num(v("sea_level_height_msl", i), 2)}`);
  }
  return out.join("\n");
}

// "from SSW to WSW (200-260 deg)" for each sector of a listed spot.
const sectorText = (s: [number, number]) => `from ${point(s[0])} to ${point(s[1])} (${s[0]} to ${s[1]} deg)`;

// What is known about a launch point: a spot from the seed list if one is within 600 m, else the shore from the map. Static: the model saves the answer in the spot's note.
export async function getSpotInfo({ lat, lon }: { lat: number; lon: number }, io: { fetch: typeof fetch } = { fetch }): Promise<string> {
  const known = nearestSpot(lat, lon);
  if (known) {
    const s = known.spot;
    return [
      `Seed list: ${s.name} (${s.country}${s.region ? `, ${s.region}` : ""}), ${Math.round(known.meters)} m from these coordinates.`,
      s.sectors?.length ? `Rideable wind (where it blows FROM): ${s.sectors.map(sectorText).join("; ")}. Everything else is offshore or too cross-shore.` : "No rideable sectors listed.",
      [s.water && `water: ${s.water}`, s.level && `level: ${s.level}`].filter(Boolean).join(", "),
      s.notes ? `Notes: ${s.notes}` : "",
      "A starting point from a shared list, not a guarantee: the owner's own notes about this spot win.",
    ].filter(Boolean).join("\n");
  }
  const r = await shoreExposure(lat, lon, io);
  if ("error" in r) return `not in the seed list, and no shore data: ${r.error}`;
  const km = (m: number) => (m / 1000).toFixed(1);
  const names = (xs: typeof r.table, withKm: boolean) => xs.map((x) => `${point(x.from)}${withKm ? ` ${km(x.fetchM)}` : ""}`).join(", ") || "none";
  const on = r.table.filter((x) => x.fetchM >= 1500), off = r.table.filter((x) => x.fetchM <= 350), side = r.table.filter((x) => x.fetchM > 350 && x.fetchM < 1500);
  return [
    `${lat.toFixed(4)}N ${lon.toFixed(4)}E, from map data (not in the seed list). Wind direction = where it blows FROM; the number is km of open water it crosses before the spot.`,
    r.note,
    `onshore (1.5 km of water or more): ${names(on, true)}`,
    `side-on (0.35 to 1.5 km of water, i.e. along the shore): ${names(side, true)}`,
    `offshore (under 0.35 km of water, the wind comes from land): ${names(off, false)}`,
    "Shapes only: the map does not show rocks, shipping, shallows, dams or rivers, and not local effects like thermals. Hazards are the owner's to tell.",
  ].filter(Boolean).join("\n");
}

export const distanceKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): string => `${Math.round(distanceM(a.lat, a.lon, b.lat, b.lon) / 1000)} km in a straight line`;
