import type { Source } from "./audit.ts";
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isInside, realish } from "./contain.ts";
import { gmailVerdict, GMAIL_PREFIX } from "./gmailrules.ts";
import { isNotePath } from "./notes.ts";
import { settings } from "./settings.ts";
import { TENANT_CONSENT_TOOL } from "./tenants.ts";
import { entryFor, flagFor, isReadTool } from "./toolmanifest.ts";

// Permissions as code. Every tool call any agent run wants to make passes classify():
//   allow - run it
//   ask   - the owner approves or declines on their phone
//   deny  - never, whatever anyone says
// A tool's manifest flag gives the verdict: no -> allow; auto and yes -> ask (auto: the judge may skip the question, permissions.ts).
// Unknown tools default to "ask", never to "allow".

export type Verdict = "allow" | "ask" | "deny";

// Hard blocks, checked first so nothing below can override them.
const DENY: RegExp[] = [
  /^mcp__claude_ai_Interactive_Brokers/, // a chat message must never be able to touch trading
  /__(trash|delete|untrash|mark_.*spam|unmark_.*spam|set_sender_blocked|unsubscribe)/i,
];

// No tool may reach local files. Mailbird's create_draft accepts file:// attachments, so an
// injected email could otherwise get ~/.ssh or .env attached to a draft. The agent never needs this.
const LOCAL_FILE = /file:\/\//i;

// Which tool needs which approval is the manifest (toolmanifest.ts); this file adds what a flag cannot say.
export { isReadTool };

// The owner's memory is the SDK's auto-memory: the chat agent keeps small notes in
// memory/notes/ with the built-in Read, Write and Edit tools, plus our forget_note. Those tools
// are allowed for chat ONLY on a path inside that folder (anywhere else is denied), and every
// change is announced on the phone with how to undo it (agent.ts), so a note planted by
// something the agent read is seen at once. Nothing unattended may touch them. Checked before
// any allow list, so adding them to one can never open them up.
const NOTE_FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
// The assistant's own data folders may be READ (never written) in chat, so the owner can ask what a
// voice message said, what happened to a mail, or what the assistant knows: logs/, state/ and
// memory/ (the notes, the last brief, recent pings). Symlinks are resolved first, so a link cannot
// lead out of them. The repo, .env and the rest of the disk stay out of reach.
// Not even for the owner's chat: the tenants' folders (their notes, history, sessions: the owner reads none of them through the assistant, which is
// what keeps one person's chat from becoming another's, tenants.ts), the secret store's folder (config, TLS key, audit log) and the files that hold
// invitation and intake tickets. The tenants' folders are outside the three above anyway; this is the second lock. The host's admin is not blind:
// these are files on the owner's Mac (docs/SAFETY.md), the lock is for the assistant, not against the machine's owner.
const hiddenData = (): string[] => [settings.tenantsDir, join(settings.stateDir, "openbao"), join(settings.stateDir, "invites.json"), join(settings.stateDir, "intake.json")];
const inside = (real: string, dir: string): boolean => real === dir || real.startsWith(dir + sep);

export function isReadableData(path: unknown, dirs: readonly string[] = [settings.logsDir, settings.stateDir, settings.memoryDir]): path is string {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return false;
  try {
    const real = realpathSync(resolve(path));
    if (hiddenData().some((h) => inside(real, resolve(h)) || inside(real, realish(h)))) return false;
    return dirs.some((d) => real.startsWith(realpathSync(d) + sep));
  } catch {
    return false; // missing file or folder
  }
}

const FORGET_NOTE = "mcp__memory__forget_note";
const SEARCH_LOGS = "mcp__memory__search_logs";
const UNDO_DREAM = "mcp__memory__undo_dream";

// --- what the model never sees ---
// Every tool schema the model can see is re-sent on every model call, so hiding tools nobody
// uses is the biggest saving there is: Notion alone was ~58k tokens of a ~118k floor, one of
// its tools 21k. Hidden: the connectors in HIDDEN_CONNECTORS, Notion beyond NOTION_TOOLS, Mailbird beyond MAILBIRD_TOOLS, and
// anything policy denies for everyone anyway (it could never run). Both lists are settings
// (.env): a skill that needs a hidden tool fails, so keep them in step with your skills.
const NOTION = "mcp__claude_ai_Notion__";
const MAILBIRD = "mcp__mailbird__";

// Names come from the tools a run has seen (agent.ts records them), so a tool a connector
// adds later is hidden from the run after the one that first saw it.
export function hiddenTools(
  seen: readonly string[],
  cfg: { hiddenConnectors: readonly string[]; notionTools: readonly string[]; mailbirdTools: readonly string[]; gmailTools?: readonly string[] } = settings,
): string[] {
  const notion = new Set(cfg.notionTools);
  const mail = new Set(cfg.mailbirdTools);
  const gmail = cfg.gmailTools ? new Set(cfg.gmailTools) : undefined; // undefined: the whole connector is hidden by prefix, or not in use
  const extra = seen.filter(
    (t) =>
      (t.startsWith(NOTION) && !notion.has(t.slice(NOTION.length))) ||
      (t.startsWith(MAILBIRD) && !mail.has(t.slice(MAILBIRD.length))) ||
      (gmail && t.startsWith(GMAIL_PREFIX) && !gmail.has(t.slice(GMAIL_PREFIX.length))) ||
      DENY.some((re) => re.test(t)),
  );
  return [...cfg.hiddenConnectors, ...new Set(extra)];
}

