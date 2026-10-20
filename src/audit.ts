import { renameSync, statSync } from "node:fs";
import { redactSecrets } from "./redact.ts";
import { appendLine, dataPath, readText } from "./state.ts";

// One append-only log for everything the agent does or observes.
//   source: who acted (a chat turn, the daily brief, the mail handler, the heartbeat itself)
//   meta:   small structured details. Agent tool calls log ids only, never content; heartbeat
//           triage entries add sender and subject so the brief and `npm run report` can list them.

// The one list of who can act. policy.ts keys its per-source rights by this type (a missing or extra key fails tsc and test/policy.test.ts).
export const SOURCES = ["chat", "brief", "handler", "heartbeat", "radar", "dream", "group", "background", "browse"] as const;
export type Source = (typeof SOURCES)[number];

export interface AuditEntry {
  ts: string;
  source: Source;
  tool: string;
  decision: string;
  meta?: Record<string, any>;
}

// The audit log is the admin's (logs/, search_logs, npm run report). A tenant's rows in it say what happened and how big, never what she said or
// asked for: these fields hold words (a question, her reply, the arguments of a call, a judge's reason, the host of a page she opened, the name of a control on it, an
// address, an error that quotes a page) and become their length.
const WORDS = ["args", "question", "details", "reply", "feedback", "executed", "reason", "facts", "name", "host", "address", "why", "merchant", "error"];
export function wordless(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return meta;
  return Object.fromEntries(Object.entries(meta).map(([k, v]) => (WORDS.includes(k) && v !== undefined ? [`${k}Chars`, (typeof v === "string" ? v : JSON.stringify(v) ?? "").length] : [k, v])));
}

const FILE = "logs/audit.jsonl";
const MAX_BYTES = 20 * 1024 * 1024;
let appends = 0;

export function audit(tool: string, decision: string, source: Source, meta?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), source, tool, decision, ...(meta ? { meta } : {}) };
  appendLine(FILE, redactSecrets(JSON.stringify(entry))); // an error message or a subject can carry a key; senders and subjects stay readable (phone numbers are not masked here)
  // Keep one previous generation; readers only ever need the recent past.
  if (++appends % 100 === 0 && statSync(dataPath(FILE)).size > MAX_BYTES) {
    renameSync(dataPath(FILE), dataPath(`${FILE}.1`));
  }
}

// Entries matching `keep`, oldest first. A damaged line is skipped, never fatal.
// `contains`: a substring every wanted line has (e.g. '"tool":"heartbeat_triage"'); other lines are skipped without being parsed.
export function readAudit(keep: (e: AuditEntry) => boolean, contains?: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const line of (readText(FILE) ?? "").split("\n")) {
    if (!line || (contains && !line.includes(contains))) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (keep(e)) out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

// What the heartbeat decided about each new email (archived, alerted, kept...).
export const isTriage = (e: AuditEntry) => e.source === "heartbeat" && e.tool === "heartbeat_triage";
