import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.ts";
import { oneLine } from "./sanitize.ts";
import type { TenantContext } from "./tenants.ts";

// A friend's mail check keeps its state in her own folder (tenants/<id>/mail/), like everything of hers: what it has seen, when it last ticked, the queue of its
// handler, and a small log of what it decided about each mail. That log holds her mail's senders and subjects, so it is HER file (the admin's audit log gets the
// wordless row only: label, kind and decision). Her chat reads it back as "what the mail check did in the last day" (the brief entry of her mail), as data.

export const mailDir = (ctx: Pick<TenantContext, "dir">): string => join(ctx.dir, "mail");
export const mailFiles = (ctx: Pick<TenantContext, "dir">) => ({ seen: join(mailDir(ctx), "seen.json"), liveness: join(mailDir(ctx), "heartbeat.json"), queue: join(mailDir(ctx), "handle-queue.json"), triage: join(mailDir(ctx), "triage.jsonl") });

const MAX_BYTES = 200_000;
const KEEP_LINES = 300;

// One mail's decision: into her file (words) and, without any word, into the audit log. The tool name differs from the owner's ("heartbeat_triage"), whose rows the
// owner's brief reads: a friend's mail never reaches the owner's digest.
export function recordTriage(ctx: Pick<TenantContext, "dir" | "id">, decision: string, row: Record<string, unknown>, now = new Date()): void {
  const file = mailFiles(ctx).triage;
  mkdirSync(mailDir(ctx), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify({ ts: now.toISOString(), decision, from: row.from, subject: row.subject, label: row.label, kind: row.kind })}\n`, { mode: 0o600 });
  if (statSync(file).size > MAX_BYTES) writeFileSync(file, readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-KEEP_LINES).join("\n") + "\n", { mode: 0o600 });
  audit("tenant_heartbeat_triage", decision, "heartbeat", { tenant: ctx.id, label: row.label, kind: row.kind, protected: row.protected });
}

interface Row {
  ts: string;
  decision: string;
  from?: string;
  subject?: string;
  label?: string;
}

// What the mail check did with the mail that needs her or her assistant in the last day, as plain lines for her chat's prompt (empty: nothing). Newsletters and
// notifications it archived (or would have) are not listed: they are not news to her.
export function mailDigest(ctx: Pick<TenantContext, "dir">, now = new Date(), hours = 24, cap = 12): string {
  const file = mailFiles(ctx).triage;
  if (!existsSync(file)) return "";
  const since = new Date(now.getTime() - hours * 3600_000).toISOString();
  const rows: Row[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const r = JSON.parse(line) as Row;
      if (r.ts > since && r.label && r.label !== "archive") rows.push(r);
    } catch {
      /* a torn line */
    }
  }
  const shown = rows.slice(-cap);
  if (!shown.length) return "";
  const lines = shown.map((r) => `- ${oneLine("digest", r.from ?? "", 40)}: ${oneLine("digest", r.subject ?? "", 90)} [${r.label}${r.decision && r.decision !== "kept" ? `, ${r.decision}` : ""}]`);
  if (rows.length > cap) lines.unshift(`(the latest ${cap} of ${rows.length})`);
  return lines.join("\n");
}