// The web. Pages and search results are untrusted content, like mail, and a fetched URL can carry data out in its query
// string. The manifest says who may search (chat, background) and who may open a page (and that the judge decides);
// the address veto is autojudge.ts. A group gets web search only (classify).
const WEB_SEARCH = "WebSearch";

// groupNotesDir: for a group run, THE one folder its file tools may touch (its own notes). Without it a group
// gets no file access at all.
// tenantTools: a tenant's run (tenants.ts) is a "group" run in every respect of isolation, with her own notes folder in `groupNotesDir`; only the
// tools in this set exist for her (toolsFor), whatever else the group rules below would allow. Undefined for a real group.
const WEATHER_TOOL = /^mcp__weather__(search_places|get_forecast|get_marine_forecast|get_spot_info|get_distance)$/; // public forecast and map data, read-only (weathertools.ts)
export function classify(tool: string, input: Record<string, unknown>, source: Source, groupNotesDir?: string, tenantTools?: ReadonlySet<string>): Verdict {
  // A group chat holds other people: no private data, no pages. Web search, the file tools inside that one
  // group's own notes folder, and the memory tools (scoped to that group by the server, memory-tools.ts).
  if (source === "group") {
    if (tenantTools && !tenantTools.has(tool)) return "deny";
    if (NOTE_FILE_TOOLS.has(tool)) return groupNotesDir && isInside(input.file_path, groupNotesDir) ? "allow" : "deny";
    // The browse tool starts a separate run with no owner data (browse.ts); in a group the run asks in that group like the owner's chat does.
    if (tool === "mcp__browse__browse") return settings.browse ? "allow" : "deny";
    if (tool === "mcp__send__send" || tool === "mcp__voice__voice" || tool === "mcp__draw__draw" || WEATHER_TOOL.test(tool)) return "allow"; // draw: sanitised and rendered by code, kept for the turn (drawtool.ts)
    if (tenantTools && tool === TENANT_CONSENT_TOOL) return "allow"; // a tenant's one-time age and region confirmation (tenanttools.ts)
    return tool === WEB_SEARCH || tool === FORGET_NOTE || tool === SEARCH_LOGS || tool === UNDO_DREAM ? "allow" : "deny";
  }
  if (DENY.some((re) => re.test(tool))) return "deny";
  if (LOCAL_FILE.test(JSON.stringify(input))) return "deny";
  // Gmail's rules a flag cannot say: sensitive labels, attachment content, archive log-only, the brief to oneself (gmailrules.ts).
  const gm = settings.mailProvider === "gmail";
  const g = gmailVerdict(tool, input, source, { archiveLive: gm && settings.gmailArchiveLive, self: gm ? settings.mailSelfAddress : undefined, briefEmail: gm && settings.briefEmail });
  if (g) return g;
  // The note file tools are chat only (manifest) and only on a path inside the notes (or, for Read, the data folders): the path is code.
  if (NOTE_FILE_TOOLS.has(tool) && !(isNotePath(input.file_path) || (tool === "Read" && isReadableData(input.file_path)))) return "deny";
  const flag = flagFor(tool, source);
  return flag === undefined ? "deny" : flag === "no" ? "allow" : "ask";
}

// --- "yes, but make it 16:00": consent with a small edit, applied without re-asking ---

// Only low-risk, non-sending tools may be edited-and-approved in one reply: calendar events.
// Everything else (send, forward, share...) goes back through a fresh approval.
// Fields that decide who is affected. Never changeable through a chat reply.
const PROTECTED_FIELD = /^(to|cc|bcc|attendees?|recipients?|emails?|calendarId|guests?)$/i;

export interface Change {
  field: string;
  value: string;
}

export function isModifiable(tool: string): boolean {
  return entryFor(tool)?.action === "calendar-write";
}

// Returns the patched input, or undefined if the patch is not acceptable
// (the caller then falls back to the normal deny-with-feedback path).
export function applyChanges(
  tool: string,
  input: Record<string, unknown>,
  changes: Change[],
): Record<string, unknown> | undefined {
  if (!isModifiable(tool) || changes.length === 0 || changes.length > 4) return undefined;
  const patched = { ...input };
  for (const { field, value } of changes) {
    if (!Object.hasOwn(input, field)) return undefined; // no new fields
    if (PROTECTED_FIELD.test(field)) return undefined;
    if (typeof input[field] !== "string" || typeof value !== "string" || value.length > 200) return undefined;
    patched[field] = value;
  }
  return patched;
}
