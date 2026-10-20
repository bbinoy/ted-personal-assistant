import { isTriage, readAudit } from "./audit.ts";
import { OWNER_TRIAGE, readTriage, type TriageEntry } from "./triagelog.ts";

export type { TriageEntry };

// The owner's triage decisions since a time: from her triage file (triagelog.ts), and the rows an older version wrote into the audit log with the sender and the
// subject in them (a friend's rows there never carry any: they are wordless).
export function readTriageSince(sinceIso: string): TriageEntry[] {
  const legacy = readAudit((e) => isTriage(e) && e.ts > sinceIso && typeof e.meta?.from === "string", '"tool":"heartbeat_triage"') as TriageEntry[];
  return [...legacy, ...readTriage(OWNER_TRIAGE, sinceIso)].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// The latest decision about one conversation (`npm run restore <id>`).
export const triageEntryFor = (id: string): TriageEntry | undefined => readTriageSince("1970-01-01T00:00:00.000Z").filter((e) => e.meta.id === id).pop();
