import type { Source } from "../audit.ts";
import type { MailView } from "./mailview.ts";
import { loaded, registered } from "../modules/index.ts";
import type { CallTitle, MailTools, ToolEntry, ToolModule, ViewKind } from "../modules/types.ts";
import { confirmedArguments, DELETE_CONFIRM, NEVER_ACTIONS, nameIsNever } from "./neverallowed.ts";
import { settings } from "../settings.ts";

// THE tool manifest: every tool the model might get declares here what it is, so one rule applies the same way across mail providers and other tools.
// policy.ts, autojudge.ts, permissions.ts, capabilities.ts and format.ts read this table; none keeps a tool list of its own. The table is the union of the
// rows of the LOADED tool modules (src/modules, one file per tool): every module without a slot, and in the `mail` slot the one MAIL_PROVIDER names.
//
// A row says WHAT a tool is (provider, action), which capability gates it (`cap`), where it exists at all (`only`) and how a mail call is read (`view`).
// It does not say who may use it or whether the owner is asked: that is one path for every tool in every place (chat, group, tenant, mail handler,
// brief, radar, wake-up, browse), in permissions.ts: the code floor (policy.ts: the never-allowed set and the capability set of a group or a tenant;
// autojudge.ts: what may never be judged), then the approval judge (approvaljudge.ts), then the question on the owner's phone. The one thing a
// module decides about its rows is whether they are `free` (isFree below): a plain read or the assistant's own plumbing runs without the judge, everything
// else is judged.
// `only` limits a tool to some sources and is used for two things: the browse sub-run's browser, and the tools that need a conversation to exist in
// (send, draw, voice, the notes). Anywhere else such a tool is denied outright (policy.ts classify).
// `cap` is the capability that gates the tool (tenants.ts CAPABILITIES). A group or a tenant is offered the tool only when its capability set holds
// that capability (capabilities.ts) and `only` names "group" or does not limit the sources. The default is the module's capability.
// The never-allowed set is declared HERE, by the rows: an action in NEVER_ACTIONS (trash, delete, spam, block, trade; neverallowed.ts) or a module marked
// `never`; neverAllowedTool below is the one question policy.ts, the hidden tools and mayFix ask. Not here, on purpose: which tools a group or tenant has at all
// (its capability set, capabilities.ts). A tool no module lists is unknown: it asks, is never free and never judged (a name that says delete, trash,
// spam or block is denied, neverallowed.ts).

export type { ToolEntry, ViewKind } from "../modules/types.ts";
export { addrs, type MailAction, type MailView } from "./mailview.ts";

export type MailProvider = "none" | "mailbird" | "gmail";

// The rows of the loaded modules (the manifest), and every row of every module in the code, loaded or not (tests, docs: a mail provider that is not the active one).
export const manifest = (mail: MailProvider = settings.mailProvider): readonly ToolEntry[] => loaded(mail).flatMap((m) => m.rows);
export const allRows = (): readonly ToolEntry[] => registered().flatMap((m) => m.rows);

interface Found {
  entry: ToolEntry;
  module: ToolModule;
}
const cache = new Map<MailProvider, Map<string, Found>>();
function lookup(tool: string, mail: MailProvider): Found | undefined {
  let m = cache.get(mail);
  if (!m) cache.set(mail, (m = new Map(loaded(mail).flatMap((module) => module.rows.map((entry): [string, Found] => [entry.tool, { entry, module }])))));
  return m.get(tool);
}

// Every row of every module in the code, loaded or not, for what only restricts: the never-allowed set holds for the mail provider that is not the active one.
let anyCache: Map<string, Found> | undefined;
const anyRow = (tool: string): Found | undefined => (anyCache ??= new Map(registered().flatMap((module) => module.rows.map((entry): [string, Found] => [entry.tool, { entry, module }])))).get(tool);

// Never allowed, by the tool's name alone (the arguments are policy.ts isNeverAllowed): its row says trash, delete, spam, block or trade, its module is the trading
// connector (any tool under its prefix), or, for a tool no module lists, its name says so.
export function neverAllowedTool(tool: string): boolean {
  const f = anyRow(tool);
  if (f) return NEVER_ACTIONS.has(f.entry.action) || !!f.module.never;
  if (registered().some((m) => m.never && m.connection.kind === "connector" && tool.startsWith(m.connection.prefix))) return true;
  return nameIsNever(tool);
}

export const entryFor = (tool: string, mail: MailProvider = settings.mailProvider): ToolEntry | undefined => lookup(tool, mail)?.entry;
// The loaded module that lists the tool.
export const moduleOf = (tool: string, mail: MailProvider = settings.mailProvider): ToolModule | undefined => lookup(tool, mail)?.module;

// How an approval question titles a generically shown call (format.ts): the title a module gives the tool. Every module in the code counts, loaded or not.
export const titleOf = (tool: string, input?: Record<string, unknown>): CallTitle | undefined => {
  const t = registered().find((m) => m.titles?.[tool])?.titles?.[tool];
  return t?.whenDeleting && input && confirmsDelete(tool, input) ? { icon: "🗑️", title: t.whenDeleting, labels: t.labels } : t;
};

