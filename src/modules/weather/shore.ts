import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settings } from "../../core/settings.ts";

// Which wind directions are onshore, side-on or offshore at a launch point, from OpenStreetMap water outlines: for each of 16 directions, how many
// metres of open water the wind has crossed before it reaches the spot. Pure geometry; the model compares it with the forecast direction.
// The outline of a lake or coast does not change, so a spot is fetched once and kept in state/shore/ (the public map server is for light use).
// It knows shapes only: rocks, shipping, shallows and local effects are not in the data.
const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
export type Pt = [number, number]; // lon, lat
export type Ring = Pt[];

function destination(lat: number, lon: number, bearingDeg: number, meters: number): Pt {
  const b = rad(bearingDeg), d = meters / R, la = rad(lat), lo = rad(lon);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
}

const key = (p: Pt) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

// Join way pieces into closed rings by matching end points.
export function rings(ways: Ring[]): Ring[] {
  const done: Ring[] = [], open = ways.filter((w) => w.length > 1).map((w) => w.slice());
  while (open.length) {
    let cur = open.pop()!;
    for (let guard = 0; guard < 5000 && key(cur[0]!) !== key(cur[cur.length - 1]!); guard++) {
      const end = key(cur[cur.length - 1]!);
      const i = open.findIndex((w) => key(w[0]!) === end || key(w[w.length - 1]!) === end);
      if (i < 0) break;
      const w = open.splice(i, 1)[0]!;
      cur = cur.concat(key(w[0]!) === end ? w.slice(1) : w.slice(0, -1).reverse());
    }
    if (cur.length > 3 && key(cur[0]!) === key(cur[cur.length - 1]!)) done.push(cur);
  }
  return done;
}

// Even-odd inside one water feature (its outer rings and its islands).
export function inRings(p: Pt, rs: Ring[]): boolean {
  let inside = false;
  for (const r of rs) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Exposure {
  table: { from: number; fetchM: number }[]; // wind from this bearing: metres of water crossed
  note: string; // set when the point had to be moved to the nearest shore
}

// `features`: each water body is a list of rings (a lake with its islands). A point is water if it is inside any body.
export function exposure(lat: number, lon: number, features: readonly Ring[][]): Exposure | { error: string } {
  const fs = features.filter((f) => f.length);
  if (!fs.length) return { error: "no water found within 12 km of this point in the map data" };
  const water = (p: Pt) => fs.some((f) => inRings(p, f));
  let note = "";
  if (!water([lon, lat])) {
    // the nearest point on any shore segment (local flat approximation, fine at this distance)
    let best: { d: number; p: Pt } | undefined;
    const kx = 111320 * Math.cos(rad(lat)), ky = 111320;
    for (const f of fs) for (const r of f) for (let i = 1; i < r.length; i++) {
      const [x1, y1] = r[i - 1]!, [x2, y2] = r[i]!;
      const dx = (x2 - x1) * kx, dy = (y2 - y1) * ky, len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (((lon - x1) * kx) * dx + ((lat - y1) * ky) * dy) / len2));
      const p: Pt = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
      const d = Math.hypot((p[0] - lon) * kx, (p[1] - lat) * ky);
      if (!best || d < best.d) best = { d, p };
    }
    if (best!.d > 3000) return { error: `the nearest water is ${Math.round(best!.d)} m from these coordinates: use the launch point at the shore` };
    if (best!.d > 300) {
      note = `the coordinates are ${Math.round(best!.d)} m from the water; measured from the nearest shore point ${best!.p[1].toFixed(4)}N ${best!.p[0].toFixed(4)}E`;
      lat = best!.p[1];
      lon = best!.p[0];
    }
  }
  // Walk upwind; the water run that starts within 300 m is the fetch. Land gaps under 200 m (jetties, piers, small islands) do not end it.
  const run = (from: number): number => {
    let first = -1, last = -1, gap = 0;
    for (let m = 0; m <= 15000; m += 50) {
      const w = water(destination(lat, lon, from, m));
      if (first < 0) { if (m <= 300 && w) first = m; continue; }
      if (w) { last = m; gap = 0; } else if ((gap += 50) >= 200) break;
    }
    return first < 0 ? 0 : last + 50;
  };
  // Each direction is the median of three rays 10 degrees apart, so one jetty or headland does not decide it.
  const table: Exposure["table"] = [];
  for (let from = 0; from < 360; from += 22.5) table.push({ from, fetchM: [run(from - 10), run(from), run(from + 10)].sort((a, b) => a - b)[1]! });
  return { table, note };
}

interface OsmElement { type: string; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[]; members?: { role: string; geometry?: { lat: number; lon: number }[] }[] }
const line = (g: { lat: number; lon: number }[]): Ring => g.map((x) => [x.lon, x.lat]);

export function featuresFrom(elements: readonly OsmElement[]): { features: Ring[][]; coast: boolean } {
  const features: Ring[][] = [];
  let coast = false;
  for (const e of elements) {
    if (e.type === "way" && e.geometry) {
      features.push(rings([line(e.geometry)]));
      if (e.tags?.natural === "coastline") coast = true;
    }
    if (e.type === "relation") features.push(rings((e.members ?? []).filter((m) => m.geometry && (m.role === "outer" || m.role === "inner")).map((m) => line(m.geometry!))));
  }
  return { features, coast };
}

const cacheFile = (lat: number, lon: number) => join(settings.stateDir, "shore", `${lat.toFixed(4)}_${lon.toFixed(4)}.json`);

// The public servers are shared and often at capacity: two of them, one try each, and the answer is kept for good.
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
async function fetchElements(lat: number, lon: number, io: { fetch: typeof fetch }): Promise<OsmElement[] | undefined> {
  const q = `[out:json][timeout:100];(way(around:12000,${lat},${lon})[natural=water];way(around:12000,${lat},${lon})[natural=coastline];relation(around:12000,${lat},${lon})[natural=water];);out geom;`;
  for (const host of OVERPASS) try {
    const res = await io.fetch(host, { method: "POST", body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(45_000), headers: { "User-Agent": "ted-personal-assistant (github.com/bbinoy/ted-personal-assistant)" } });
    if (res.ok) return ((await res.json()) as { elements: OsmElement[] }).elements;
  } catch { /* busy or slow: the next server */ }
  return undefined;
}

export async function shoreExposure(lat: number, lon: number, io: { fetch: typeof fetch } = { fetch }): Promise<Exposure | { error: string }> {
  const file = cacheFile(lat, lon);
  let elements: OsmElement[] | undefined;
  try {
    if (existsSync(file)) elements = JSON.parse(readFileSync(file, "utf8")) as OsmElement[];
  } catch { /* unreadable: fetch again */ }
  if (!elements) {
    elements = await fetchElements(lat, lon, io);
    if (!elements) return { error: "the map service did not answer (it limits requests); try again in a few minutes" };
    try {
      mkdirSync(join(settings.stateDir, "shore"), { recursive: true });
      writeFileSync(file, JSON.stringify(elements));
    } catch { /* the cache is a convenience */ }
  }
  const { features, coast } = featuresFrom(elements);
  if (coast) return { error: "this is on a sea coast, where the land and sea outline is not built from the map yet" };
  return exposure(lat, lon, features);
}
