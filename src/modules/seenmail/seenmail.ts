import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emitRecord } from "../../core/events.ts";
import { settings } from "../../core/settings.ts";
import { liveConvDb, peekConvDb } from "../../core/convdb.ts";
import type { Db } from "../../core/db.ts";
import type { ConvId } from "../../core/convpaths.ts";

// "Mail since your last look" is not a time window but a memory of ids: the mail the conversation's heartbeat run has already worked through. The run lists the inbox with
// its own mail tool (whatever the provider: Mailbird, Gmail, a friend's Google) and asks the `seen_mail` tool which of those ids it has not looked at yet. Code knows no
// mailbox and no provider here: an id is a string exactly as the mail tool returned it.
//   * The ids a call returns as new are PENDING: they join the conversation's seen log only when the look ends well (commit). A look that failed or was cut short leaves
//     them unseen, so the mail is worked through by the next look; an offline gap is worked off over successive looks, not lost.
//   * The log is bounded (the last SEEN_MAX ids: trimSeenMail, also a retention rule) and belongs to ONE conversation: it is the `seen_mail` table of that conversation's assistant.db.
//   * The run and the expert it calls share one pending set (they share the run's tool servers).
//   * The FIRST look (no log yet) does not triage the whole backlog: mail the run says arrived more than MAIL_BACKLOG_DAYS (7) ago (`received`, as the mail tool gave it) is marked seen
//     without being returned, and the tool says so once, so the owner hears of it in the first message (isBacklog).
// The tool touches only this log: nothing to judge, nothing to ask.

export const SEEN_MAX = 2000;
const MAX_IDS_PER_CALL = 500;
const MAX_ID_CHARS = 200;

/** The retention query that bounds the log: everything but the newest `max` ids goes. Returns how many went (`dryRun`: how many would). */
export function trimSeenMail(db: Db, max: number = SEEN_MAX, dryRun = false): number {
  const cut = db.get<{ seq: number }>("SELECT seq FROM seen_mail ORDER BY seq DESC LIMIT 1 OFFSET ?", max)?.seq; // the newest id that is already past the bound
  if (cut === undefined) return 0;
  if (dryRun) return db.num("SELECT COUNT(*) FROM seen_mail WHERE seq <= ?", cut);
  return db.run("DELETE FROM seen_mail WHERE seq <= ?", cut).changes;
}

// Pure: is this mail old enough to count as backlog on a first run? `received` is whatever date text the mail tool gave; one that cannot be read is not backlog (it is triaged).
export function isBacklog(received: string | undefined, now: number, days: number): boolean {
  if (!received || days <= 0) return false;
  const at = Date.parse(received);
  return Number.isFinite(at) && now - at > days * 86_400_000;
}

export interface SeenMail {
  // Of these ids, the ones not in the committed log; they become pending. Asking again for a pending id returns it again (the answer does not change within a look).
  // `received`: id -> the mail's date as the tool gave it; on the very first look the old ones are marked seen instead of returned (counted in `aged`).
  unseen: (ids: readonly string[], received?: Readonly<Record<string, string>>) => string[];
  aged: () => number; // how many mails this look marked seen as backlog
  reset: () => boolean; // this look follows a RESET: the database that held the log was damaged and replaced, so every mail in the inbox is marked seen (never triaged again)
  commit: () => void; // the look ended well: the pending ids are seen from now on
  discard: () => void; // it did not
  forget: (ids: readonly string[]) => void; // these pending ids were NOT worked through (the archive cap refused them): they come back at the next look
  pending: () => number;
}

