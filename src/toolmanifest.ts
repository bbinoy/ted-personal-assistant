import type { Source } from "./audit.ts";
import { settings } from "./settings.ts";
import type { Capability } from "./tenants.ts";

// THE tool manifest: every tool the model might get declares here what it is, so one rule applies the same way across mail providers and other
// tools. policy.ts, autojudge.ts, permissions.ts and format.ts read this table; none keeps a tool list of its own.
//
// A row says WHAT a tool is (provider, action), which capability gates it (`cap`), where it exists at all (`only`) and how a mail call is read (`view`).
// It does not say who may use it or whether the owner is asked: that is one path for every tool in every place (chat, group, tenant, mail handler,
// brief, radar, wake-up, browse), in permissions.ts: the code floor (policy.ts: the never-allowed set and the capability set of a group or a tenant;
// autojudge.ts: what may never be judged), then the approval judge (approvaljudge.ts), then the question on the owner's phone. The one thing a
// row decides is whether the tool is `free` (isFree below): a plain read or the assistant's own plumbing runs without the judge, everything else is judged.
// `only` limits a tool to some sources and is used for two things: the browse sub-run's browser, and the tools that need a conversation to exist in
// (send, draw, voice, the notes). Anywhere else such a tool is denied outright (policy.ts classify).
// `cap` is the capability that gates the tool (tenants.ts CAPABILITIES). A group or a tenant is offered the tool only when its capability set holds
// that capability (capabilities.ts) and `only` names "group" or does not limit the sources. The default is the provider's capability.
// Not here, on purpose: the never-allowed set (policy.ts DENY: trading, trash/delete/spam/unsubscribe) and which tools a group or tenant
// has at all (its capability set, capabilities.ts).

export type ViewKind = "mbSend" | "mbDraft" | "mbReply" | "mbForward" | "gmSend" | "gmReply" | "gmForward" | "gmDraft";

export interface ToolEntry {
  tool: string;
  provider: string; // mailbird, gmail, calendar, notion, drive, docs, builtin, memory
  action: string; // read, draft, reply-draft, send, reply, forward, archive, restore, label, select, send-self, calendar-write, ...
  cap: Capability; // what gates it: the capability a conversation needs to be offered the tool
  only?: readonly Source[];
  view?: ViewKind; // a mail tool: how mailView() reads its input
}

// Mailbird's and the Gmail connector's mail provider tags: an entry takes effect only while that provider is the active one.
export const MAIL_PROVIDERS = ["mailbird", "gmail"];

const MB = "mcp__mailbird__";
const GM = "mcp__claude_ai_Gmail__";
const CAL = "mcp__claude_ai_Google_Calendar__";
const NOTION = "mcp__claude_ai_Notion__";
const BR = "mcp__browser__browser_";
const DRIVE ="mcp__claude_ai_Google_Drive__";

// The capability of each provider's tools, unless a row says otherwise.
const PROVIDER_CAP: Readonly<Record<string, Capability>> = { mailbird: "mail", gmail: "mail", calendar: "calendar", notion: "notion", drive: "google", docs: "google", builtin: "chat", memory: "chat", tenants: "admin", intake: "intake", send: "chat", draw: "draw", weather: "weather", voice: "voice", browse: "browse" };

type Opts = { only?: readonly Source[]; view?: ViewKind; cap?: Capability };
const rows = (prefix: string, provider: string, action: string, names: string, o: Opts = {}): ToolEntry[] =>
  names.split(" ").map((n) => ({ tool: prefix + n, provider, action, ...o, cap: o.cap ?? PROVIDER_CAP[provider]! }));

