import type { GoogleSession } from "./googlemcp.ts";
import { settings } from "./settings.ts";

// A friend's mailbox for the heartbeat (heartbeat.ts createMailCheck), through her own Google server (googlemcp.ts). The owner's Gmail relay runs a small model that may
// make exactly the planned calls, because the owner's connector can only be reached through a model run. A friend's server is ours: this class calls it DIRECTLY, with no
// model at all, so a mail check that finds nothing new costs nothing, and only the calls below exist (a search, a read, and the INBOX label off or on). What comes back is
// untrusted mail text and is cleaned by the heartbeat like any other (oneLine, mailBody).
//
// UNVERIFIED LIVE: the shapes parsed here are those of workspace-mcp 2.1.0's plain-text results, read from its code (search_gmail_messages with include_headers, and
// get_gmail_message_content). The first live run is the check; a shape that does not parse gives an empty list or an empty body, never an invented mail.

export interface SearchRow {
  conversationId: string; // the message id: each inbox message is its own conversation here (an archive is that message's INBOX label)
  subject: string;
  lastSender: string;
  receivedAtUtc: string;
  lastMessageId: string;
}

const SELF_NAME = "me";

// "Name <a@b.c>", "a@b.c" or "\"Name\" <a@b.c>".
export function senderOf(v: string): { name: string; email: string } {
  const s = v.trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(s);
  if (m) return { name: m[1]!.replace(/^"|"$/g, "").trim(), email: m[2]!.trim().toLowerCase() };
  return { name: "", email: s.includes("@") ? s.toLowerCase() : "" };
}

const toIso = (v: string): string => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : v;
};

// search_gmail_messages (include_headers) -> one row per message:
//   "  1. Message ID: 18f...\n     Subject: ...\n     From: Name <a@b.c>\n     Date: ...\n     Web Link: ...\n     Thread ID: ..."
export function parseSearch(text: string, self: string | undefined): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const block of text.split(/^\s*\d+\.\s+(?=Message ID:)/m).slice(1)) {
    const field = (name: string) => new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
    const id = field("Message ID");
    if (!id || id === "unknown") continue;
    const from = senderOf(field("From"));
    rows.push({
      conversationId: id,
      subject: field("Subject"),
      lastSender: self && from.email === self.toLowerCase() ? SELF_NAME : from.name || from.email || field("From"),
      receivedAtUtc: toIso(field("Date")),
      lastMessageId: id,
    });
  }
  return rows;
}

export interface Message {
  body: string;
  from: { displayName: string; email: string };
}

// get_gmail_message_content -> the headers, a blank line, "--- BODY ---", the body (and, after it, a list of attachments by name, which is left out).
export function parseMessage(text: string): Message {
  const [head = "", rest = ""] = text.split(/\n--- BODY ---\n/);
  const body = rest.split(/\n--- ATTACHMENTS ---/)[0] ?? "";
  const from = senderOf(/^From:[ \t]*(.*)$/m.exec(head)?.[1] ?? "");
  return { body, from: { displayName: from.name, email: from.email } };
}

// The only label change this class makes: INBOX off a message (archive) or back on (restore).
const INBOX = ["INBOX"];

export class GoogleMail {
  private readonly session: Pick<GoogleSession, "call" | "account">;
  private readonly query: () => string;
  private readonly archiveLive: () => boolean;
  constructor(session: Pick<GoogleSession, "call" | "account">, o: { query?: () => string; archiveLive?: () => boolean } = {}) {
    this.session = session;
    this.query = o.query ?? (() => settings.google.mailQuery);
    this.archiveLive = o.archiveLive ?? (() => settings.google.archiveLive);
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.session.call(name, args);
    if (r.isError) throw new Error(`google ${name} failed`); // (the server's own words may quote mail: not repeated)
    return r.text;
  }

  async inboxes() {
    return [{ accountId: 0, email: await this.session.account(), senderName: SELF_NAME, folderId: 0 }];
  }

  // The heartbeat's mailbox calls, over her server's tools.
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    switch (name) {
      case "list_conversations":
        return parseSearch(await this.tool("search_gmail_messages", { query: this.query(), page_size: 50, include_headers: true }), await this.session.account()) as T;
      case "get_message":
        return parseMessage(await this.tool("get_gmail_message_content", { message_id: String(args.messageId), body_format: "text" })) as T;
      case "archive_conversation":
        if (!this.archiveLive()) return "log-only (GOOGLE_ARCHIVE_LIVE=false): not archived" as T;
        return (await this.tool("modify_gmail_message_labels", { message_id: String(args.conversationId), remove_label_ids: INBOX })) as T;
      case "move_conversation_to_inbox":
        return (await this.tool("modify_gmail_message_labels", { message_id: String(args.conversationId), add_label_ids: INBOX })) as T;
      default:
        throw new Error(`google mail: ${name} is not supported`);
    }
  }

  async close(): Promise<void> {} // her server is shared with her chat and closed when idle (googlemcp.ts)
}
