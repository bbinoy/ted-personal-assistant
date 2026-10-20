import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { audit } from "./audit.ts";
import { redactSecrets } from "./redact.ts";
import { dataPath } from "./state.ts";

// The TRIAGE RECORD, one for every conversation that has a mail check: what it decided about each mail, with the sender and subject, in a file of that conversation
// (the owner's state/triage.jsonl, a friend's tenants/<id>/mail/triage.jsonl), and in the audit log a row that says only that something was decided (label, kind,
// decision, ids; never a sender, a subject or a reason). The digest of the daily brief, `npm run report`, `npm run restore` and a friend's "what the mail check did"
// all read the file.

export const OWNER_TRIAGE = "state/triage.jsonl";

export interface TriageEntry {
  ts: string;
  decision: string;
  meta: { id?: string; messageId?: number | string; from?: string; subject?: string; label?: string; kind?: string; reason?: string; protected?: boolean; result?: unknown; [k: string]: unknown };
}

const WORDS = ["from", "subject", "reason", "account"];

export function recordTriage(file: string, decision: string, row: Record<string, unknown>, o: { tag?: Record<string, unknown>; maxBytes?: number; keep?: number; now?: Date } = {}): void {
  const path = dataPath(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${redactSecrets(JSON.stringify({ ts: (o.now ?? new Date()).toISOString(), decision, ...row }))}\n`, { mode: 0o600 });
  if (statSync(path).size > (o.maxBytes ?? 1_000_000)) writeFileSync(path, readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-(o.keep ?? 3000)).join("\n") + "\n", { mode: 0o600 });
  audit("heartbeat_triage", decision, "heartbeat", { ...o.tag, ...Object.fromEntries(Object.entries(row).filter(([k]) => !WORDS.includes(k))) });
}

// Entries since `sinceIso`, oldest first. A torn line is skipped.
export function readTriage(file: string, sinceIso?: string): TriageEntry[] {
  const path = dataPath(file);
  if (!existsSync(path)) return [];
  const out: TriageEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const { ts, decision, ...meta } = JSON.parse(line) as { ts: string; decision: string } & TriageEntry["meta"];
      if (ts && decision && (!sinceIso || ts > sinceIso)) out.push({ ts, decision, meta });
    } catch {
      /* a torn line */
    }
  }
  return out;
}
