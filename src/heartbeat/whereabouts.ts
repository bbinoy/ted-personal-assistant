import { kvGet, kvSet } from "../core/instancedb.ts";
import { macZone } from "../core/timezone.ts";
import { showInstant } from "../tasks/when.ts";

// Where the owner probably is: the Mac's time zone follows its location (macOS "set time zone automatically"), and the Mac is usually with the owner. Code keeps the zone's history in
// instance kv (updated by the heartbeat tick, so a change is noticed at most one period late) and hands it to the runs of a conversation with the `profile` capability as a fact
// (facts.ts); the run decides what it means.

export const ZONE_KEY = "mac_zone";

export interface ZoneRecord {
  zone: string;
  since?: number; // ms; absent for the first record ever (the zone was already that when we first looked)
  previous?: { zone: string; since?: number };
}

// One look at the Mac's zone: the first record has no `since`; a new zone moves the old one down to `previous` and starts at `now`; the same zone changes nothing.
export function noteMacZone(now: number = Date.now(), zone: string = macZone()): ZoneRecord {
  const rec = kvGet<ZoneRecord | undefined>(ZONE_KEY, undefined);
  if (rec?.zone === zone) return rec;
  const next: ZoneRecord = rec ? { zone, since: now, previous: { zone: rec.zone, ...(rec.since !== undefined && { since: rec.since }) } } : { zone };
  kvSet(ZONE_KEY, next);
  return next;
}

// The fact line, in the conversation's zone; "" while nothing is recorded.
export function whereaboutsFact(now: Date, zone: string, who: string): string {
  const rec = kvGet<ZoneRecord | undefined>(ZONE_KEY, undefined);
  if (!rec) return "";
  const since = rec.since === undefined ? "for as long as it has been watched (how long is not known)" : `since ${showInstant(rec.since, zone, now.getTime())}`;
  const before = rec.previous ? ` (before that ${rec.previous.zone})` : "";
  return `Where ${who} probably is: this computer's clock follows its location; it is in ${rec.zone} ${since}${before}. ${who} usually has it with them; the calendar or the chat may say otherwise.`;
}
