import { dirname, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { audit } from "../../core/audit.ts";
import type { Conversation } from "../../conversation/conversationmodel.ts";
import { settings } from "../../core/settings.ts";
import { readJson, readText, writeJson } from "../../core/state.ts";
import { tenantById, tenantContext } from "../../tenants/tenants.ts";

// "Mail since your last look" is not a time window but a memory of ids: the mail the conversation's heartbeat run has already worked through. The run lists the inbox with
// its own mail tool (whatever the provider: Mailbird, Gmail, a friend's Google) and asks the `seen_mail` tool which of those ids it has not looked at yet. Code knows no
// mailbox and no provider here: an id is a string exactly as the mail tool returned it.
//   * The ids a call returns as new are PENDING: they join the conversation's seen log only when the look ends well (commit). A look that failed or was cut short leaves
//     them unseen, so the mail is worked through by the next look; an offline gap is worked off over successive looks, not lost.
//   * The log is bounded (the last SEEN_MAX ids) and belongs to ONE conversation: the owner's, a friend's in her folder.
//   * The run and the expert it calls share one pending set (they share the run's tool servers).
//   * The FIRST look (no log yet) does not triage the whole backlog: mail the run says arrived more than MAIL_BACKLOG_DAYS ago (`received`, as the mail tool gave it) is marked seen
//     without being returned, and the tool says so once, so the owner hears of it in the first message (isBacklog).
// The tool touches only this log: nothing to judge, nothing to ask.

export const SEEN_MAX = 2000;
export const MAX_IDS_PER_CALL = 500;
const MAX_ID_CHARS = 200;

export const seenFileOf = (conv: Pick<Conversation, "tenantId" | "kind" | "sessionFile">): string => {
  if (conv.kind === "owner") return "state/seen-mail.json";
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  return join(rec ? tenantContext(rec).dir : dirname(conv.sessionFile), "seen-mail.json");
};

interface Log {
  ids: string[]; // oldest first
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
  commit: () => void; // the look ended well: the pending ids are seen from now on
  discard: () => void; // it did not
  forget: (ids: readonly string[]) => void; // these pending ids were NOT worked through (the archive cap refused them): they come back at the next look
  pending: () => number;
}

export function createSeenMail(file: string, max: number = SEEN_MAX, backlogDays: number = settings.mailBacklogDays, now: () => number = Date.now): SeenMail {
  const pending = new Set<string>();
  const backlog = new Set<string>();
  const firstRun = readText(file) === undefined; // no log yet: nothing was ever worked through
  const load = (): string[] => {
    const raw = readJson<Partial<Log>>(file, {}).ids;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  };
  return {
    unseen(ids, received) {
      const known = new Set(load());
      const out: string[] = [];
      for (const raw of ids.slice(0, MAX_IDS_PER_CALL)) {
        const id = String(raw).trim().slice(0, MAX_ID_CHARS);
        if (!id || known.has(id) || out.includes(id)) continue;
        if (firstRun && (backlog.has(id) || isBacklog(received?.[raw] ?? received?.[id], now(), backlogDays))) backlog.add(id);
        else out.push(id);
      }
      for (const id of out) pending.add(id);
      return out;
    },
    aged: () => backlog.size,
    commit() {
      if (pending.size === 0 && backlog.size === 0) return;
      const mine = new Set([...pending, ...backlog]);
      const kept = load().filter((id) => !mine.has(id));
      writeJson(file, { ids: [...backlog, ...kept, ...pending].slice(-max) } satisfies Log); // (the backlog first: it is the oldest, so it is the first to age out of the bounded log)
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
    alwaysLoad: true,
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
          audit("seen_mail", "checked", "background", { asked: ids.length, unseen: fresh.length, aged });
          const note = aged > 0 ? `\n\nThis is your first look: ${aged} mail(s) older than ${settings.mailBacklogDays} days were marked as looked at without sorting through them. Tell ${settings.owner} so in your message, once, in one short sentence.` : "";
          return reply((fresh.length ? `Not looked at yet (${fresh.length} of ${ids.length}):\n${fresh.join("\n")}` : `Nothing new: all ${ids.length} were looked at in earlier looks.`) + note);
        },
        { alwaysLoad: true },
      ),
    ],
  });
}
