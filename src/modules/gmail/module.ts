import { GMAIL_PREFIX, gmailVerdict, isGmailTool, isInboxArchive, isSelfSend } from "./gmailrules.ts";
import { addrs, nativeView } from "../../policy/mailview.ts";
import type { DraftView } from "../mailbird/proposals.ts";
import { DELETE_CONFIRM } from "../../policy/neverallowed.ts";
import { settings } from "../../core/settings.ts";
import { archiveGate } from "../archivecap.ts";
import { rowsOf, type MailSlot, type ToolModule } from "../types.ts";

// The Gmail connector (MAIL_PROVIDER=gmail): claude.ai's own Gmail connector, inherited from the owner's Claude login like Notion. Its rules that a row cannot
// say (sensitive labels, attachment content, the brief to oneself) are gmailrules.ts, which this module hands to the floor.
// Sending is only on the owner's word. The mail relay (src/modules/gmail/gmail.ts), `npm run restore` and the doctor check are runtime.ts.

// The approval's read-backs: a draft by its id (the approval of send_message with a draftId), and the original message of a reply (its sender and recipients,
// so a reply that names none is shown with the people who really receive it). Set by runtime.ts when the app starts.
export interface GmailReaders {
  draft: (draftId: string) => Promise<DraftView | undefined>;
  original: (messageId: string) => Promise<DraftView | undefined>;
}
let readers: GmailReaders | undefined;
export const setGmailReaders = (r: GmailReaders | undefined) => void (readers = r);

const active = () => settings.mailProvider === "gmail";

const gm = rowsOf(GMAIL_PREFIX, "gmail", "mail");

const GMAIL_DRAFTS = (owner: string) => `Mail is Gmail. A reply you (or a background look of yours) draft is a Gmail draft (create_draft with replyToMessageId, or update_draft); say it is ready and wait. When ${owner} answers with "send" or similar, find the draft they mean (its id is the draftId). When ${owner} says to send a draft, call send_message with that draftId, or reply / forward with the exact text; ${owner} is then asked to approve (or it is checked) with the real recipients shown. Archiving is removing the INBOX label (unlabel_thread with labelIds ["INBOX"]); it may be switched to log-only, in which case a refused archive is not an error. Never use trash, spam or label tools for TRASH or SPAM, and never open attachment content.

`;

// How the brief is delivered (the daily-brief skill, step 6): the mail pass uses the gmail skill and the Gmail connector. With BRIEF_EMAIL=on the brief is also emailed to
// the owner's own address with send_message (the one send a background run may do without asking, gmailrules.ts); otherwise the chat message is the brief.
const BRIEF_GMAIL = "The mail is Gmail: wherever the skill says to run 'ted-personal-assistant:mailbird', load 'ted-personal-assistant:gmail' instead and use the Gmail tools it names; the mailbird tools do not exist here.";
const briefHow = (email: boolean = settings.briefEmail): string =>
  email && settings.mailSelfAddress
    ? `${BRIEF_GMAIL} Deliver the full brief with the Gmail send_message tool, exactly once, to ${JSON.stringify([settings.mailSelfAddress])} and nobody else (no cc, no bcc, no attachments, no draftId): subject starting with the emoji the skill names, body the complete brief as plain text (body, not htmlBody).`
    : `${BRIEF_GMAIL} Do not deliver by email: your final answer is the whole brief itself, in the skill's format.`;

const mail: MailSlot = {
  brief: { how: briefHow },
  chat: { skill: "ted-personal-assistant:gmail", note: GMAIL_DRAFTS },
  readBack: async (kind, input) => {
    if (kind === "gmSend" && typeof input.draftId === "string" && readers) return readers.draft(input.draftId).catch(() => undefined);
    if (kind === "gmReply" && typeof input.messageId === "string" && readers) return readers.original(input.messageId).catch(() => undefined);
    return undefined;
  },
  views: {
    // A send of a Gmail draft is shown from the draft as read back (get_draft). A new send, reply or forward is read from its own
    // arguments; a reply that names no recipients goes to the people of the original message, read back (`draft` = the original's
    // sender and recipients), so the approval and the judge floor see who really receives it.
    gmSend: (i, draft) => (i.draftId ? draft && { action: "send", ...draft } : nativeView("send", i)),
    gmReply: (i, orig) => {
      const v = nativeView("reply", i);
      if (!orig) return i.replyAll ? undefined : v; // a reply-all cannot be shown without the original; explicit recipients, or none: permissions.ts reads the original back first and refuses a reply nobody can be named for
      const to = addrs(i.to).length ? v.to : i.replyAll ? orig.to : orig.to.slice(0, 1); // orig.to: the sender first, then (reply-all) the other recipients
      const cc = i.cc !== undefined ? v.cc : i.replyAll ? orig.cc : [];
      return { ...v, to: [...new Set(to)], cc: [...new Set(cc)], subject: v.subject || orig.subject };
    },
    gmForward: (i) => nativeView("forward", i),
    gmDraft: (i) => nativeView("draft", i),
  },
};