export const MANIFEST: readonly ToolEntry[] = [
  // --- Mailbird ---
  ...rows(MB, "mailbird", "read", "summarize_all_inboxes list_accounts list_folders list_conversations search_conversations get_message get_conversation list_attachments get_attachment_content get_send_status get_help get_ui_state"),
  ...rows(MB, "mailbird", "archive", "archive_conversation"),
  ...rows(MB, "mailbird", "restore", "move_conversation_to_inbox"),
  ...rows(MB, "mailbird", "select", "select_conversation"),
  ...rows(MB, "mailbird", "draft", "create_draft update_draft", { view: "mbDraft" }),
  ...rows(MB, "mailbird", "reply-draft", "reply_to_conversation reply_all_to_conversation", { view: "mbReply" }),
  ...rows(MB, "mailbird", "send-self", "send_self_briefing"), // can only ever reach the owner
  ...rows(MB, "mailbird", "send", "send_message_now", { view: "mbSend" }),
  // Mailbird's forward only saves a draft with no recipients (the skill: forward freely, never send_message_now unseen); the real send is send_message_now above.
  ...rows(MB, "mailbird", "draft", "forward_conversation", { view: "mbForward" }),
  // --- Gmail connector: data for later, takes effect only when MAIL_PROVIDER=gmail ---
  ...rows(GM, "gmail", "read", "search_threads get_thread get_message get_draft list_drafts list_labels"),
  ...rows(GM, "gmail", "draft", "create_draft update_draft", { view: "gmDraft" }),
  ...rows(GM, "gmail", "send", "send_message", { view: "gmSend" }),
  ...rows(GM, "gmail", "reply", "reply", { view: "gmReply" }),
  ...rows(GM, "gmail", "forward", "forward", { view: "gmForward" }),
  ...rows(GM, "gmail", "archive", "unlabel_thread"), // removing INBOX is an archive; undoing it adds a label, which is a different action
  ...rows(GM, "gmail", "label", "label_thread label_message unlabel_message update_message_labels create_label update_label apply_sensitive_message_label apply_sensitive_thread_label"),
  // --- Calendar ---
  ...rows(CAL, "calendar", "read", "list_calendars list_events get_event search_events suggest_time"),
  ...rows(CAL, "calendar", "calendar-write", "create_event update_event"), // the guest floor is a code veto (autojudge.ts)
  ...rows(CAL, "calendar", "calendar-respond", "respond_to_event"),
  // --- Notion, Drive, Docs ---
  ...rows(NOTION, "notion", "read", "notion-fetch notion-search"),
  ...rows(NOTION, "notion", "page-write", "notion-create-pages notion-update-page"),
  ...rows(NOTION, "notion", "comment-write", "notion-create-comment"),
  ...rows(DRIVE, "drive", "read", "search_files read_file_content download_file_content get_file_metadata get_file_permissions list_recent_files"),
  ...rows(DRIVE, "drive", "drive-write", "create_file update_file copy_file"),
  ...rows(DRIVE, "drive", "share", "share_file"),
  ...rows("mcp__claude_ai_Google_Docs__", "docs", "read", "read_doc"),
  ...rows("mcp__claude_ai_Google_Docs__", "docs", "doc-write", "update_doc"),
  // --- the assistant's own: web, skills, notes ---
  ...rows("", "builtin", "web-search", "WebSearch"), // a search query is a small channel out, accepted: the model is offered the tool only in runs that have the owner behind them (agentrun.ts builtinTools)
  ...rows("", "builtin", "web-fetch", "WebFetch"), // judged; the plain-address veto is code (autojudge.ts)
  ...rows("", "builtin", "skill", "Skill"), // which skills load is limited by the SDK's skills allowlist (agent.ts, skills.ts); a group or tenant has the tool only with a shared skill to load
  // The file tools are for the owner's chat and, inside their own notes folder, for groups and tenants; WHICH path is code (policy.ts classify).
  ...rows("", "builtin", "note-file", "Read Write Edit", { only: ["chat", "group"] }),
  // The memory tools are scoped to the conversation by their server (memory-tools.ts); undoing a dream goes with the dream.
  ...rows("mcp__memory__", "memory", "memory", "forget_note search_logs", { only: ["chat", "group"] }),
  ...rows("mcp__memory__", "memory", "memory", "undo_dream", { only: ["chat", "group"], cap: "dream" }),
  // The owner's tenant administration (tenanttools.ts), only while TENANTS=on: minting an invite and looking are free; stopping a tenant or deleting her and her data is never judged.
  ...rows("mcp__tenants__", "tenants", "tenants-read", "create_invite list_tenants resume_tenant", { only: ["chat"] }),
  ...rows("mcp__tenants__", "tenants", "tenants-stop", "suspend_tenant remove_tenant", { only: ["chat"] }),
  // intake (intaketools.ts): a tenant's single-use link to the page where she types a secret herself, and what it stored as names and lengths. Tenant runs only (they are "group" runs).
  ...rows("mcp__intake__", "intake", "intake", "get_setup_link setup_status", { only: ["group"] }),
  // send (send.ts): a message, voice note, picture (a browse screenshot of this run) or reaction in the conversation the run is for, while it continues.
  // It needs a conversation to send to: chat and groups.
  ...rows("mcp__send__", "send", "send", "send", { only: ["chat", "group"] }),
  // draw (drawtool.ts): an SVG sanitised and rendered by code to a PNG kept for the turn; nothing leaves until `send` delivers it. Needs a conversation.
  ...rows("mcp__draw__", "draw", "draw", "draw", { only: ["chat", "group"] }),
  // weather (weathertools.ts): public forecast and map data, read-only. The owner's chat and groups.
  ...rows("mcp__weather__", "weather", "read", "search_places get_forecast get_marine_forecast get_spot_info get_distance", { only: ["chat", "group"] }),
  // voice (voicetool.ts): the conversation's own cloned voice, Qwen only. Needs a conversation.
  ...rows("mcp__voice__", "voice", "voice", "voice", { only: ["chat", "group"] }),
  // --- the browse sub-task (browse.ts). The entry tool starts a sandboxed run; it is judged like everything else. ---
  ...rows("mcp__browse__", "browse", "browse", "browse"),
  // The browser server's tools, in the browse run only (denied everywhere else). Which element a click or a field is, and which
  // addresses are fine, is code (browse.ts): reads and plain clicks run, a page address and typed text go to the approval judge, a
  // click that commits (book, buy, send...) is turned into an ask by code, payment and login fields are denied. Any other tool of the server is denied there.
  ...rows(BR, "browse", "browser-read", "snapshot find wait_for tabs hover navigate_back click press_key take_screenshot mouse_click_xy mouse_move_xy mouse_wheel", { only: ["browse"] }),
  ...rows(BR, "browse", "browser-nav", "navigate", { only: ["browse"] }),
  ...rows(BR, "browse", "browser-input", "type fill_form select_option", { only: ["browse"] }),
  ...rows(BR, "browse", "browser-dialog", "handle_dialog", { only: ["browse"] }),
];

