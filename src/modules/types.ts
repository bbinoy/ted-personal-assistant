import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentReply, RunOptions } from "../agentrun.ts";
import type { Source } from "../audit.ts";
import type { BrowseGuard } from "./browse/browseguard.ts";
import type { MailSource } from "../heartbeat.ts";
import type { createProposer } from "../propose.ts";
import type { DraftView } from "../proposals.ts";
import type { Capability } from "../tenants/tenants.ts";
import type { TenantRun } from "../tenants/tenanttools.ts";
import type { ConfirmDelete } from "../policy/neverallowed.ts";
import type { MailInput, MailView } from "../policy/mailview.ts";

// A TOOL MODULE: one file in src/modules/ that says everything the harness needs to know about one tool (or one family of tools): how it connects, which
// tools it has and what they are (the manifest rows), the floor rules only it can state, the skills it brings, the setup it needs. Nothing else in the code
// names its tools. There is no framework: a module is a plain object, the list of modules is a function in index.ts, and you add a tool by adding a file
// there and a line to that list. Modules are local code reviewed like any code; nothing is loaded from outside.
//
// What a module may NOT do: decide policy. Whether a call is allowed, asked or denied, the never-allowed set (neverallowed.ts: a module only names the ACTION of a
// row, or marks itself `never`), the capability sets of groups and tenants, the approval judge and its prompt, payments, the address checks, the browse guard,
// the approvers and the tenant isolation stay central. A module adds rows (what a tool IS) and floor DATA that the central code reads; its floor can only
// restrict (a veto, a deny, an ask), never grant: the one thing it may declare as free is a call of an action (`freeWhen`), which the central code still folds.
//
// Two halves, on purpose. The DECLARATION (this folder's files) is read by nearly everything: the manifest, policy, the judge, skills, notes, connectors,
// the prompts. So it imports almost nothing. The code a module WRAPS (the servers it starts, the mail clients it talks to, its doctor check) is bound in
// runtime.ts by the module's name and imported only by the places that start things (agentrun.ts, main.ts, heartbeat.ts, cli.ts, doctor.ts); without
// that split every low-level file would pull in the whole application through the module list, and the import cycles would break start-up.

// ---- the manifest rows ----

export type ViewKind = "mbSend" | "mbDraft" | "mbReply" | "mbForward" | "gmSend" | "gmReply" | "gmForward" | "gmDraft" | "ggSend" | "ggDraft";

// A row says WHAT a tool is. It carries no approval flag: whether a tool runs free of the judge is the module's `free`, and everything else is judged.
export interface ToolEntry {
  tool: string;
  provider: string; // mailbird, gmail, calendar, notion, drive, docs, builtin, memory, ...: a tag for logs and tests; the module owns the row
  action: string; // read, draft, reply-draft, send, reply, forward, archive, restore, label, select, send-self, calendar-write, ...
  cap: Capability; // what gates it: the capability a conversation needs to be offered the tool
  only?: readonly Source[];
  view?: ViewKind; // a mail tool: how the module's mail view reads its input
  offeredTo?: readonly Source[]; // a built-in tool (no MCP server): the sources whose run is handed it, for an owner run (agentrun.ts builtinTools; an isolated run gets the ones in its capability set)
}

type RowOpts = { only?: readonly Source[]; view?: ViewKind; cap?: Capability; offeredTo?: readonly Source[] };

// Rows for one family of tools: `rowsOf(prefix, provider, cap)` returns a function (action, "name name ...", options) that makes the rows.
export const rowsOf =
  (prefix: string, provider: string, cap: Capability) =>
  (action: string, names: string, o: RowOpts = {}): ToolEntry[] =>
    names.split(" ").map((n) => ({ tool: prefix + n, provider, action, ...o, cap: o.cap ?? cap }));

// ---- how a module connects ----

// What a run is for, as far as a module's connection can depend on it. The tools of one conversation may be served differently from another's: the owner's
// run gets the claude.ai connector, a tenant's run gets its own server process or connection with her token (the Google and Notion modules), a group's gets
// none. So whether a server exists is decided per run by the connection's `when`, never once for the whole process.
export interface RunContext {
  source: Source;
  browsing: boolean; // the browse sub-run (browse.ts): the browser and nothing else
  key?: string; // the conversation the run is for (the owner's chat, a group id, "tenant:<id>"); none for an unattended run
  groupId?: string;
  tenant?: TenantRun; // a tenant's run (her key, her ledger)
  memory?: RunOptions["memory"];
  guard?: BrowseGuard; // the browse run's guard
  mode: "owner" | "group";
  offers: (tool: string) => boolean; // an isolated conversation: is this tool in its capability set? (the owner's and unattended runs: always)
  browseRun: (prompt: string, guard: BrowseGuard) => Promise<AgentReply>; // starts the browse sub-run for this conversation, asking in its chat (agentrun.ts)
}

