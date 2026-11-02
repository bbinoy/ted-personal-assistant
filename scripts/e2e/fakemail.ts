// The fake Mailbird of the end-to-end eval: the `mailbird` server with the tool names, arguments and result shapes of the real one (copied from tool results, never content). It keeps conversations, drafts and
// what was sent; the draft reader the approval of a send uses (setDraftReader) is answered from it too, so no real Mailbird client is needed.
import { z } from "zod";
import { fakeService, type FakeService, type Recorder, type ToolDef } from "./fakeserver.ts";

export const MAILBIRD_SERVER = "mailbird";

export type Folder = "inbox" | "sent" | "drafts" | "archive" | "trash";
const FOLDER_BASE: Record<Folder, number> = { inbox: 10, sent: 11, drafts: 12, archive: 13, trash: 14 };
const folderId = (account: number, f: Folder): number => FOLDER_BASE[f] + (account - 1) * 10; // folder ids are per account
const FOLDER_NAME: Record<Folder, string> = { inbox: "Inbox", sent: "Sent", drafts: "Drafts", archive: "Archive", trash: "Trash" };

export interface Person {
  email: string;
  displayName?: string;
}
// A mail of the world a case starts from.
export interface SeedMail {
  from: Person | string;
  to?: (Person | string)[];
  subject: string;
  body: string;
  receivedAt: string; // ISO
  folder?: Folder; // default inbox
  read?: boolean; // default false in the inbox
  account?: number; // 1 = the owner's own mailbox (default), 2 = the second account (FakeMail `extra`)
  attachments?: { name: string; text: string }[]; // text files on the mail; open_file reads them (play.ts)
}

export interface Message {
  id: number;
  from: Person;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  body: string;
  receivedAtUtc: string;
  attachments: { id: number; fileName: string; mimeType: string; size: number; isInline: boolean; text: string }[];
}
export interface Conversation {
  conversationId: string;
  folder: Folder;
  account: number;
  subject: string;
  read: boolean;
  messages: Message[];
}
export interface SentMail {
  messageId: number;
  turn: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  conversationId?: string;
}

const person = (p: Person | string): Person => (typeof p === "string" ? { email: p.toLowerCase() } : { ...p, email: p.email.toLowerCase() });
const recipient = z.union([z.string(), z.object({ email: z.string(), name: z.string().optional(), displayName: z.string().optional() }).passthrough()]);
const personOf = (r: z.infer<typeof recipient>): Person => (typeof r === "string" ? { email: r.toLowerCase() } : { email: r.email.toLowerCase(), displayName: r.name ?? r.displayName });

export class FakeMail {
  conversations: Conversation[] = [];
  sent: SentMail[] = [];
  briefs: { subject?: string; body: string }[] = [];
  readonly service: FakeService;
  private nextMessage = 5000;
  private nextConv = 1;

  readonly owner: Person;

  readonly accounts: Person[]; // account n is accounts[n - 1]