// Read verbs, matched against the tool's own name (after the server name), ignoring a "notion-" style prefix: both
// "get_message" and "notion-fetch" are reads. Covers the read tools nobody listed above.
const READ_VERB = /^(list|get|search|read|query|fetch|summarize|suggest|whats|download|show|ai-search)/i;
const readVerb = (tool: string) => READ_VERB.test((tool.split("__").pop() ?? "").replace(/^notion-/i, ""));

export type MailProvider = "none" | "mailbird" | "gmail";

// A mail provider's entries count only while it is the active one; every other provider's always do.
const active = (e: ToolEntry, mail: MailProvider) => !MAIL_PROVIDERS.includes(e.provider) || e.provider === mail;

const cache = new Map<MailProvider, Map<string, ToolEntry>>();
export function entryFor(tool: string, mail: MailProvider = settings.mailProvider): ToolEntry | undefined {
  let m = cache.get(mail);
  if (!m) cache.set(mail, (m = new Map(MANIFEST.filter((e) => active(e, mail)).map((e) => [e.tool, e]))));
  return m.get(tool);
}

export const actionOf = (tool: string, mail?: MailProvider): string => entryFor(tool, mail)?.action ?? (readVerb(tool) ? "read" : "unknown");
export const isReadTool = (tool: string): boolean => actionOf(tool) === "read";

// Does this tool exist for this source at all? (`only`.) A tool the manifest does not know exists everywhere; classify asks about it.
export function availableFor(tool: string, source: Source, mail?: MailProvider): boolean {
  const e = entryFor(tool, mail);
  return !e || !e.only || e.only.includes(source);
}

// Free: the call runs without the judge and without a question, because it changes nothing of the owner's and sends nothing out: a read, and the
// assistant's own plumbing (its notes, memory, skills, the conversation's own send, draw and voice, the browser's reads). Everything else, a tool the
// manifest does not know included, is not free: it is judged (autojudge.ts) or asked. Which PATH a note tool may touch is code (policy.ts classify).
const FREE_PROVIDERS = new Set(["memory", "intake", "send", "draw", "voice", "weather"]);
const FREE_ACTIONS = new Set(["read", "web-search", "skill", "note-file", "tenants-read", "browser-read"]);
export function isFree(tool: string, mail?: MailProvider): boolean {
  const e = entryFor(tool, mail);
  return e ? FREE_PROVIDERS.has(e.provider) || FREE_ACTIONS.has(e.action) : readVerb(tool);
}