// First run only: inbox mail older than this is marked seen without triage.
const MAIL_BACKLOG_DAYS = 7;
export function createSeenMail(conv: ConvId, max: number = SEEN_MAX, backlogDays: number = MAIL_BACKLOG_DAYS, now: () => number = Date.now): SeenMail {
  const pending = new Set<string>();
  const backlog = new Set<string>();
  const firstRun = (peekConvDb(conv)?.num("SELECT COUNT(*) FROM seen_mail") ?? 0) === 0; // no log yet: nothing was ever worked through
  const reset = peekConvDb(conv)?.get("SELECT 1 FROM reset WHERE id = 1") !== undefined; // the log was lost to a damaged database: "no log" does not mean "never looked"
  let consulted = false;
  const known = (id: string): boolean => peekConvDb(conv)?.get("SELECT 1 FROM seen_mail WHERE id = ?", id) !== undefined;
  return {
    unseen(ids, received) {
      const out: string[] = [];
      consulted = true;
      for (const raw of ids.slice(0, MAX_IDS_PER_CALL)) {
        const id = String(raw).trim().slice(0, MAX_ID_CHARS);
        if (!id || known(id) || out.includes(id)) continue;
        if (reset || (firstRun && (backlog.has(id) || isBacklog(received?.[raw] ?? received?.[id], now(), backlogDays)))) backlog.add(id); // after a reset EVERY listed id, dates given or not
        else out.push(id);
      }
      for (const id of out) pending.add(id);
      return out;
    },
    aged: () => backlog.size,
    reset: () => reset,
    commit() {
      if (pending.size === 0 && backlog.size === 0 && !(reset && consulted)) return;
      const db = liveConvDb(conv);
      if (!db) return void (pending.clear(), backlog.clear()); // the database was found damaged meanwhile (an idle connection was closed during a long look): nothing is written into the fresh one that replaced it
      db.tx(() => {
        if (reset && consulted) db.run("DELETE FROM reset WHERE id = 1"); // the look that skipped the inbox ended well: the flag is spent
        // an id already in the log moves; the backlog goes to the OLD end (it is the oldest, so it is the first to age out of the bounded log), the pending ones to the newest
        for (const id of [...backlog].reverse()) {
          db.run("DELETE FROM seen_mail WHERE id = ?", id);
          db.run("INSERT INTO seen_mail (seq, id) VALUES ((SELECT COALESCE(MIN(seq), 1) - 1 FROM seen_mail), ?)", id);
        }
        for (const id of pending) {
          db.run("DELETE FROM seen_mail WHERE id = ?", id);
          db.run("INSERT INTO seen_mail (id) VALUES (?)", id);
        }
        trimSeenMail(db, max);
      });
      pending.clear();
      backlog.clear();
    },
    discard: () => (pending.clear(), backlog.clear()),
    forget(ids) {
      for (const id of ids) pending.delete(String(id).trim().slice(0, MAX_ID_CHARS));
    },
    pending: () => pending.size,
  };
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

// The in-process server of a heartbeat run whose conversation has mail (modules/seenmail.ts says who has it).
export function createSeenMailServer(seen: SeenMail) {
  return createSdkMcpServer({
    name: "seenmail",
    version: "1.0.0",
    tools: [
      tool(
        "seen_mail",
        "Which of these inbox mails have you NOT looked at yet? Pass the conversation or message ids exactly as your mail tool returned them (list the inbox first, unread first, with a limit high enough for the whole inbox); you get back only the ids you have not worked through in an earlier look. They count as looked at once this look ends well, so work through every id you get back and do not ask twice.",
        {
          ids: z.array(z.string().min(1).max(MAX_ID_CHARS)).max(MAX_IDS_PER_CALL).describe("Ids as the mail tool returned them, any provider"),
          received: z.record(z.string().max(MAX_ID_CHARS), z.string().max(60)).optional().describe("Optional: each id's date as the mail tool gave it (any readable date text). On your very first look, mail older than the backlog window is marked looked-at without being returned."),
        },
        async ({ ids, received }) => {
          const fresh = seen.unseen(ids, received);
          const aged = seen.aged();
          const lost = seen.reset();
          emitRecord("seen_mail", "checked", "background", { asked: ids.length, unseen: fresh.length, aged });
          const note = lost && aged > 0 ? `\n\nYou lost track of which mail was already handled (the notebook it was kept in was damaged), so the ${aged} mail(s) in the inbox now were marked as looked at without sorting through them. Tell ${settings.owner} so in your message, once, in one short sentence: "I lost track of which mail I'd already handled, so I skipped what's in your inbox now; new mail from here on is handled as usual."` : aged > 0 ? `\n\nThis is your first look: ${aged} mail(s) older than ${MAIL_BACKLOG_DAYS} days were marked as looked at without sorting through them. Tell ${settings.owner} so in your message, once, in one short sentence.` : "";
          return reply((fresh.length ? `Not looked at yet (${fresh.length} of ${ids.length}):\n${fresh.join("\n")}` : `Nothing new: all ${ids.length} were looked at in earlier looks.`) + note);
        },
      ),
    ],
  });
}