  constructor(rec: Recorder, owner: Person, seed: SeedMail[] = [], down = false, extra: Person[] = []) {
    this.owner = owner;
    this.accounts = [owner, ...extra];
    for (const s of seed) {
      const account = s.account ?? 1;
      const m = this.message(person(s.from), (s.to ?? [this.accounts[account - 1]!]).map(person), s.subject, s.body, s.receivedAt);
      m.attachments = (s.attachments ?? []).map((a, i) => ({ id: m.id * 10 + i, fileName: a.name, mimeType: "text/plain", size: a.text.length, isInline: false, text: a.text }));
      this.conversations.push({ conversationId: this.newConv(), folder: s.folder ?? "inbox", account, subject: s.subject, read: s.read ?? (s.folder ?? "inbox") !== "inbox", messages: [m] });
    }
    const row = (c: Conversation) => {
      const last = c.messages[c.messages.length - 1]!;
      return { conversationId: c.conversationId, folderId: folderId(c.account, c.folder), subject: c.subject, lastSender: last.from.email, receivedAtUtc: last.receivedAtUtc, isRead: c.read, messageCount: c.messages.length, isStarred: false, isImportant: false, lastMessageId: last.id, messages: [] };
    };
    const inFolder = (id: number) => this.conversations.filter((c) => folderId(c.account, c.folder) === id).sort((a, b) => b.messages.at(-1)!.receivedAtUtc.localeCompare(a.messages.at(-1)!.receivedAtUtc));
    const conv = (id: string) => this.conversations.find((c) => c.conversationId === id) ?? (() => { throw new Error(`Conversation not found: ${id}`); })();
    const msg = (id: number) => {
      for (const c of this.conversations) for (const m of c.messages) if (m.id === id) return { c, m };
      throw new Error(`Message not found: ${id}`);
    };
    const shownAtt = (m: Message) => m.attachments.map(({ text: _t, ...a }) => a);
    const mine = (p: Person) => this.accounts.some((a) => a.email === p.email);
    const shownMessage = (m: Message) => ({ body: m.body, attachments: shownAtt(m), id: m.id, from: m.from, subject: m.subject, receivedAtUtc: m.receivedAtUtc, bodyPreview: null, to: m.to, cc: m.cc, bcc: m.bcc, attachmentCount: m.attachments.length });
    const matches = (c: Conversation, query: string) => {
      const hay = c.messages.map((m) => `${m.subject} ${m.body} ${m.from.email} ${m.from.displayName ?? ""} ${m.to.map((t) => `${t.email} ${t.displayName ?? ""}`).join(" ")}`).join(" ").toLowerCase();
      return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => (w.startsWith("from:") ? c.messages.some((m) => `${m.from.email} ${m.from.displayName ?? ""}`.toLowerCase().includes(w.slice(5))) : hay.includes(w)));
    };
    const draft = (inConv: Conversation | undefined, to: Person[], subject: string, body: string, cc: Person[] = [], account = 1) => {
      const m = this.message(this.accounts[account - 1] ?? owner, to, subject, body, new Date().toISOString());
      m.cc = cc;
      if (inConv) inConv.messages.push(m);
      else this.conversations.push({ conversationId: this.newConv(), folder: "drafts", account, subject, read: true, messages: [m] });
      return m;
    };
    const replyDraft = (a: Record<string, any>, all: boolean) => {
      const c = conv(a.conversationId);
      const last = [...c.messages].reverse().find((m) => !mine(m.from)) ?? c.messages.at(-1)!;
      const to = [last.from, ...(all ? [...last.to, ...last.cc].filter((p) => !mine(p)) : [])];
      const m = draft(undefined, to, c.subject.startsWith("Re:") ? c.subject : `Re: ${c.subject}`, a.body ?? "", all ? last.cc.filter((p) => !mine(p)) : [], c.account);
      return { messageId: m.id, conversationId: c.conversationId, mode: all ? "reply_all" : "reply", status: "draft_created", note: "Draft saved. Review it, then send it with send_message_now (confirm: true)." };
    };
    const draftOf = (id: number) => {
      const { c, m } = msg(id);
      if (c.folder !== "drafts") throw new Error(`Message ${id} is not a draft`);
      return { c, m };
    };

