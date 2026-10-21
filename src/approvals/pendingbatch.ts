import { createHash } from "node:crypto";
import { clip } from "../core/sanitize.ts";
import type { Dropped, Pending } from "./pending.ts";
import { questionFooter } from "./questionfooter.ts";

// The texts of the approval inbox, all written by CODE around the model's one-line question: the batch message, the /approvals list, the result lines and the expiry line. Pure.

export const ANSWER_HINT = "Reply e.g. '1,3 yes', 'all yes', '2 no', or reply to this message.";

// The footer of questionfooter.ts on one line ("To: ... · Text: “...”"), or "" when the details carry none.
export function compactFooter(details: string): string {
  const f = questionFooter(details);
  return f ? f.replace(/^\s*— exactly what will go —\s*/, "").split("\n").filter(Boolean).join(" · ") : "";
}

export const labelOf = (details: string): string => clip(details.split("\n")[0] ?? "", 90);

const one = (s: string, max: number): string => clip(s, max);

// "5 min", "3 h", "2 d".
export function ageText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

// A fingerprint of the code-rendered details, without the lines that legitimately change between asking and running (the "declined N minutes ago" line, a looked-up name).
export const detailsHash = (details: string): string =>
  createHash("sha256").update(details.split("\n").filter((l) => !/^(Named:|The owner declined this action)/.test(l)).join("\n")).digest("hex").slice(0, 24);

function itemLines(p: Pending, age?: string): string[] {
  const tag = p.executing ? " — running now" : p.interrupted ? " — may not have run, reply to try again" : "";
  const head = `${p.n}. ${p.label}${age ? ` (${age})` : ""}${tag} ${one(p.question, 300)}`;
  return p.footer ? [head, `   ↳ ${p.footer}`] : [head];
}

// The batch an unattended run's parked calls are asked in: a header, one numbered entry per item (code label, the model's question, code footer), the hint.
export function renderBatch(items: readonly Pending[]): string {
  const head = items.length === 1 ? "📬 1 thing is waiting for your approval:" : `📬 ${items.length} things are waiting for your approval:`;
  return [head, ...items.flatMap((p) => itemLines(p)), "", ANSWER_HINT].join("\n");
}

// "/approvals": every open item with its number and age, the same hint.
export function renderList(items: readonly Pending[], now: number): string {
  if (items.length === 0) return "Nothing is waiting for your approval.";
  return [`Waiting for your approval (${items.length}):`, ...items.flatMap((p) => itemLines(p, ageText(now - p.createdAt))), "", `${ANSWER_HINT} '/approvals clear' drops them all.`].join("\n");
}

// One short line for what expired: code labels only, never model text.
export function expiryLine(dropped: readonly Dropped[], days: number): string {
  const shown = dropped.slice(0, 4).map((d) => `#${d.n} ${d.label}`).join("; ");
  const more = dropped.length > 4 ? ` (+${dropped.length - 4} more)` : "";
  return `⏳ Dropped, not answered in ${days} day${days === 1 ? "" : "s"}: ${shown}${more}.`;
}

export const queuedResult = (n: number, owner: string): string => `Queued for ${owner}'s approval as #${n}; carry on with the rest; do not retry it. Nothing was done yet.`;

export const doneLine = (n: number, line: string): string => `✅ #${n} done: ${one(line, 200)}`;
export const failedLine = (n: number, line: string): string => `⚠️ #${n} failed: ${one(line, 200)}`;
