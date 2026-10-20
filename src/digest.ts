import { oneLine } from "./sanitize.ts";
import { isTriage, readAudit, type AuditEntry } from "./audit.ts";

export type TriageEntry = Pick<AuditEntry, "ts" | "decision"> & {
  meta: { id?: string; messageId?: number; from?: string; subject?: string; label?: string; kind?: string; reason?: string };
};

export function readTriageSince(sinceIso: string): TriageEntry[] {
  return readAudit((e) => isTriage(e) && e.ts > sinceIso, '"tool":"heartbeat_triage"') as TriageEntry[];
}

const LIST_CAP = 40;
const clip = (s: string | undefined, n: number) => oneLine("digest", s ?? "", n);

// What the heartbeat did with new mail since the last brief, as plain text for the
// brief prompt. Pure function: easy to test.
export function buildDigest(entries: TriageEntry[], sinceIso: string | undefined): string {
  const head = `HEARTBEAT DIGEST (since ${sinceIso ?? "the beginning"}, ${entries.length} new conversation(s) triaged)`;
  if (entries.length === 0) return `${head}\nNothing new arrived.`;

  const lines = [head];
  const wouldArchive = entries.filter((e) => e.decision === "would-archive");
  if (wouldArchive.length > 0) {
    lines.push(`Archiving is in LOG-ONLY mode (ARCHIVE=log): ${wouldArchive.length} thread(s) were classified archive but are STILL IN THE INBOX. Do not archive them yourself or say they were archived; list them under "Looked archivable" and tell the owner archiving is switched to log-only, with how to turn it on (ARCHIVE=live in .env).`);
  }
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
