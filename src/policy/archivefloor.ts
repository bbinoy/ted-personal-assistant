import { isGmailTool, isInboxArchive } from "../gmailrules.ts";
import { entryFor } from "./toolmanifest.ts";

// The code floor under an unattended run's archiving (the heartbeat run and its experts; the mail handler). An archive is reversible (`npm run restore`), so the judge may
// wave it through, but two limits are code and the judge never sees a call that breaks one: the owner is asked instead.
//   * at most MAX_ARCHIVES_PER_RUN archives in one run (one look), so a wrong idea cannot sweep an inbox;
//   * only mail the run has read: a mail whose content never came into this run is not archived on a guess. (A mail that is still unread in the OWNER's client is the
//     same case: the run opened it, or it did not.)
// The owner's chat and a group are not under it: they archive what the person said to archive.

export const MAX_ARCHIVES_PER_RUN = 5;

export type ArchiveAsk = "cap" | "unread";

// The mail an archive call archives: Mailbird's archive_conversation (a conversation id), Gmail's unlabel_thread removing INBOX (a thread id). Undefined for any other call.
export function archivedId(tool: string, input: Record<string, unknown>): string | undefined {
  if (entryFor(tool)?.action !== "archive") return undefined;
  if (isGmailTool(tool) && !isInboxArchive(tool, input)) return undefined; // another label change is its own question (gmailrules.ts)
  const id = input.conversationId ?? input.threadId ?? input.messageId;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

const MAIL_READ = /(^|__)get_(message|conversation|thread)$/;
const isMailRead = (tool: string): boolean => entryFor(tool)?.action === "read" && MAIL_READ.test(tool);
const CONVERSATION = /^(conversation|thread)_?id$/i;
const MESSAGE = /^(id|message_?id|last_?message_?id)$/i;

// Pure: the (conversation id, message id) pairs in a tool result, wherever an object names both. A result is MCP content (text parts holding JSON) or a plain value.
export function mailLinks(response: unknown): { conversation: string; message: string }[] {
  const out: { conversation: string; message: string }[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === "string") {
      const t = v.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          visit(JSON.parse(t), depth + 1);
        } catch {
          /* not JSON */
        }
      }
      return;
    }
    if (Array.isArray(v)) return void v.forEach((x) => visit(x, depth + 1));
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const entries = Object.entries(o);
    const conv = entries.find(([k, x]) => CONVERSATION.test(k) && (typeof x === "string" || typeof x === "number"))?.[1];
    if (conv !== undefined) for (const [k, x] of entries) if (MESSAGE.test(k) && (typeof x === "string" || typeof x === "number")) out.push({ conversation: String(conv), message: String(x) });
    for (const [, x] of entries) visit(x, depth + 1);
  };
  visit(response, 0);
  return out;
}

export interface ArchiveWatch {
  // After every successful tool call of the run (PostToolUse): learn which message belongs to which conversation, and note the mails the run has read.
  seen: (tool: string, input: Record<string, unknown>, response: unknown) => void;
  // For a call: why the owner must be asked instead of the judge, or undefined (not an archive, or within the limits).
  ask: (tool: string, input: Record<string, unknown>) => ArchiveAsk | undefined;
  // An archive went ahead (the judge or the owner said yes): it counts.
  done: (tool: string, input: Record<string, unknown>) => void;
}

export function createArchiveWatch(max: number = MAX_ARCHIVES_PER_RUN): ArchiveWatch {
  const conversationOf = new Map<string, string>(); // message id -> conversation id
  const read = new Set<string>(); // conversation ids whose content this run has read
  let archived = 0;
  return {
    seen(tool, input, response) {
      for (const l of mailLinks(response)) conversationOf.set(l.message, l.conversation);
      if (!isMailRead(tool)) return;
      for (const key of ["conversationId", "threadId"]) if (input[key] !== undefined) read.add(String(input[key]));
      if (input.messageId !== undefined) {
        const m = String(input.messageId);
        const c = conversationOf.get(m);
        if (c) read.add(c);
        for (const l of mailLinks(response)) if (l.message === m) read.add(l.conversation);
      }
    },
    ask(tool, input) {
      const id = archivedId(tool, input);
      if (id === undefined) return undefined;
      if (archived >= max) return "cap";
      return id !== "" && read.has(id) ? undefined : "unread";
    },
    done(tool, input) {
      if (archivedId(tool, input) !== undefined) archived++;
    },
  };
}

// What the owner is told on the phone next to the archive question.
export const archiveAskNote = (why: ArchiveAsk): string =>
  why === "cap" ? `\n(The assistant has already archived ${MAX_ARCHIVES_PER_RUN} mails in this run, the most it does without asking.)` : "\n(The assistant did not open this mail in this run, so it does not archive it on its own.)";