// The server runtime.ts builds under `name` when `when` holds for the run: a server made in this process ("in-process": send, draw, memory, ...) or a separate
// server process or URL ("external": the browser, a friend's Google server, a friend's Notion connection). `forBrowse`: it belongs to the browse sub-run, which has the browser and
// nothing else; every other server belongs to the other runs.
export type Connection =
  | { kind: "builtin" } // the SDK's own tools (Skill, Read, WebSearch, ...); nothing to connect
  | { kind: "connector"; key?: string; server: RegExp; prefix: string } // the owner's claude.ai connector or user-scope MCP server, inherited from the login; `server` and `prefix` say how to see whether it is up, `key` is its name in connectors.ts (absent: not reported)
  | { kind: "in-process" | "external"; name: string; when: (ctx: RunContext) => boolean; forBrowse?: true };

// For a friend's own connection: she is a tenant and her capability set offers at least one of the module's tools (the capability table decides, as for every tool).
export const tenantOffered =
  (rows: readonly ToolEntry[]) =>
  (ctx: RunContext): boolean =>
    !!ctx.tenant && rows.some((r) => ctx.offers(r.tool));

export type ServerFactory = (ctx: RunContext) => McpServerConfig;

// ---- the floor data ----

export type FloorVerdict = "allow" | "ask" | "deny";

// What a denied call is recorded and answered with when its module has more to say than "blocked by policy": a different audit row and message (`record`,
// `message`), or the ids the call touched in the usual deny row (`withIds`).
export interface Denial {
  record?: { tool: string; decision: string; meta: Record<string, unknown> };
  message?: string;
  withIds?: boolean;
}

// What a module may say about its own tools to the central code. All of it restricts or describes; none of it grants more than the manifest.
export interface ModuleFloor {
  // policy.ts classify, one step of the fold: a hard rule for this module's tools that a row cannot say (attachment content, a Gmail archive under another provider). It may only
  // restrict: "ask" or "deny", never "allow" (the verdict is the minimum of deny < ask < allow over the manifest and every floor).
  verdict?: (tool: string, input: Record<string, unknown>, source: Source) => Exclude<FloorVerdict, "allow"> | undefined;
  // permissions.ts, when classify denied the call: what to record and tell the model instead of the plain "blocked by policy".
  onDeny?: (tool: string, input: Record<string, unknown>) => Denial | undefined;
  // autojudge.ts isJudgeable: actions that are never judged (always asked), and a per-action veto on the call's own arguments (false: not judged).
  judgeNever?: readonly string[];
  judgeVeto?: Readonly<Record<string, (input: Record<string, unknown>, view?: MailView) => boolean>>;
  // autojudge.ts mayFix: actions whose `fix` verdict is always `ask` (a send, answering an invite). An action in judgeNever needs no entry: it is never judged.
  noFix?: readonly string[];
  // autojudge.ts: per action, a code-built line for the judge about the call (not shown to the owner).
  judgeNote?: Readonly<Record<string, (input: Record<string, unknown>) => string>>;
  // neverallowed.ts ConfirmDelete: tools of this module that delete only through an argument (Notion's in_trash, a friend's manage_event with action delete). The call is then
  // a delete to confirm like a row of action delete-confirm, not a denied one; the same arguments on any other tool stay denied.
  confirmDelete?: ConfirmDelete;
  // created.ts: the calls (by the name after the server's, and their arguments) whose result holds the id of something the assistant just made (a draft, an event, a page).
  // A later delete of exactly that id is told to the judge as "created by the assistant in this conversation".
  creates?: (name: string, input: Record<string, unknown>) => boolean;
  // policy.ts isModifiable: actions where "yes, but make it 16:00" may edit the call.
  editable?: readonly string[];
}

// ---- skills, setup ----

// How an approval question titles a call of a tool that is shown generically (format.ts); a mail call that mailView can read is shown from the view instead.
export interface CallTitle {
  icon: string;
  title: string;
  labels?: Record<string, string>; // argument name -> the label it is shown under
  whenDeleting?: string; // the title when the call is a delete the person confirms (toolmanifest.ts confirmsDelete): "Move Notion page to the bin"
}

export interface ModuleSkill {
  name: string; // the folder in plugin/skills
  shared?: readonly Capability[]; // a group or a tenant holding all of these may load it; absent: private to the owner
  when?: () => boolean; // offered to the owner only while this holds (the weather and draw switches)
  required?: boolean; // the doctor checks the folder is there
}

export type DoctorLine = (ok: boolean | "warn", what: string, detail?: string) => void;

// A question the setup skill asks that this module needs answered: the note it is saved under and what it is called.
export interface SetupNeed {
  file: string;
  label: string;
  needs?: string; // the connector whose absence makes the question moot (connectors.ts key)
  mailOnly?: true;
}

// ---- the mail slot ----

