import { dirname, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { audit } from "../../audit.ts";
import type { Conversation } from "../../conversation/conversationmodel.ts";
import { readJson, writeJson } from "../../state.ts";
import { tenantById, tenantContext } from "../../tenants/tenants.ts";

// "Mail since your last look" is not a time window but a memory of ids: the mail the conversation's heartbeat run has already worked through. The run lists the inbox with
// its own mail tool (whatever the provider: Mailbird, Gmail, a friend's Google) and asks the `seen_mail` tool which of those ids it has not looked at yet. Code knows no
// mailbox and no provider here: an id is a string exactly as the mail tool returned it.
//   * The ids a call returns as new are PENDING: they join the conversation's seen log only when the look ends well (commit). A look that failed or was cut short leaves
//     them unseen, so the mail is worked through by the next look; an offline gap is worked off over successive looks, not lost.
//   * The log is bounded (the last SEEN_MAX ids) and belongs to ONE conversation: the owner's, a friend's in her folder.
//   * The run and the expert it calls share one pending set (they share the run's tool servers).
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

export interface SeenMail {
  // Of these ids, the ones not in the committed log; they become pending. Asking again for a pending id returns it again (the answer does not change within a look).
  unseen: (ids: readonly string[]) => string[];
  commit: () => void; // the look ended well: the pending ids are seen from now on
  discard: () => void; // it did not
  pending: () => number;
}

export function createSeenMail(file: string, max: number = SEEN_MAX): SeenMail {
  const pending = new Set<string>();
  const load = (): string[] => {
    const raw = readJson<Partial<Log>>(file, {}).ids;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  };
  return {
    unseen(ids) {
      const known = new Set(load());
      const out: string[] = [];
      for (const raw of ids.slice(0, MAX_IDS_PER_CALL)) {
        const id = String(raw).trim().slice(0, MAX_ID_CHARS);
        if (id && !known.has(id) && !out.includes(id)) out.push(id);
      }
      for (const id of out) pending.add(id);
      return out;
    },
    commit() {
      if (pending.size === 0) return;
      const kept = load().filter((id) => !pending.has(id));
      writeJson(file, { ids: [...kept, ...pending].slice(-max) } satisfies Log);
      pending.clear();
    },
    discard: () => pending.clear(),
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
        { ids: z.array(z.string().min(1).max(MAX_ID_CHARS)).max(MAX_IDS_PER_CALL).describe("Ids as the mail tool returned them, any provider") },
        async ({ ids }) => {
          const fresh = seen.unseen(ids);
          audit("seen_mail", "checked", "background", { asked: ids.length, unseen: fresh.length });
          return reply(fresh.length ? `Not looked at yet (${fresh.length} of ${ids.length}):\n${fresh.join("\n")}` : `Nothing new: all ${ids.length} were looked at in earlier looks.`);
        },
        { alwaysLoad: true },
      ),
    ],
  });
}