    const defs: Record<string, ToolDef> = {
      list_accounts: { description: "List the mail accounts.", shape: {}, run: () => this.accounts.map((p, i) => ({ id: i + 1, senderName: p.displayName ?? "Owner", email: p.email, unreadConversations: inFolder(folderId(i + 1, "inbox")).filter((c) => !c.read).length })) },
      list_folders: { description: "List an account's folders.", shape: { accountId: z.number() }, run: (a) => (Object.keys(FOLDER_BASE) as Folder[]).map((f) => ({ id: folderId(a.accountId, f), name: FOLDER_NAME[f], identity: f, parentId: null, unreadConversations: f === "inbox" ? inFolder(folderId(a.accountId, f)).filter((c) => !c.read).length : 0 })) },
      list_conversations: { description: "List the conversations of a folder, newest first.", shape: { folderId: z.number(), limit: z.number().optional() }, run: (a) => inFolder(a.folderId).slice(0, a.limit ?? 50).map(row) },
      search_conversations: {
        description: "Search conversations in every folder (words in the subject, body, sender; from:name).",
        shape: { query: z.string(), limit: z.number().optional(), accountId: z.number().optional() },
        run: (a) => this.conversations.filter((c) => matches(c, a.query)).slice(0, a.limit ?? 20).map((c) => ({ ...row(c), actualFolders: [FOLDER_NAME[c.folder]] })),
      },
      get_message: { description: "Read one message (or draft) by its id.", shape: { messageId: z.number() }, run: (a) => shownMessage(msg(a.messageId).m) },
      get_conversation: { description: "A conversation's messages (without bodies).", shape: { conversationId: z.string() }, run: (a) => ({ ...row(conv(a.conversationId)), messages: conv(a.conversationId).messages.map(({ body: _b, ...m }) => ({ ...m, attachmentCount: m.attachments.length })) }) },
      list_attachments: { description: "List a message's attachments.", shape: { messageId: z.number() }, run: (a) => shownAtt(msg(a.messageId).m) },
      archive_conversation: {
        description: "Move a conversation to the Archive. Its id changes.",
        shape: { conversationId: z.string() },
        run: (a) => {
          const c = conv(a.conversationId);
          const was = c.conversationId;
          c.folder = "archive";
          c.conversationId = this.newConv();
          return `ok: archive_conversation succeeded for '${was}'. The conversation id is now '${c.conversationId}'.`;
        },
      },
      move_conversation_to_inbox: {
        description: "Move a conversation back to the Inbox. Its id changes.",
        shape: { conversationId: z.string() },
        run: (a) => {
          const c = conv(a.conversationId);
          c.folder = "inbox";
          c.conversationId = this.newConv();
          return `ok: move_conversation_to_inbox succeeded. The conversation id is now '${c.conversationId}'.`;
        },
      },
      select_conversation: { description: "Show a conversation in the Mailbird window.", shape: { conversationId: z.string() }, run: (a) => `ok: selected '${conv(a.conversationId).conversationId}'` },
      reply_to_conversation: { description: "Save a reply draft in the thread. The body is HTML.", shape: { conversationId: z.string(), body: z.string(), showInUi: z.boolean().optional(), forceNewWindow: z.boolean().optional() }, run: (a) => replyDraft(a, false) },
      reply_all_to_conversation: { description: "Save a reply-all draft in the thread. The body is HTML.", shape: { conversationId: z.string(), body: z.string(), showInUi: z.boolean().optional(), forceNewWindow: z.boolean().optional() }, run: (a) => replyDraft(a, true) },
      create_draft: {
        description: "Start a new mail (no thread) as a draft. The body is HTML.",
        shape: { accountId: z.number().optional(), to: z.array(recipient).optional(), cc: z.array(recipient).optional(), bcc: z.array(recipient).optional(), subject: z.string().optional(), body: z.string().optional(), attachments: z.array(z.string()).optional(), showInUi: z.boolean().optional() },
        run: (a) => {
          const m = draft(undefined, (a.to ?? []).map(personOf), a.subject ?? "", a.body ?? "", (a.cc ?? []).map(personOf), a.accountId ?? 1);
          m.bcc = (a.bcc ?? []).map(personOf);
          return { messageId: m.id, status: "draft_created", note: "Draft saved." };
        },
      },
      update_draft: {
        description: "Change a draft: any of to, cc, bcc, subject, body.",
        shape: { messageId: z.number(), to: z.array(recipient).optional(), cc: z.array(recipient).optional(), bcc: z.array(recipient).optional(), subject: z.string().optional(), body: z.string().optional() },
        run: (a) => {
          const { c, m } = draftOf(a.messageId);
          if (a.to) m.to = a.to.map(personOf);
          if (a.cc) m.cc = a.cc.map(personOf);
          if (a.bcc) m.bcc = a.bcc.map(personOf);
          if (a.subject !== undefined) c.subject = m.subject = a.subject;
          if (a.body !== undefined) m.body = a.body;
          return { messageId: m.id, status: "draft_updated", note: "Draft saved." };
        },
      },
      discard_draft: {
        description: "Throw a draft away.",
        shape: { messageId: z.number() },
        run: (a) => {
          const { c } = draftOf(a.messageId);
          this.conversations = this.conversations.filter((x) => x !== c);
          return { messageId: a.messageId, status: "discarded" };
        },
      },
      forward_conversation: {
        description: "Save a forward draft with no recipients; set them with update_draft.",
        shape: { conversationId: z.string(), body: z.string().optional() },
        run: (a) => {
          const c = conv(a.conversationId);
          const m = draft(undefined, [], `Fwd: ${c.subject}`, `${a.body ?? ""}<hr>${c.messages.at(-1)!.body}`, [], c.account);
          return { messageId: m.id, conversationId: c.conversationId, mode: "forward", status: "draft_created", note: "Draft saved with no recipients." };
        },
      },
      send_message_now: {
        description: "Send a saved draft now. Needs confirm: true (Mailbird's own check, not the owner's approval).",
        shape: { messageId: z.number(), confirm: z.boolean().optional() },
        run: (a) => {
          if (a.confirm !== true) throw new Error("send_message_now needs confirm: true");
          const { c, m } = draftOf(a.messageId);
          if (!m.to.length) throw new Error("The draft has no recipients");
          c.folder = "sent";
          this.sent.push({ messageId: m.id, turn: rec.turn, to: m.to.map((p) => p.email), cc: m.cc.map((p) => p.email), bcc: m.bcc.map((p) => p.email), subject: m.subject, body: m.body, conversationId: c.conversationId });
          return { messageId: m.id, status: "sent", deliveryState: "queued", warning: null, note: "Accepted for delivery; it reaches Sent in a few seconds." };
        },
      },
      get_send_status: {
        description: "Whether a sent message has gone.",
        shape: { messageId: z.number() },
        run: (a) => {
          const { c, m } = msg(a.messageId);
          return { messageId: m.id, state: c.folder === "sent" ? "sent" : "draft", isDraft: c.folder === "drafts", isTrashed: false, scheduledForUtc: null, hasDraftChecksum: false, receivedAtUtc: m.receivedAtUtc };
        },
      },
      send_self_briefing: {
        description: "Email a Markdown briefing to the owner's own inbox.",
        shape: { markdownBody: z.string(), subject: z.string().optional() },
        run: (a) => {
          this.briefs.push({ subject: a.subject, body: a.markdownBody });
          return { status: "sent", note: "Delivered to your own inbox." };
        },
      },
    };
    if (down) for (const d of Object.values(defs)) d.run = () => { throw new Error("MCP server mailbird is not connected"); }; // (the connector is down: every call errors)
    this.service = fakeService(MAILBIRD_SERVER, rec, defs);
  }

  private message(from: Person, to: Person[], subject: string, body: string, at: string): Message {
    return { id: this.nextMessage++, from, to, cc: [], bcc: [], subject, body, receivedAtUtc: at, attachments: [] };
  }
  private newConv = (): string => `00000000-0000-4000-8000-${String(this.nextConv++).padStart(12, "0")}`;

  // What the approval of a send reads back (runtime.ts MAIL.mailbird.start sets this over a real Mailbird connection): the draft as get_message gives it. Not recorded as a call of the run.
  readDraft = (id: number): unknown => {
    for (const c of this.conversations) for (const m of c.messages) if (m.id === id) return { body: m.body, attachments: m.attachments.map(({ text: _t, ...a }) => a), id: m.id, from: m.from, subject: m.subject, to: m.to, cc: m.cc, bcc: m.bcc };
    return undefined;
  };

  // get_attachment_content as the real client returns it (a metadata item, then the file as a resource item): what open_file reads (play.ts patches the blocked client with it).
  attachmentContent = (messageId: number, attachmentId: number): unknown[] => {
    const a = this.conversations.flatMap((c) => c.messages).find((m) => m.id === Number(messageId))?.attachments.find((x) => x.id === Number(attachmentId));
    if (!a) throw new Error("Attachment not found");
    return [{ type: "text", text: JSON.stringify({ attachmentId: a.id, fileName: a.fileName, mimeType: a.mimeType, size: a.size }) }, { type: "resource", resource: { uri: `attachment://${a.id}`, mimeType: a.mimeType, blob: Buffer.from(a.text).toString("base64") } }];
  };

  // For the state checks.
  folderOf(subjectPart: string): Folder[] {
    return this.conversations.filter((c) => c.subject.toLowerCase().includes(subjectPart.toLowerCase())).map((c) => c.folder);
  }
  drafts(): Message[] {
    return this.conversations.filter((c) => c.folder === "drafts").flatMap((c) => c.messages);
  }
}
