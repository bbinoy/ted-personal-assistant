import type { Source } from "./audit.ts";
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isInside, realish } from "./contain.ts";
import { isNotePath } from "./notes.ts";
import { settings } from "./settings.ts";
import { groupTools } from "./capabilities.ts";
import { registered } from "./modules/index.ts";
import type { Denial, HideConfig } from "./modules/types.ts";
import { availableFor, entryFor, isFree, isReadTool, moduleOf } from "./toolmanifest.ts";

// Permissions as code. Every tool call any agent run wants to make passes classify():
//   allow - run it
//   ask   - the owner approves or declines on their phone
//   deny  - never, whatever anyone says
// The same for every tool in every place: a tool that does not exist for this source is denied; a free tool (a read, the assistant's own plumbing:
// toolmanifest.ts isFree) is allowed; anything else is "ask", and permissions.ts lets the approval judge skip the question where code allows it.
// Unknown tools default to "ask", never to "allow".

export type Verdict = "allow" | "ask" | "deny";

// A tool module's own hard rule for a tool of its, or undefined to let the manifest decide.
function floorVerdict(tool: string, input: Record<string, unknown>, source: Source): Verdict | undefined {
  for (const m of registered()) {
    const v = m.floor?.verdict?.(tool, input, source);
    if (v) return v;
  }
  return undefined;
}

// What a denied call is recorded and answered with, if a tool module has something more to say than "blocked by policy" (permissions.ts).
export function denial(tool: string, input: Record<string, unknown>): Denial | undefined {
  for (const m of registered()) {
    const d = m.floor?.onDeny?.(tool, input);
    if (d) return d;
  }
  return undefined;
}

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

// --- what the model never sees ---
// Every tool schema the model can see is re-sent on every model call, so hiding tools nobody
// uses is the biggest saving there is: Notion alone was ~58k tokens of a ~118k floor, one of
// its tools 21k. Hidden: the connectors in HIDDEN_CONNECTORS, Notion beyond NOTION_TOOLS, Mailbird beyond MAILBIRD_TOOLS (each module's `hide`), and
// anything policy denies for everyone anyway (it could never run). Both lists are settings
// (.env): a skill that needs a hidden tool fails, so keep them in step with your skills.

// Names come from the tools a run has seen (agent.ts records them), so a tool a connector
// adds later is hidden from the run after the one that first saw it.
export function hiddenTools(seen: readonly string[], cfg: HideConfig & { hiddenConnectors: readonly string[] } = settings): string[] {
  const keeps = registered().flatMap((m) => {
    const keep = m.hide?.keep(cfg); // undefined: the whole connector is hidden by prefix, or not in use
    return m.hide && keep ? [{ prefix: m.hide.prefix, keep: new Set(keep) }] : [];
  });
  const extra = seen.filter((t) => keeps.some((k) => t.startsWith(k.prefix) && !k.keep.has(t.slice(k.prefix.length))) || DENY.some((re) => re.test(t)));
  return [...cfg.hiddenConnectors, ...new Set(extra)];
}

// The web. Pages and search results are untrusted content, like mail, and a fetched URL can carry data out in its query
// string. A search is free; opening a page is judged, and the address veto is autojudge.ts. A group or a tenant never opens a page.

// groupNotesDir: for a group run, THE one folder its file tools may touch (its own notes). Without it a group
// gets no file access at all.
// tools: the tools that exist for an isolated conversation (a group, a tenant), from its capability set (capabilities.ts); a group's own by default.
// A tool outside it is denied, whatever it is called. Every tool in it is a free one, so the set decides and only the notes path is looked at here.
export function classify(tool: string, input: Record<string, unknown>, source: Source, groupNotesDir?: string, tools?: ReadonlySet<string>): Verdict {
  // A group chat holds other people: no private data, no pages. What it may use is its capability set: web search, the file tools inside that one
  // group's own notes folder, the memory tools (scoped to that group by the server, memory-tools.ts), send, voice, draw, weather, browse (a separate
  // run with no owner data, browse.ts, that asks in that group) and the intake link of a tenant (it holds no value).
  if (source === "group") {
    if (!(tools ?? groupTools()).has(tool)) return "deny";
    if (NOTE_FILE_TOOLS.has(tool)) return groupNotesDir && isInside(input.file_path, groupNotesDir) ? "allow" : "deny";
    return "allow";
  }
  if (DENY.some((re) => re.test(tool))) return "deny";
  if (LOCAL_FILE.test(JSON.stringify(input))) return "deny";
  // The tool modules' hard rules for their own tools, which a row cannot say (Gmail's sensitive labels, attachment content, archive log-only, the brief to
  // oneself: gmailrules.ts). Every registered module's, loaded or not: they only restrict, so a connector's tools stay as refused as they were.
  const floor = floorVerdict(tool, input, source);
  if (floor) return floor;
  // The note file tools are chat only (manifest) and only on a path inside the notes (or, for Read, the data folders): the path is code.
  if (NOTE_FILE_TOOLS.has(tool) && !(isNotePath(input.file_path) || (tool === "Read" && isReadableData(input.file_path)))) return "deny";
  if (!availableFor(tool, source)) return "deny";
  return isFree(tool) ? "allow" : "ask";
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
  const action = entryFor(tool)?.action;
  return !!action && !!moduleOf(tool)?.floor?.editable?.includes(action); // the calendar module's event writes
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
