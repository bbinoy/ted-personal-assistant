import { BRIEF_INSTRUCTIONS, BRIEF_TOOL } from "../brieftext.ts";
import { nativeView } from "../mailview.ts";
import type { DraftView } from "../proposals.ts";
import { rowsOf, type MailSlot, type ToolModule } from "./types.ts";

// Mailbird, the owner's desktop mail client, through its local MCP server (a user-scope entry of the owner's Claude settings): the default mail provider
// (MAIL_PROVIDER=mailbird). The background handler drafts replies with its tools and shows them on the phone; the approval of a send is shown from the
// draft as Mailbird holds it. The client, `npm run restore` and the doctor check are runtime.ts.
const MB = "mcp__mailbird__";

const mb = rowsOf(MB, "mailbird", "mail");

// Set by runtime.ts when the app starts: reads a draft back from Mailbird, for the approval of a send.
let draftReader: ((messageId: number) => Promise<DraftView | undefined>) | undefined;
export const setDraftReader = (fn: typeof draftReader) => void (draftReader = fn);

const mail: MailSlot = {
  handler: true,
  archiveLogOnly: () => false,
  reportNote: () => undefined,
  brief: {
    delivery: () => "email",
    instructions: () => BRIEF_INSTRUCTIONS,
    captured: (tool, input) => (tool === BRIEF_TOOL ? { text: (input as { markdownBody?: string }).markdownBody } : undefined), // the agent emails the brief with this tool
  },
  chat: {
    skill: "ted-personal-assistant:mailbird",
    note: (owner) => `Reply drafts: the background handler shows ${owner} drafts as "✉️ Reply ready (draft #<id>)". When ${owner} replies to such a message (you get the quoted message) with "send" or similar, call get_message with that id to be sure which draft it is, then send_message_now with messageId and confirm true; ${owner} is then asked to approve, with the draft shown exactly as Mailbird holds it. If they ask for a change, edit the draft (update_draft) and say so; do not send. If it is unclear which draft they mean, ask. Never send anything ${owner} has not told you to send; a plain yes, ok or 👍 to your offer to send counts.

`,
  },
  readBack: async (kind, input) => {
    const id = Number(input.messageId);
    return kind === "mbSend" && draftReader && Number.isFinite(id) ? draftReader(id).catch(() => undefined) : undefined;
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
  connection: { kind: "connector", key: "mail", server: /^mailbird$/i, prefix: MB },
  rows: [
    ...mb("read", "summarize_all_inboxes list_accounts list_folders list_conversations search_conversations get_message get_conversation list_attachments get_attachment_content get_send_status get_help get_ui_state"),
    ...mb("archive", "archive_conversation"),
    ...mb("restore", "move_conversation_to_inbox"),
    ...mb("select", "select_conversation"),
    ...mb("unsubscribe", "unsubscribe_from_newsletter"), // not free: floor, judge, phone like any action; the judge asks when the mail itself pushes it (a phishing pattern)
    ...mb("draft", "create_draft update_draft", { view: "mbDraft" }),
    ...mb("reply-draft", "reply_to_conversation reply_all_to_conversation", { view: "mbReply" }),
    ...mb("send-self", "send_self_briefing"), // can only ever reach the owner
    ...mb("send", "send_message_now", { view: "mbSend" }),
    // Mailbird's forward only saves a draft with no recipients (the skill: forward freely, never send_message_now unseen); the real send is send_message_now above.
    ...mb("draft", "forward_conversation", { view: "mbForward" }),
  ],
  free: ["read"],
  titles: { [`${MB}send_message_now`]: { icon: "✉️", title: "Send email now" }, [`${MB}forward_conversation`]: { icon: "✉️", title: "Forward email" } },
  untrusted: ["read"], // mail is written by third parties
  untrustedPrefix: MB,
  floor: {
    judgeVeto: { send: (_input, view) => !!view && view.to.length > 0 }, // a mail nobody can be named for is not judged
    noFix: ["send"],
  },
  skills: [{ name: "mailbird", required: true }, { name: "mailbird-troubleshooting" }],
  setup: [{ file: "voice-writing.md", label: "how you write (for email drafts)", mailOnly: true }],
  hide: { prefix: MB, keep: (cfg) => cfg.mailbirdTools },
  known: "archive_conversation copy_conversation create_draft delete_conversation_permanently discard_draft forward_conversation get_attachment_content get_conversation get_help get_message get_send_status get_ui_state list_accounts list_attachments list_conversations list_folders mark_all_as_read move_conversation move_conversation_to_inbox reply_all_to_conversation reply_to_conversation search_conversations select_conversation send_message_now send_self_briefing set_conversation_important set_conversation_read set_conversation_spam set_conversation_starred set_sender_blocked show_notification snooze_conversation summarize_all_inboxes trash_conversation unsubscribe_from_newsletter update_draft"
    .split(" ")
    .map((t) => `${MB}${t}`),
  mail,
};
