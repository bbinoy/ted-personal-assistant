import { nativeView } from "../../policy/mailview.ts";
import type { DraftView } from "./proposals.ts";
import { DELETE_CONFIRM } from "../../policy/neverallowed.ts";
import { archiveGate } from "../archivecap.ts";
import { rowsOf, type MailSlot, type ToolModule } from "../types.ts";

// Mailbird, the owner's desktop mail client, through its local MCP server (a user-scope entry of the owner's Claude settings): the default mail provider
// (MAIL_PROVIDER=mailbird). The approval of a send is shown from the draft as Mailbird holds it. The client, `npm run restore` and the doctor check are runtime.ts.
const MB = "mcp__mailbird__";

const mb = rowsOf(MB, "mailbird", "mail");

// Set by runtime.ts when the app starts: reads a draft back from Mailbird, for the approval of a send.
let draftReader: ((messageId: number) => Promise<DraftView | undefined>) | undefined;
export const setDraftReader = (fn: typeof draftReader) => void (draftReader = fn);

const mail: MailSlot = {
  brief: { tool: () => `${MB}send_self_briefing`, how: () => "Deliver the full brief by email with the Mailbird send_self_briefing tool, exactly once, with the subject the skill names (never its default subject)." },
  chat: { skill: "ted-personal-assistant:mailbird", name: "Mailbird", find: "get_message with its id if you know it, else look in the drafts", send: "send_message_now with messageId and confirm true", edit: "update_draft" },
  readBack: async (kind, input) => {
    const id = Number(input.messageId);
    // An unreadable draft refuses the send (permissions.ts), so the reason is logged here: the owner sees "could not be read back", the log says why.
    return kind === "mbSend" && draftReader && Number.isFinite(id) ? draftReader(id).catch((e) => (console.error(`mailbird: draft ${id} could not be read back: ${(e as Error)?.message?.slice(0, 200)}`), undefined)) : undefined;
  },
  views: {
    mbSend: (_i, draft) => draft && { action: "send", ...draft }, // a send of an existing draft has no content in its input: it is shown from the draft as read back, or not at all
    mbDraft: (i) => nativeView("draft", i),
    mbReply: (i) => nativeView("draft", { body: i.body }), // recipients come from the thread, set by the client
    mbForward: (i) => nativeView("forward", { body: i.body }), // recipients start empty and are set with update_draft
  },
};

export const mailbirdModule: ToolModule = {
  name: "mailbird",
  slot: "mail",
  // A draft that is about to be thrown away is shown by its subject, read back from Mailbird like a draft that is about to be sent.
  describe: async (tool, input) => {
    const id = Number(input.messageId);
    const d = tool === `${MB}discard_draft` && draftReader && Number.isFinite(id) ? await draftReader(id).catch(() => undefined) : undefined;
    return d?.subject ? `Draft “${d.subject}”${d.to.length ? ` to ${d.to.join(", ")}` : ""}` : undefined;
  },
  connection: { kind: "connector", key: "mail", server: /^mailbird$/i, prefix: MB },
  rows: [
    ...mb("read", "summarize_all_inboxes list_accounts list_folders list_conversations search_conversations get_message get_conversation list_attachments get_attachment_content get_send_status get_help get_ui_state"),
    ...mb("archive", "archive_conversation"),
    ...mb("restore", "move_conversation_to_inbox"),
    ...mb("select", "select_conversation"),
    // Never allowed, for everyone (neverallowed.ts NEVER_ACTIONS): trash, permanent delete of a conversation, spam, blocking a sender.
    ...mb("trash", "trash_conversation"),
    ...mb("delete", "delete_conversation_permanently"),
    ...mb(DELETE_CONFIRM, "discard_draft"), // a draft thrown away: allowed but not routine (neverallowed.ts DELETE_CONFIRM): judged with care, never fixed, never free
    ...mb("spam", "set_conversation_spam"),
    ...mb("block", "set_sender_blocked"),
    // The destination may be Trash or Junk, so the call is the owner's own: filing mail is asked (and never judged), not denied.
    ...mb("move", "move_conversation"),
    ...mb("notify", "show_notification"), // a desktop notification: not free, judged like any action
    ...mb("unsubscribe", "unsubscribe_from_newsletter"), // not free: floor, judge, phone like any action; the judge asks when the mail itself pushes it (a phishing pattern)
    ...mb("draft", "create_draft update_draft", { view: "mbDraft" }),
    ...mb("reply-draft", "reply_to_conversation reply_all_to_conversation", { view: "mbReply" }),
    ...mb("send-self", "send_self_briefing"), // can only ever reach the owner
    ...mb("send", "send_message_now", { view: "mbSend" }),
    // Mailbird's forward only saves a draft with no recipients (the skill: forward freely, never send_message_now unseen); the real send is send_message_now above.
    ...mb("draft", "forward_conversation", { view: "mbForward" }),
  ],
  free: ["read"],
  titles: { [`${MB}discard_draft`]: { icon: "🗑️", title: "Delete draft", labels: { messageId: "Draft (message id)" } }, [`${MB}send_message_now`]: { icon: "✉️", title: "Send email now" }, [`${MB}forward_conversation`]: { icon: "✉️", title: "Forward email" } },
  untrustedPrefix: MB, // (mail is written by third parties: every read is untrusted by default)
  floor: {
    perRun: archiveGate, // at most ARCHIVE_MAX_PER_RUN archives per run (archivecap.ts)
    judgeVeto: { send: (_input, view) => !!view && view.to.length > 0 }, // a mail nobody can be named for is not judged
    judgeNever: ["move"],
    creates: (name) => ["create_draft", "reply_to_conversation", "reply_all_to_conversation", "forward_conversation"].includes(name), // they save a draft; its id is in the result
    noFix: ["send", "unsubscribe"],
  },
  skills: [{ name: "mail", required: true }, { name: "mailbird", required: true }],
  setup: [{ file: "voice-writing.md", label: "how you write (for email drafts)", mailOnly: true }],
  hide: {
    prefix: MB,
    visible: [
      "summarize_all_inboxes", "list_accounts", "list_folders", "list_conversations", "search_conversations", "get_message", "get_conversation",
      "list_attachments", "get_attachment_content", "archive_conversation", "move_conversation_to_inbox", "select_conversation", "reply_to_conversation",
      "reply_all_to_conversation", "create_draft", "update_draft", "discard_draft", "forward_conversation", "send_message_now", "get_send_status", "send_self_briefing",
    ],
    valid: /^[a-z_]+$/,
    hint: "a Mailbird tool name like get_message",
  },
  known: "archive_conversation copy_conversation create_draft delete_conversation_permanently discard_draft forward_conversation get_attachment_content get_conversation get_help get_message get_send_status get_ui_state list_accounts list_attachments list_conversations list_folders mark_all_as_read move_conversation move_conversation_to_inbox reply_all_to_conversation reply_to_conversation search_conversations select_conversation send_message_now send_self_briefing set_conversation_important set_conversation_read set_conversation_spam set_conversation_starred set_sender_blocked show_notification snooze_conversation summarize_all_inboxes trash_conversation unsubscribe_from_newsletter update_draft"
    .split(" ")
    .map((t) => `${MB}${t}`),
  mail,
};
