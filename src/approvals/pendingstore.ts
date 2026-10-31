import { createHash } from "node:crypto";
import { convDb, peekConvDb } from "../core/convdb.ts";
import type { Db } from "../core/db.ts";
import { convIdOfKey } from "../core/convpaths.ts";
import { callKey } from "../core/callkey.ts";

// The durable side of the approval hand-off (docs/SAFETY.md). A question that needs a person's yes does not hold its turn: the question is sent, this row is written, the turn ends. A yes turns
// the row into a single-use GRANT for exactly this call; the continuation turn calls the tool again and permissions.ts consumes the grant (takeGrant) if the call, the conversation and the
// code-rendered description are still what was asked. Only code writes these rows, from an answer given in the conversation the question was asked in (approvals.ts): never a model, a mail or a
// relayed text. A payment is never stored (handoff.ts). Rows live in the conversation's own database (core/convdb.ts pending_actions), so they survive a restart; pruned after 7 days (heartbeat/convretention.ts).

type PendingStatus = "pending" | "granted" | "declined" | "expired" | "superseded" | "used";
export interface Pending {
  id: string;
  conv: string; // Conversation.key
  tool: string;
  input: Record<string, unknown>;
  callKey: string;
  renderHash: string;
  label: string;
  question: string;
  qTs: number;
  provenance?: unknown;
  untrusted: boolean;
  askedBy: string;
  askedAt: number;
  expiresAt: number;
  status: PendingStatus;
}
interface Row {
  id: string; conv: string; tool: string; input: string; call_key: string; render_hash: string; label: string; question: string; q_ts: number;
  provenance: string | null; untrusted: number; asked_by: string; asked_at: number; expires_at: number; status: PendingStatus;
}
const db = (scope: string) => convDb(convIdOfKey(scope));
const fromRow = (r: Row): Pending => ({ id: r.id, conv: r.conv, tool: r.tool, input: JSON.parse(r.input), callKey: r.call_key, renderHash: r.render_hash, label: r.label, question: r.question, qTs: r.q_ts, provenance: r.provenance ? JSON.parse(r.provenance) : undefined, untrusted: !!r.untrusted, askedBy: r.asked_by, askedAt: r.asked_at, expiresAt: r.expires_at, status: r.status });

/** The fingerprint of what the person was shown, as code rendered it (a mail send includes the draft as the mail client holds it): a grant holds only while it is unchanged. */
export const renderHash = (description: string): string => createHash("sha256").update(description).digest("hex");

export function savePending(p: Omit<Pending, "status">): void {
  db(p.conv).run(
    "INSERT OR IGNORE INTO pending_actions (id, conv, tool, input, call_key, render_hash, label, question, q_ts, provenance, untrusted, asked_by, asked_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
    p.id, p.conv, p.tool, JSON.stringify(p.input), p.callKey, p.renderHash, p.label, p.question, p.qTs, p.provenance === undefined ? null : JSON.stringify(p.provenance), p.untrusted ? 1 : 0, p.askedBy, p.askedAt, p.expiresAt,
  );
}

/** pending -> `status` (declined, expired, superseded), with what the person said. False if the row was not pending any more. */
export function closePending(scope: string, id: string, status: "declined" | "expired" | "superseded", answer?: unknown): boolean {
  return db(scope).run("UPDATE pending_actions SET status = ?, answer = ? WHERE id = ? AND status = 'pending'", status, answer === undefined ? null : JSON.stringify(answer), id).changes === 1;
}

/** pending -> granted: the grant is for `input` (the person's edit, when they approved one) and lasts until `expiresAt`. */
export function grantPending(scope: string, id: string, input: Record<string, unknown>, tool: string, hash: string, expiresAt: number, answer?: unknown): boolean {
  return db(scope).run("UPDATE pending_actions SET status = 'granted', input = ?, call_key = ?, render_hash = ?, expires_at = ?, answer = ? WHERE id = ? AND tool = ? AND status = 'pending'", JSON.stringify(input), callKey(tool, input), hash, expiresAt, answer === undefined ? null : JSON.stringify(answer), id, tool).changes === 1;
}

/** The single-use grant for exactly this call in this conversation, if one is live and the description still hashes as asked. Consumed atomically: two callers cannot both get it. */
export function takeGrant(scope: string, tool: string, input: Record<string, unknown>, hash: string, now: number): Pending | undefined {
  const d = peekConvDb(convIdOfKey(scope));
  if (!d) return undefined;
  const r = d.get<Row>("SELECT * FROM pending_actions WHERE conv = ? AND call_key = ? AND render_hash = ? AND status = 'granted' AND expires_at > ? ORDER BY asked_at DESC LIMIT 1", scope, callKey(tool, input), hash, now);
  return r && d.run("UPDATE pending_actions SET status = 'used' WHERE id = ? AND status = 'granted'", r.id).changes === 1 ? fromRow(r) : undefined;
}

/** Is exactly this call (same description) already asked and waiting? Then the model repeating it asks nothing new. */
export function isAsked(scope: string, tool: string, input: Record<string, unknown>, hash: string, now: number): boolean {
  const d = peekConvDb(convIdOfKey(scope));
  return !!d && d.num("SELECT COUNT(*) FROM pending_actions WHERE conv = ? AND call_key = ? AND render_hash = ? AND status = 'pending' AND expires_at > ?", scope, callKey(tool, input), hash, now) > 0;
}

/** A question waits for its yes, or a yes has not been used yet: a look does not start meanwhile (queue.ts busy). */
export function inFlight(scope: string, now: number): boolean {
  const d = peekConvDb(convIdOfKey(scope));
  return !!d && d.num("SELECT COUNT(*) FROM pending_actions WHERE conv = ? AND status IN ('pending', 'granted') AND expires_at > ?", scope, now) > 0;
}

/** The rows to bring back after a restart in one conversation's database: every question still waiting, and every yes not yet used. */
export const livePending = (d: Db): Pending[] => d.all<Row>("SELECT * FROM pending_actions WHERE status IN ('pending', 'granted')").map(fromRow);