// A delete the person confirms (neverallowed.ts DELETE_CONFIRM): the tool's row says so (a draft, a calendar event), or the call uses an argument its module declares
// confirmable on that tool (Notion's in_trash, manage_event with action delete). Never judged, never fixed, never free; classify asks on the conversation's own phone.
export const confirmDeleteOf = (tool: string) => anyRow(tool)?.module.floor?.confirmDelete;
export const confirmsDelete = (tool: string, input: Record<string, unknown> = {}): boolean =>
  anyRow(tool)?.entry.action === DELETE_CONFIRM || confirmedArguments(tool, input, confirmDeleteOf(tool)).hit;

// Read verbs, matched against the tool's own name (after the server name), ignoring a "notion-" style prefix: both
// "get_message" and "notion-fetch" are reads. Used only to mark text as untrusted and to tell a read for the audit and the no-repeat rule; it never makes a tool free.
const READ_VERB = /^(list|get|search|read|query|fetch|summarize|suggest|whats|download|show|ai-search)/i;
const readVerb = (tool: string) => READ_VERB.test((tool.split("__").pop() ?? "").replace(/^notion-/i, ""));

export const actionOf = (tool: string, mail?: MailProvider): string => entryFor(tool, mail)?.action ?? (readVerb(tool) ? "read" : "unknown");
export const isReadTool = (tool: string): boolean => actionOf(tool) === "read";

// Does this tool exist for this source at all? (`only`.) A tool the manifest does not know exists everywhere; classify asks about it.
export function availableFor(tool: string, source: Source, mail?: MailProvider): boolean {
  const e = entryFor(tool, mail);
  return !e || !e.only || e.only.includes(source);
}

// A module's `free`, `untrusted` and `ownerOnly` say "all my rows" (true) or "the rows with these actions".
const covers = (set: true | readonly string[] | undefined, action: string): boolean => set === true || !!set?.includes(action);

// Free: the call runs without the judge and without a question, because it changes nothing of the owner's and sends nothing out: a read, and the
// assistant's own plumbing (its notes, memory, skills, the conversation's own send, draw and voice, the browser's reads), and a call of an action that a module
// declares free for that call (`freeWhen`: the brief to the owner's own address; it needs the call, hence `call`). Everything else is not free: it is judged
// (autojudge.ts) or asked. A tool the manifest does not know is never free, whatever its name says (the read-verb heuristic above is for untrusted marking
// only). Which PATH a note tool may touch is code (policy.ts classify).
export function isFree(tool: string, mail: MailProvider = settings.mailProvider, call?: { input: Record<string, unknown>; source: Source }): boolean {
  const f = lookup(tool, mail);
  if (!f) return false;
  return covers(f.module.free, f.entry.action) || (!!call && !!f.module.freeWhen?.[f.entry.action]?.(call.input, call.source));
}

// Reading these shows the run text a third party wrote: mail, a web page, a search result, and any other data kind (an event's description, a Notion page, a
// Drive file are written by whoever can edit them): every `read` row is untrusted unless its module opts out (`trusted`: public weather data). After one, the
// run's arguments may be steered by it (permissions.ts tells the judge). A mail provider's reads only count while that provider is loaded; an unlisted tool
// with a read verb under a connector's prefix counts too, loaded or not (it can only make the judge more careful), and so does anything in the browse run.
export function readsUntrusted(tool: string, mail: MailProvider = settings.mailProvider): boolean {
  const f = lookup(tool, mail);
  if (!f) return readVerb(tool) && registered().some((m) => m.untrustedPrefix !== undefined && tool.startsWith(m.untrustedPrefix));
  return covers(f.module.untrusted ?? (f.module.trusted ? undefined : ["read"]), f.entry.action);
}

// Rows that belong to the owner alone (the connectors, the tenant administration, the browser, opening a page): never in a group's or a tenant's tool set.
export const isOwnerOnly = (tool: string): boolean => {
  const f = anyRow(tool);
  return !!f && (covers(f.module.ownerOnly, f.entry.action) || f.module.connection.kind === "connector");
};

// Pure. The tool's call as one view: send, reply, forward or draft, with bcc and attachments always in it, read by the mail module that lists the tool.
// Undefined for a tool that is not a mail tool of the loaded provider, or a call that cannot be read (a send of a draft nobody read back).
export function mailView(tool: string, input: Record<string, unknown>, draft?: Omit<MailView, "action">, mail: MailProvider = settings.mailProvider): MailView | undefined {
  const f = lookup(tool, mail);
  const kind: ViewKind | undefined = f?.entry.view;
  return kind ? (f!.module.mail ?? f!.module.mailTools)?.views[kind]?.(input, draft) : undefined;
}

// How the module that lists a mail-sending tool reads its sends back (permissions.ts): the mail provider's own, or a friend's Google module's. Undefined: the tool has none.
export const mailToolsOf = (tool: string, mail: MailProvider = settings.mailProvider): MailTools | undefined => {
  const m = lookup(tool, mail)?.module;
  return m && (m.mail ?? m.mailTools);
};

// Does this call make something new whose id comes back in its result (a draft, an event, a page)? created.ts keeps those ids per conversation for the judge.
export const createsOf = (tool: string, input: Record<string, unknown>): boolean => !!anyRow(tool)?.module.floor?.creates?.(tool.split("__").pop() ?? tool, input);
