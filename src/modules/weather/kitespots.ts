import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS_DIR } from "../../paths.ts";

// A seed list of kite spots (assets/kitespots.json): launch point, the wind directions that are rideable there, water and notes.
// It is only a starting point: the owner's own spot notes win, and a spot that is not in the list falls back to the shore from the map (shore.ts).
export interface KiteSpot {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  region?: string;
  sectors?: [number, number][]; // wind directions (where it blows FROM, degrees) that are rideable, from to; a sector may wrap past north
  water?: string;
  level?: string;
  notes?: string;
}

let spots: KiteSpot[] | undefined;
const all = (): KiteSpot[] => (spots ??= JSON.parse(readFileSync(join(ASSETS_DIR, "kitespots.json"), "utf8")) as KiteSpot[]);

export const distanceM = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
};

// The listed spot nearest to a point, if one is within `maxM` metres.
export function nearestSpot(lat: number, lon: number, maxM = 600, list: readonly KiteSpot[] = all()): { spot: KiteSpot; meters: number } | undefined {
  let best: { spot: KiteSpot; meters: number } | undefined;
  for (const s of list) {
    const m = distanceM(lat, lon, s.lat, s.lon);
    if (m <= maxM && (!best || m < best.meters)) best = { spot: s, meters: m };
  }
  return best;
}
