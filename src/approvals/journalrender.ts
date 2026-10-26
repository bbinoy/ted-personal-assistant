import { emit, type Why } from "../core/events.ts";
import type { Source } from "../core/audit.ts";
import { isTenantKey, OWNER_KEY } from "../core/ownerkey.ts";
import { clip } from "../core/sanitize.ts";
import { systemZone, timeIn } from "../core/timezone.ts";
import { archivedBy } from "../modules/archivecap.ts";
import { entryFor, isReadTool, mailView, titleOf } from "../policy/toolmanifest.ts";
import { resultText } from "../modules/browse/browseguard.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { callLabel, createdLabel, idsInCall, idsInResult } from "./created.ts";
import type { RunProvenance } from "./autojudge.ts";
import { scopeOf } from "./turnscope.ts";

// What the journal says about an action, written by code (core/sinks/journalsink.ts writes the line): WHAT was done (named by the object, not only its id), WHY (first from what code knows:
// the person's message and when, the approval they answered, the judge's verdict, the run's standing instruction), and how to UNDO it where there is a way. The model's own reason is never
// taken from its prose: only a structured field of the call itself (`reason` / `why`) can carry it, cleaned and one line.

// ---- which calls are actions ----

// Plumbing that is no action worth a line: sending into the chat is the conversation itself, seen-mail is bookkeeping, a status note is the brief's own state, a drawing or a voice is sent as a message.
const NOT_ACTIONS = new Set(["send", "seenmail", "status", "draw", "voice", "weather"]);
const ACTIONS_OF: Readonly<Record<string, ReadonlySet<string>>> = { memory: new Set(["forget_note", "undo_dream"]), notes: new Set(["write_note"]) }; // (the rest of these servers read: search_logs, journal, read_note)
const NOTE_WRITES = new Set(["Write", "Edit"]);
// The SDK's own tools that are no action: a delegation is the expert's actions (each its own line), not an action itself; StructuredOutput is how a run hands in its answer; the to-do
// list and the tool search are its own bookkeeping. The one place: the journal and the look's count of what it did (look.ts) both ask it.
const NON_ACTIONS: ReadonlySet<string> = new Set(["Agent", "Task", "TodoWrite", "ToolSearch", "StructuredOutput"]);
export const isNonAction = (tool: string): boolean => NON_ACTIONS.has(tool);

// Pure: does a successful call of this tool belong in the journal? Never a read (a look-up, a search, the journal itself); never plumbing.
export function journalable(tool: string): boolean {
  if (isReadTool(tool)) return false;
  if (isNonAction(tool)) return false;
  const e = entryFor(tool);
  if (!e) return true; // a tool the manifest does not know is not a read (the verbs say so): an action
  if (e.provider === "builtin") return NOTE_WRITES.has(tool);
  const only = ACTIONS_OF[e.provider];
  if (only) return only.has(tool.split("__").pop() ?? tool);
  if (e.action === "skill" || e.action === "web-search" || e.action === "web-fetch" || e.action === "select") return false;
  return !NOT_ACTIONS.has(e.provider) && !(e.provider === "browse" && tool === "mcp__browse__browse"); // (the browse entry tool starts a run; its commit steps are the actions)
}

// Pure: the category a line is filed under (the journal tool's `kind`).
export function categoryOf(tool: string): string {
  const e = entryFor(tool);
  if (e?.action === "archive" || e?.action === "restore") return "archive";
  switch (e?.provider) {
    case "mailbird":
    case "gmail":
      return "mail";
    case "google":
      return e.cap === "calendar" ? "calendar" : "mail";
    case "calendar":
      return "calendar";
    case "notion":
      return "notion";
    case "drive":
    case "docs":
    case "claudedocs":
      return "drive";
    case "memory":
    case "notes":
    case "builtin":
      return "memory";
    case "tasks":
      return "task";
    case "browse":
      return "browse";
    default:
      return "other";
  }
}

// ---- the mail the run has seen, to name an archive ----