// Reading these shows the run text a third party wrote: mail, a web page, a search result. After one, the run's arguments may be steered by it
// (permissions.ts tells the judge). The mail providers' reads only count while that provider is active; an unlisted tool with a read verb of a mail
// connector counts too, and so does anything in the browse run.
export function readsUntrusted(tool: string, mail?: MailProvider): boolean {
  const e = entryFor(tool, mail);
  if (!e) return readVerb(tool) && (tool.startsWith("mcp__mailbird__") || tool.startsWith("mcp__claude_ai_Gmail__"));
  return (MAIL_PROVIDERS.includes(e.provider) && e.action === "read") || e.action === "web-fetch" || e.action === "web-search" || e.provider === "browse";
}

// --- one view of an outgoing mail call, whatever the provider ---

export type MailAction = "send" | "reply" | "forward" | "draft";
export interface MailView {
  action: MailAction;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  hasAttachments: boolean;
}

// Pure: recipients as lower-case addresses, from strings or {email|address} objects.
export function addrs(v: unknown): string[] {
  return (Array.isArray(v) ? v : v ? [v] : [])
    .map((x) => String((x as { email?: string; address?: string })?.email ?? (x as { address?: string })?.address ?? x).trim().toLowerCase())
    .filter(Boolean);
}

type In = Record<string, unknown>;
const native = (action: MailAction, i: In): MailView => ({
  action,
  to: addrs(i.to),
  cc: addrs(i.cc),
  bcc: addrs(i.bcc),
  subject: String(i.subject ?? ""),
  body: String(i.body ?? i.htmlBody ?? i.forwardText ?? ""),
  hasAttachments: Array.isArray(i.attachments) && i.attachments.length > 0,
});

// A send of an existing draft (a Mailbird messageId, a Gmail draftId) has no content in its input: it is shown from the draft as
// read back, or not at all. A view that cannot be made means the call cannot be shown for approval.
const VIEWS: Record<ViewKind, (i: In, draft?: Omit<MailView, "action">) => MailView | undefined> = {
  mbSend: (_i, draft) => draft && { action: "send", ...draft },
  mbDraft: (i) => native("draft", i),
  mbReply: (i) => native("draft", { body: i.body }), // recipients come from the thread, set by the client
  mbForward: (i) => native("forward", { body: i.body }), // recipients start empty and are set with update_draft
  // A send of a Gmail draft is shown from the draft as read back (get_draft). A new send, reply or forward is read from its own
  // arguments; a reply that names no recipients goes to the people of the original message, read back (`draft` = the original's
  // sender and recipients), so the approval and the judge floor see who really receives it.
  gmSend: (i, draft) => (i.draftId ? draft && { action: "send", ...draft } : native("send", i)),
  gmReply: (i, orig) => {
    const v = native("reply", i);
    if (!orig) return i.replyAll ? undefined : v; // a reply-all cannot be shown without the original; explicit recipients, or none: permissions.ts reads the original back first and refuses a reply nobody can be named for
    const to = addrs(i.to).length ? v.to : i.replyAll ? orig.to : orig.to.slice(0, 1); // orig.to: the sender first, then (reply-all) the other recipients
    const cc = i.cc !== undefined ? v.cc : i.replyAll ? orig.cc : [];
    return { ...v, to: [...new Set(to)], cc: [...new Set(cc)], subject: v.subject || orig.subject };
  },
  gmForward: (i) => native("forward", i),
  gmDraft: (i) => native("draft", i),
};

// Pure. The tool's call as one view: send, reply, forward or draft, with bcc and attachments always in it. Undefined for a
// tool that is not a mail tool of the active provider, or a call that cannot be read (a send of a draft nobody read back).
export function mailView(tool: string, input: In, draft?: Omit<MailView, "action">, mail?: MailProvider): MailView | undefined {
  const kind = entryFor(tool, mail)?.view;
  return kind ? VIEWS[kind](input, draft) : undefined;
}
