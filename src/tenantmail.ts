import { join } from "node:path";
import { oneLine } from "./sanitize.ts";
import type { TenantContext } from "./tenants/tenants.ts";
import { readTriage, recordTriage as recordTriageRow } from "./triagelog.ts";

// A friend's mail check keeps its state in her own folder (tenants/<id>/mail/), like everything of hers: what it has seen, when it last ticked, the queue of its
// handler, and a small log of what it decided about each mail. That log holds her mail's senders and subjects, so it is HER file (the admin's audit log gets the
// wordless row only: label, kind and decision). Her chat reads it back as "what the mail check did in the last day" (the brief entry of her mail), as data.

export const mailDir = (ctx: Pick<TenantContext, "dir">): string => join(ctx.dir, "mail");
export const mailFiles = (ctx: Pick<TenantContext, "dir">) => ({ seen: join(mailDir(ctx), "seen.json"), liveness: join(mailDir(ctx), "heartbeat.json"), queue: join(mailDir(ctx), "handle-queue.json"), triage: join(mailDir(ctx), "triage.jsonl") });

// One mail's decision: the shared triage record (triagelog.ts) in her folder, and the wordless audit row with her id.
export const recordTriage = (ctx: Pick<TenantContext, "dir" | "id">, decision: string, row: Record<string, unknown>, now = new Date()): void =>
  recordTriageRow(mailFiles(ctx).triage, decision, row, { tag: { tenant: ctx.id }, maxBytes: 200_000, keep: 300, now });

// What the mail check did with the mail that needs her or her assistant in the last day, as plain lines for her chat's prompt (empty: nothing). Newsletters and
// notifications it archived (or would have) are not listed: they are not news to her.
export function mailDigest(ctx: Pick<TenantContext, "dir">, now = new Date(), hours = 24, cap = 12): string {
  const since = new Date(now.getTime() - hours * 3600_000).toISOString();
  const rows = readTriage(mailFiles(ctx).triage, since).filter((r) => r.meta.label && r.meta.label !== "archive");
  const shown = rows.slice(-cap);
  if (!shown.length) return "";
  const lines = shown.map((r) => `- ${oneLine("digest", r.meta.from ?? "", 40)}: ${oneLine("digest", r.meta.subject ?? "", 90)} [${r.meta.label}${r.decision && r.decision !== "kept" ? `, ${r.decision}` : ""}]`);
  if (rows.length > cap) lines.unshift(`(the latest ${cap} of ${rows.length})`);
  return lines.join("\n");
}