export const named = (_input: Record<string, unknown>, view?: { to: string[] }) => !!view && view.to.length > 0; // a mail nobody can be named for (a forward draft with no recipient yet) is not judged

export const gmailModule: ToolModule = {
  name: "gmail",
  slot: "mail",
  connection: { kind: "connector", key: "gmail", label: "Gmail", skipped: "the mail pass, drafts and the brief by email", server: /^gmail$/i, prefix: GMAIL_PREFIX },
  rows: [
    ...gm("read", "search_threads get_thread get_message get_draft list_drafts list_labels"),
    ...gm("draft", "create_draft update_draft", { view: "gmDraft" }),
    ...gm("send", "send_message", { view: "gmSend" }),
    ...gm("reply", "reply", { view: "gmReply" }),
    ...gm("forward", "forward", { view: "gmForward" }),
    ...gm("archive", "unlabel_thread"), // removing INBOX is an archive; undoing it adds a label, which is a different action
    ...gm("label", "label_thread label_message unlabel_message update_message_labels create_label update_label apply_sensitive_message_label apply_sensitive_thread_label"),
    // Never allowed, for everyone (neverallowed.ts NEVER_ACTIONS), delete_draft aside (below); untrash and unmark are the same family and stay out of reach too.
    ...gm("trash", "trash_message trash_thread untrash_message untrash_thread"),
    ...gm("spam", "mark_message_spam mark_thread_spam unmark_message_spam unmark_thread_spam"),
    ...gm("delete", "delete_label"),
    ...gm(DELETE_CONFIRM, "delete_draft"), // a draft thrown away: allowed but not routine (neverallowed.ts DELETE_CONFIRM), judged with care
  ],
  free: ["read"],
  // The brief the heartbeat's expert emails to the owner's own address (BRIEF_EMAIL=on): one plain recipient that IS the configured address, nothing else (gmailrules.ts isSelfSend).
  freeWhen: { send: (input, source) => source === "background" && active() && (settings.briefEmail || settings.routines.some((r) => r.planned && r.enabled && r.email)) && isSelfSend(`${GMAIL_PREFIX}send_message`, input, settings.mailSelfAddress) },
  titles: {
    [`${GMAIL_PREFIX}send_message`]: { icon: "✉️", title: "Send email" },
    [`${GMAIL_PREFIX}forward`]: { icon: "✉️", title: "Forward email" },
    [`${GMAIL_PREFIX}reply`]: { icon: "✉️", title: "Reply to email" },
    [`${GMAIL_PREFIX}delete_draft`]: { icon: "🗑️", title: "Delete draft", labels: { draftId: "Draft" } },
  },
  untrustedPrefix: GMAIL_PREFIX,
  floor: {
    perRun: archiveGate, // at most ARCHIVE_MAX_PER_RUN archives per run (archivecap.ts)
    // Gmail's rules a row cannot say: attachment content, raw MIME, label renames (gmailrules.ts). They hold whichever provider is
    // active: they only restrict, so the connector's tools stay as refused as before if it is ever seen under another provider.
    verdict: (tool, input) => (isInboxArchive(tool, input) && !active() ? "deny" : gmailVerdict(tool, input)), // an archive is the Gmail provider's: under another provider the connector stays refused
    onDeny: (tool) => (isGmailTool(tool) ? { withIds: true } : undefined),
    judgeVeto: { send: named, reply: named, forward: named },
    creates: (name) => name === "create_draft",
    noFix: ["send", "reply", "forward"],
  },
  skills: [{ name: "gmail", required: true }],
  setup: [{ file: "voice-writing.md", label: "how you write (for email drafts)", mailOnly: true }],
  hide: {
    prefix: GMAIL_PREFIX,
    visible: ["search_threads", "get_thread", "get_message", "get_draft", "list_drafts", "list_labels", "create_draft", "update_draft", "delete_draft", "reply", "forward", "send_message", "unlabel_thread", "label_thread"],
    valid: /^[a-z_]+$/,
    hint: "a Gmail tool name like get_thread",
  },
  known: "apply_sensitive_message_label apply_sensitive_thread_label create_draft create_label delete_draft delete_label forward get_draft get_message get_thread label_message label_thread list_drafts list_labels mark_message_spam mark_thread_spam reply search_threads send_message trash_message trash_thread unlabel_message unlabel_thread unmark_message_spam unmark_thread_spam untrash_message untrash_thread update_draft update_label update_message_labels"
    .split(" ")
    .map((t) => `${GMAIL_PREFIX}${t}`),
  mail,
};
