import type { Triage } from "./triage.ts";

// Pure decision logic for what the heartbeat does with classified mail.
// Kept free of I/O so every safety rule is unit-tested.

// Only these kinds may ever be archived automatically.
const ARCHIVE_KINDS = new Set(["newsletter", "notification", "cold_outreach"]);

export interface Plan {
  archive: number[]; // indices to archive now
  alert: number[]; // needs the owner: tell them
  handle: number[]; // the assistant can deal with it
  keep: number[]; // leave in the inbox, nothing else
  deferred: number[]; // wanted to archive but over the per-tick cap: left in the inbox
}

export function planActions(results: Triage[], opts: { maxArchives: number }): Plan {
  const plan: Plan = { archive: [], alert: [], handle: [], keep: [], deferred: [] };
  results.forEach((t, i) => {
    if (t.label === "act_now") plan.alert.push(i);
    else if (t.label === "handle") plan.handle.push(i);
    else if (t.label === "archive") {
      // Three-way agreement before anything is removed from the inbox: the label says
      // archive, the kind is a noise kind (a mismatch like archive + personal_or_work is
      // doubtful), and no code-side guard (suspicious text) objected.
      if (t.protected || !ARCHIVE_KINDS.has(t.kind)) plan.keep.push(i);
      else if (plan.archive.length >= opts.maxArchives) plan.deferred.push(i);
      else plan.archive.push(i);
    } else plan.keep.push(i);
  });
  return plan;
}

interface AlertItem {
  from: string;
  subject: string;
  reason: string;
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

// One batched, plain-text message per tick. Sender, subject and reason all derive from
// email content, so this is sent as plain text, never parsed as markdown.
export function formatAlert(items: AlertItem[]): string {
  const head = items.length === 1 ? "📥 1 email needs you:" : `📥 ${items.length} emails need you:`;
  const lines = items.slice(0, 8).map((m) => `- ${clip(m.from, 40)}: ${clip(m.subject, 80)}${m.reason ? ` (${clip(m.reason, 90)})` : ""}`);
  if (items.length > 8) lines.push(`- ...and ${items.length - 8} more`);
  return [head, ...lines].join("\n");
}