// An archive call carries only an id. The subject and sender of that mail are what the person recognises, so code remembers them from the results of the mail READS of this conversation (a list, a
// search, a get) for a day: every object in a result that has an id-like key and a subject. Only text the connector returned; never the model's words. In memory, per conversation, bounded.
const SEEN_TTL_MS = 24 * 3_600_000;
const MAX_SEEN = 600;
const seenMail = new Map<string, Map<string, { subject: string; from?: string; at: number }>>();
export const forgetSeenMail = (): void => seenMail.clear(); // tests

const ID_KEYS = ["conversationId", "conversation_id", "threadId", "thread_id", "messageId", "message_id", "id"];
const FROM_KEY = /^(?:last_?)?(?:from|sender)(?:_?name|_?email|_?address)?$/i; // (Mailbird's list rows say `lastSender`)
const textOf = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return textOf(o.name) ?? textOf(o.displayName) ?? textOf(o.email) ?? textOf(o.address);
  }
  return undefined;
};

export function rememberMail(conv: string, response: unknown, now = Date.now()): void {
  let root: unknown = response;
  const text = typeof response === "string" ? response : resultText(response);
  if (text) {
    try {
      root = JSON.parse(text);
    } catch {
      return; // (not JSON: a rendered list we cannot read ids from)
    }
  }
  const found: [string, { subject: string; from?: string }][] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== "object" || found.length > 200) return;
    if (Array.isArray(v)) return void v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const subject = textOf(o.subject);
    const id = ID_KEYS.map((k) => o[k]).find((x) => (typeof x === "string" && x) || typeof x === "number");
    if (subject && id !== undefined) found.push([String(id), { subject, from: Object.keys(o).filter((k) => FROM_KEY.test(k)).map((k) => textOf(o[k])).find(Boolean) }]);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(root, 0);
  if (!found.length) return;
  const m = seenMail.get(conv) ?? seenMail.set(conv, new Map()).get(conv)!;
  for (const [k, e] of m) if (now - e.at >= SEEN_TTL_MS) m.delete(k);
  for (const [id, e] of found) m.set(id, { ...e, at: now });
  while (m.size > MAX_SEEN) m.delete(m.keys().next().value!);
}
export const mailName = (conv: string, id: string): string | undefined => { // (shadow.ts names a proposed archive by it)
  const e = seenMail.get(conv)?.get(id);
  return e ? `“${clip(e.subject, 80)}”${e.from ? ` from ${clip(e.from, 50)}` : ""}` : undefined;
};

// ---- what ----

