import { clip } from "../core/sanitize.ts";
import { fence } from "../core/fence.ts";
import { liveConvDb, peekConvDb } from "../core/convdb.ts";
import type { Db } from "../core/db.ts";
import type { ConvId } from "../core/convpaths.ts";

// The looks' memory of the inbox: for each mail a look considered, its LAST decision (archive, keep, task, draft, with the reason). Looks start a fresh session and remember nothing, so code
// hands every run of a conversation that has mail the decisions as a fact block (heartbeat/facts.ts, via inboxBlock): the run lists the inbox with its own mail tool (whatever the provider),
// sees the last decision of each mail it knows, treats a mail that is not in the block as new, starts from the last decision and changes it only when something changed. Code knows no mailbox and
// no provider: an id is a string exactly as the mail tool returned it.
//   * The decisions come from a look's own answer (its "triage" rows, run/rules.ts) and are written when the look has answered (record); only the rows it reports are touched, so an unchanged mail
//     keeps its decision and its age. A mail archived (the archive was allowed) is no longer in the inbox, so its row goes. The table is bounded (the newest MAX_DECISIONS: trimDecisions, also a
//     retention rule) and belongs to ONE conversation: the `mail_decisions` table of its assistant.db.
//   * The code floor's and the judge's verdict on an archive call is kept per mail id while the run goes (judged/verdict), so the decision log can show it next to the look's own reason.

export const MAX_DECISIONS = 2000;
const BLOCK_DAYS = 14; // a decision older than this is not shown (the owner archived the mail by hand long ago)
const BLOCK_MAX = 40;
const MAX_ID_CHARS = 200;

export interface TriageRow {
  id: string; // as the mail tool returned it
  from: string;
  subject: string;
  decision: "archive" | "keep" | "task" | "draft";
  reason: string;
}

/** The retention query that bounds the table: everything but the newest `max` rows goes. Returns how many went (`dryRun`: how many would). */
export function trimDecisions(db: Db, max: number = MAX_DECISIONS, dryRun = false): number {
  const cut = db.get<{ seq: number }>("SELECT seq FROM mail_decisions ORDER BY seq DESC LIMIT 1 OFFSET ?", max)?.seq; // the newest row that is already past the bound
  if (cut === undefined) return 0;
  if (dryRun) return db.num("SELECT COUNT(*) FROM mail_decisions WHERE seq <= ?", cut);
  return db.run("DELETE FROM mail_decisions WHERE seq <= ?", cut).changes;
}

export interface Decision {
  id: string;
  decision: string;
  reason: string;
  sender: string;
  subject: string;
  at: number;
}

const WORD: Record<string, string> = { archive: "archive not done yet", keep: "kept", task: "made a task", draft: "drafted a reply" };

// Pure: "3 h ago", the age of a decision as a fact.
export function ageText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
}

// Pure: the fact block of the decisions (newest first, at most BLOCK_MAX), "" when there are none. A fenced quote: sender and subject are third parties' words.
export function decisionsBlock(rows: readonly Decision[], now: number): string {
  if (!rows.length) return "";
  const lines = rows.slice(0, BLOCK_MAX).map((d) => `${d.id} | ${WORD[d.decision] ?? d.decision} ${ageText(now - d.at)}${d.subject ? `: “${d.subject}”` : ""}${d.sender ? ` from ${d.sender}` : ""}${d.reason ? `, ${d.reason}` : ""}`);
  return `Inbox decisions so far: the last decision of a look for each mail it considered, newest first. A mail you find in the inbox that is not listed here is new. Start from the last decision and change it only when something changed (a reply arrived, a date passed, a task or the calendar now covers it, the owner acted); do not open a mail again just to re-read it.\n${fence("inbox_decisions", lines.join("\n"))}`;
}

/** The decisions a run is told: those of the last BLOCK_DAYS, newest first. Reads only; nothing is made for a conversation without a database. */
export function inboxBlock(conv: ConvId, now: number): string {
  const db = peekConvDb(conv);
  if (!db) return "";
  const rows = db.all<{ id: string; decision: string; reason: string | null; sender: string | null; subject: string | null; at: number }>("SELECT id, decision, reason, sender, subject, at FROM mail_decisions WHERE at >= ? ORDER BY at DESC, seq DESC LIMIT ?", now - BLOCK_DAYS * 86_400_000, BLOCK_MAX);
  return decisionsBlock(rows.map((r) => ({ id: r.id, decision: r.decision, reason: r.reason ?? "", sender: r.sender ?? "", subject: r.subject ?? "", at: r.at })), now);
}

export interface Triage {
  record: (rows: readonly TriageRow[], now: number) => void; // the look answered: its decisions are the new last ones
  judged: (ids: readonly string[], outcome: string, reason?: string) => void; // the code floor / judge said this about an archive of these ids (permissions.ts)
  verdict: (id: string) => { outcome: string; reason?: string } | undefined;
}

const idOf = (raw: string): string => String(raw).trim().slice(0, MAX_ID_CHARS);

export function createTriage(conv: ConvId, max: number = MAX_DECISIONS): Triage {
  const verdicts = new Map<string, { outcome: string; reason?: string }>();
  return {
    record(rows, now) {
      if (!rows.length) return;
      const db = liveConvDb(conv); // (undefined: the database was found damaged meanwhile; nothing is written into the fresh one that replaced it)
      if (!db) return;
      db.tx(() => {
        for (const t of rows) {
          const id = idOf(t.id);
          db.run("DELETE FROM mail_decisions WHERE id = ?", id);
          if (t.decision === "archive" && verdicts.get(id)?.outcome === "allowed") continue; // archived: it left the inbox
          db.run("INSERT INTO mail_decisions (id, decision, reason, sender, subject, at) VALUES (?, ?, ?, ?, ?, ?)", id, t.decision, clip(t.reason, 160), clip(t.from, 60), clip(t.subject, 100), now);
        }
        trimDecisions(db, max);
      });
    },
    judged(ids, outcome, reason) {
      for (const id of ids) verdicts.set(idOf(id), { outcome, ...(reason ? { reason } : {}) });
    },
    verdict: (id) => verdicts.get(idOf(id)),
  };
}
