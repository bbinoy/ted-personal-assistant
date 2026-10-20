import { oneLine } from "./sanitize.ts";
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

const LIST_CAP = 40;
const clip = (s: string | undefined, n: number) => oneLine("digest", s ?? "", n);

// What the heartbeat did with new mail since the last brief, as plain text for the
// brief prompt. Pure function: easy to test.
export function buildDigest(entries: TriageEntry[], sinceIso: string | undefined): string {
  const head = `HEARTBEAT DIGEST (since ${sinceIso ?? "the beginning"}, ${entries.length} new conversation(s) triaged)`;
  if (entries.length === 0) return `${head}\nNothing new arrived.`;

  const lines = [head];
  const by = (label: string) => entries.filter((e) => e.meta.label === label);
  const archived = entries.filter((e) => e.decision === "archived");
  const candidates = entries.filter((e) => e.meta.label === "archive" && e.decision !== "archived");
  // withKind adds the kind and the classifier's reason: for archived mail, that is what lets the
  // owner scan the list and spot a mistake.
  const section = (title: string, rows: TriageEntry[], withKind: boolean) => {
    if (rows.length === 0) return;
    lines.push(`\n${title} (${rows.length}):`);
    for (const e of rows.slice(0, LIST_CAP)) {
      const kind = withKind && e.meta.kind ? ` [${clip(e.meta.kind, 40)}]` : ""; // a row without a kind has no brackets
      const id = e.meta.messageId ? ` {msg ${e.meta.messageId}}` : "";
      const why = withKind && e.meta.reason ? ` - why: ${clip(e.meta.reason, 80)}` : "";
      lines.push(`- ${clip(e.meta.from, 40)}: ${clip(e.meta.subject, 90)}${kind}${why}${id}`);
    }
    if (rows.length > LIST_CAP) lines.push(`- ...and ${rows.length - LIST_CAP} more`);
  };
  section("Archived by the heartbeat (include newsletters in the radar)", archived, true);
  section("Looked archivable but were left in the inbox", candidates, true);
  section("Needs the owner (act_now; the heartbeat sends a phone alert only once the day's brief is out, so overnight mail is reported here instead)", by("act_now"), false);
  section("Assistant can handle", by("handle"), false);
  section("Read later (left in inbox)", by("read_later"), false);
  return lines.join("\n");
}