const VERBS: Record<string, string> = {
  create: "Created", add: "Added", update: "Updated", edit: "Edited", delete: "Deleted", remove: "Removed", send: "Sent", reply: "Replied", forward: "Forwarded", move: "Moved", share: "Shared",
  save: "Saved", write: "Wrote", archive: "Archived", label: "Labelled", unlabel: "Removed a label from", respond: "Responded to", trash: "Moved to the bin", copy: "Copied", upload: "Uploaded", duplicate: "Duplicated",
  restore: "Restored", discard: "Discarded", select: "Selected", show: "Showed", unsubscribe: "Unsubscribed from", set: "Set", mark: "Marked", cancel: "Cancelled", forget: "Forgot", undo: "Undid", stop: "Stopped",
  suspend: "Suspended", resume: "Resumed", invite: "Invited", register: "Registered",
};
const humanServer = (tool: string): string => {
  const m = /^mcp__(?:claude_ai_)?([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?)__/.exec(tool);
  return m ? m[1]!.replace(/_/g, " ") : "";
};

// Pure: "Created event in Google Calendar" from the tool's name or its approval title ("Delete calendar event" -> "Deleted calendar event").
export function doneVerb(tool: string, input: Record<string, unknown>): string {
  const title = titleOf(tool, input)?.title;
  const words = (title ?? (tool.split("__").pop() ?? tool).replace(/^notion-/, "").replace(/[_-]+/g, " ")).trim();
  const [first = "", ...rest] = words.split(/\s+/);
  const past = VERBS[first.toLowerCase()];
  const server = humanServer(tool);
  return past ? `${past}${rest.length ? ` ${rest.join(" ")}` : ""}${!title && server ? ` in ${server}` : ""}` : `Ran ${words}${server && !title ? ` in ${server}` : ""}`;
}

const list = (xs: readonly string[], more = 3): string => (xs.length <= more ? xs.join(", ") : `${xs.slice(0, more).join(", ")} and ${xs.length - more} more`);

export interface Rendered {
  what: string;
  cat: string;
  undo?: string;
}

// The object's name where code can read it: a mail the run has seen, or the title the assistant gave a thing it created here, or the title the call itself carries.
function named(conv: string, _tool: string, input: Record<string, unknown>): string | undefined {
  return createdLabel(conv, input) ?? callLabel(input);
}

// A task tool's line is what the store said about the change (the first line of the reply: "Added task #4 'Call Sam' (due Fri 24 Oct)"), written by code from the stored item; the undo is a sentence to say.
function renderTask(tool: string, response: unknown, cat: string): Rendered {
  const first = (typeof response === "string" ? response : resultText(response)).split("\n")[0]?.trim().replace(/\.$/, "") ?? "";
  const id = /#(\d+)/.exec(first)?.[1];
  const name = tool.split("__").pop() ?? tool;
  const undo = !id ? undefined : name === "add_task" || name === "confirm_suggestion" ? `say 'drop task #${id}'` : name === "complete_task" || name === "drop_task" || name === "snooze_task" || name === "reject_suggestion" ? `say 'reopen task #${id}'` : undefined;
  return { what: first || doneVerb(tool, {}), cat, ...(undo ? { undo } : {}) };
}

export function render(conv: string, tool: string, input: Record<string, unknown>, response?: unknown): Rendered {
  const cat = categoryOf(tool);
  const archived = archivedBy(tool, input);
  if (archived) {
    const ids = archived.filter(Boolean);
    const names = ids.map((id) => mailName(conv, id) ?? `mail ${id}`);
    // (every id is in the undo, so the archive list of the brief can restore each one: journalread.ts archiveItems reads them back)
    return { what: `Archived ${ids.length ? list(names) : "a mail"}`, cat, undo: ids.length === 1 ? `npm run restore ${ids[0]}, or say 'restore that'` : ids.length ? `npm run restore <id> for each of ${ids.join(" ")}, or say 'restore that'` : "say 'restore that'" };
  }
  const e = entryFor(tool);
  if (e?.action === "restore") {
    const ids = idsInCall(input);
    return { what: `Put ${ids.length ? list(ids.map((id) => mailName(conv, id) ?? `mail ${id}`)) : "a mail"} back in the inbox`, cat };
  }
  if (NOTE_WRITES.has(tool)) {
    const file = typeof input.file_path === "string" ? input.file_path.split("/").pop() : undefined;
    return { what: `${tool === "Write" ? "Wrote" : "Edited"} the note ${file ?? "(unnamed)"}`, cat, undo: file ? `say 'forget ${file}'` : undefined };
  }
  if (e?.provider === "tasks") return renderTask(tool, response, cat);
  if (tool.endsWith("__forget_note")) return { what: `Forgot the note ${String(input.file ?? "").slice(0, 80)}`, cat };
  if (tool.endsWith("__write_note")) return { what: `Saved the inferred note ${String(input.file ?? "").slice(0, 80)}`, cat, undo: `say 'forget ${String(input.file ?? "").slice(0, 80)}'` };
  if (tool.endsWith("__undo_dream")) return { what: "Put the notes back as they were before the dream", cat };
  const view = e?.view ? mailView(tool, input) : undefined;
  if (view) {
    const verb = { send: "Sent", reply: "Replied", forward: "Forwarded", draft: "Saved a draft" }[view.action];
    return { what: `${verb}${view.subject ? ` “${clip(view.subject, 100)}”` : ""}${view.to.length ? ` to ${list(view.to.map((a) => clip(a, 60)), 3)}` : ""}`, cat };
  }
  const label = named(conv, tool, input);
  const ids = idsInCall(input);
  const what = `${doneVerb(tool, input)}${label ? `: ${label}` : ids.length ? ` (${list(ids, 2)})` : ""}`;
  const made = e?.action === "calendar-write" && /create/.test(tool) ? idsInResult(response)[0] : undefined;
  return { what, cat, ...(made ? { undo: `delete that event (event id ${made})` } : {}) };
}

// ---- why ----

const hhmm = (conv: string, at: number): string => timeIn(new Date(at), isTenantKey(conv) ? zoneOf({ tenantId: conv.slice("tenant:".length) }) : systemZone());

// The structured reason a call itself carries (`reason` or `why` as a string argument): the model's own, so one clean line, never more than a sentence.
export function ownReasonOf(input: Record<string, unknown>): string | undefined {
  const r = input.reason ?? input.why;
  return typeof r === "string" && r.trim() ? clip(r, 160) : undefined;
}

export interface WhyInput {
  conv: string;
  step: "allow" | "auto-approved" | "approved" | "executed";
  input: Record<string, unknown>;
  provenance?: RunProvenance;
  judge?: string; // the judge's reason (auto-approved)
  approval?: { n: number }; // the approval inbox's number the person answered yes to
  asked?: boolean;
  notes?: readonly { file: string; inferred: boolean }[]; // the notes the run had read before this call, in order
  now?: number;
}

// Pure: "per your notes: triage-linkedin, triage-newsletters (inferred) and 2 more" from the notes a run had read (at most 3 names); empty when it read none.
export function notesText(notes: readonly { file: string; inferred: boolean }[] | undefined): string {
  if (!notes?.length) return "";
  const names = notes.slice(0, 3).map((n) => `${n.file}${n.inferred ? " (inferred)" : ""}`);
  return `per your notes: ${names.join(", ")}${notes.length > 3 ? ` and ${notes.length - 3} more` : ""}`;
}

// Pure but for the turn scope's clock: the why of a call. First what code knows: the approval they answered, else whose words or which instruction started the run.
export function whyOf(o: WhyInput): Why {
  try {
    return whyOfUnsafe(o);
  } catch (e) {
    console.error(`journal: could not work out why (${(e as Error)?.name ?? "error"})`); // (a bad time zone must never fail the permission decision it is part of)
    return { text: "no reason was recorded for this call" };
  }
}
function whyOfUnsafe(o: WhyInput): Why {
  const at = scopeOf(o.conv).lastSaidAt();
  const p = o.provenance;
  const base =
    o.approval ? `approval #${o.approval.n}, you answered yes`
    : p?.kind === "owner" ? `your message${at ? ` at ${hhmm(o.conv, at)}` : ""}`
    : p?.kind === "member" ? (isTenantKey(o.conv) ? `your message${at ? ` at ${hhmm(o.conv, at)}` : ""}` : `a message in this group${at ? ` at ${hhmm(o.conv, at)}` : ""}`)
    : p?.kind === "standing" ? "a periodic look at your accounts, on its standing instructions"
    : p?.kind === "derived" ? (p.by === "gate" ? "a standing task chosen for this moment" : "a task I wrote for my helper from your message")
    : "no reason was recorded";
  const how = o.step === "auto-approved" ? `auto-approved by the safety check${o.judge ? ` (${clip(o.judge, 100)})` : ""}` : o.step === "approved" && !o.approval ? "you approved it when asked" : "";
  const reason = ownReasonOf(o.input);
  return { text: [base, how, notesText(o.notes)].filter(Boolean).join("; "), ...(reason ? { reason } : {}), ...(o.asked || o.step !== "allow" ? { asked: true } : {}) };
}

// ---- the success ----

// A tool call succeeded (run/agentrun.ts afterTool): tell the event stream. Never throws: the journal is a record, the run goes on.
export async function noteDone(o: { conv: string | undefined; run?: string; source: Source; tool: string; input: Record<string, unknown>; response?: unknown }): Promise<void> {
  const conv = o.conv ?? OWNER_KEY;
  try {
    if (isReadTool(o.tool)) {
      if (entryFor(o.tool)?.cap === "mail" || entryFor(o.tool)?.provider === "gmail" || entryFor(o.tool)?.provider === "mailbird") rememberMail(conv, o.response);
      return;
    }
    if (!journalable(o.tool)) return;
    emit({ type: "done", conv, ...(o.run ? { run: o.run } : {}), tool: o.tool, source: o.source, input: o.input, ...render(conv, o.tool, o.input, o.response) });
  } catch (e) {
    console.error(`journal: could not record ${o.tool} (${(e as Error)?.message ?? "error"})`);
  }
}