// What a module with mail-SENDING tools tells the approval about them, whether or not it is a mail provider: how each row's `view` reads its call, and how the
// mail client is asked what a send really holds (the read-back). A mail provider (MailSlot) has these; so does a friend's Google module, which is not a provider.
export interface MailTools {
  // The mail as the mail client holds it, for the approval of a send (permissions.ts): a send of a draft, or the original of a reply. `conversation`: the key of the
  // conversation whose tools these are ("tenant:<id>"), for a module whose client is per conversation.
  readBack: (kind: ViewKind | undefined, input: Record<string, unknown>, conversation?: string) => Promise<DraftView | undefined>;
  views: Partial<Record<ViewKind, (i: MailInput, draft?: Omit<MailView, "action">) => MailView | undefined>>; // how each row's `view` reads its call
  // The background mail handler (handler.ts): present when a handler can run with these tools. `handlerTask` is its standing task for `who` in the names of these
  // tools (mailtask.ts), `createdDraft` names the reply draft a successful call left behind (to be shown to the person), absent when drafts are not shown.
  handlerTask?: (who: string) => string;
  createdDraft?: (tool: string, response: unknown) => string | number | undefined;
}

// What the rest of the code needs from the mail provider, so that it never asks for the provider by name. One module of slot "mail" is loaded (settings.mailProvider);
// MAIL_PROVIDER=none loads none and every mail path asks `settings.mail` before it asks for the slot.
export interface MailSlot extends MailTools {
  // How the daily brief reaches the owner with this provider's tools, as a sentence for the heartbeat instruction (the daily-brief skill's delivery step).
  brief: { how: () => string };
  chat: { skill: string; note: (owner: string) => string }; // the chat prompt: the mail skill it names, and what it says about drafts and sending
}

// The code behind a mail slot (runtime.ts): the client, putting a mail back, what to start while the app runs, the doctor check.
export interface MailRuntime {
  source: () => MailSource & { connect?: () => Promise<void> }; // a mail client for the provider (the friends' mail check has its own)
  restore: (id: string) => Promise<number>; // `npm run restore <id>`: put an archived mail back in the inbox; prints what happened, returns the exit code
  start: (io: { reply: (text: string) => Promise<number> }) => { propose?: ReturnType<typeof createProposer>["show"] }; // Mailbird's connection and the proposer that shows reply drafts; Gmail's read-backs
  check: (line: DoctorLine) => void | Promise<void>;
}

// ---- the module ----

export interface ToolModule {
  name: string; // the module's name, also the key of its code in runtime.ts; for the mail slot, the value of MAIL_PROVIDER
  slot?: "mail"; // one module per slot is loaded, the one settings names; every module without a slot is always loaded
  connection: Connection;
  rows: readonly ToolEntry[];
  free?: true | readonly string[]; // rows that run without the judge: all of the module's, or those with these actions (a read, the assistant's own plumbing)
  freeWhen?: Readonly<Record<string, (input: Record<string, unknown>, source: Source) => boolean>>; // a call of this action that is free though the action is not (the Gmail brief to the owner's own address)
  untrusted?: true | readonly string[]; // reading these shows the run text a third party wrote (mail, a web page): after one, the run's arguments may be steered. Default: the module's `read` rows (every data kind is someone's text) unless `trusted`
  trusted?: true; // opt OUT of the default: its reads show nothing a third party wrote (public weather data)
  untrustedPrefix?: string; // an unlisted tool with a read verb under this prefix counts as untrusted too
  never?: true; // every tool of the connector (its prefix) is never allowed, for everyone (the trading connector)
  ownerOnly?: true | readonly string[]; // all rows, or the rows with these actions, belong to the owner alone: never in the tool set of a group or a tenant (capabilities.ts)
  floor?: ModuleFloor;
  titles?: Readonly<Record<string, CallTitle>>; // by tool name
  skills?: readonly ModuleSkill[];
  setup?: readonly SetupNeed[];
  hide?: ModuleHide; // what the model sees of a connector: tools beyond the visible ones are hidden (policy.ts hiddenTools)
  known?: readonly string[]; // the connector's full tool names as of writing (toolsseen.ts seeds the hiding with them, so even the very first run is trimmed)
  mail?: MailSlot; // slot "mail" only
  mailTools?: MailTools; // a module that is no mail provider but has tools that send mail (a friend's Google): how its sends are shown and read back
}

// The tools of a module's connector the model sees. `visible`: the default list, the module's own data; the setting <MODULE>_TOOLS (the module's name in capitals) replaces it
// (settings.ts visibleTools), checked against `valid`. Every other tool of the connector is hidden by name, and the whole connector while the module is not loaded.
export interface ModuleHide {
  prefix: string; // the connector's tool-name prefix: mcp__<server>__
  visible: readonly string[]; // tool names without the prefix
  valid: RegExp; // what a tool name of this connector looks like (the setting is checked against it)
  hint: string; // for the message when it does not
}

// The visible-tools overrides by module name (settings.visibleTools): a module not named here uses its own default.
export type HideConfig = Readonly<Record<string, readonly string[]>>;
