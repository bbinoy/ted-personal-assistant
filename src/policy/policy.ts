import type { Source } from "../audit.ts";
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isInside, realish } from "../contain.ts";
import { isNotePath } from "../notes.ts";
import { settings } from "../settings.ts";
import { groupTools } from "./capabilities.ts";
import { loaded, registered } from "../modules/index.ts";
import type { Denial, HideConfig, ToolModule } from "../modules/types.ts";
import { confirmedArguments, destinationIsTrashOrSpam, namesLocalFile, neverActionValue } from "./neverallowed.ts";
import { isPeopleKey } from "./guests.ts";
import { availableFor, confirmDeleteOf, confirmsDelete, entryFor, isFree, isReadTool, moduleOf, neverAllowedTool } from "./toolmanifest.ts";

// Permissions as code. Every tool call any agent run wants to make passes classify():
//   allow - run it
//   ask   - the owner approves or declines on their phone
//   deny  - never, whatever anyone says
// The same for every tool in every place, ONE fold (classify below): a tool that does not exist for this source or this capability set is denied; the
// never-allowed set is denied; so are local files; a free tool (a read, the assistant's own plumbing: toolmanifest.ts isFree) is allowed; anything else is
// "ask", and permissions.ts lets the approval judge skip the question where code allows it. A module's floor can only lower the result.
// Unknown tools default to "ask", never to "allow".

export type Verdict = "allow" | "ask" | "deny";

const RANK: Record<Verdict, number> = { deny: 0, ask: 1, allow: 2 };
const lower = (a: Verdict, b: Verdict | undefined): Verdict => (b && RANK[b] < RANK[a] ? b : a);

// Never allowed, whoever asks: trading, trash, permanent delete, spam, blocking a sender. By the tool (its row's action, its connector, its name: toolmanifest.ts
// neverAllowedTool) or by the call's arguments (a TRASH or SPAM label, spam: true, a page to the bin, an action that deletes: neverallowed.ts).
// The one exception: the arguments its module declares confirmable on that very tool (a Notion page to the bin, a friend's manage_event delete): a delete the person confirms (toolmanifest.ts confirmsDelete).
export function isNeverAllowed(tool: string, input: Record<string, unknown> = {}): boolean {
  const c = confirmedArguments(tool, input, confirmDeleteOf(tool));
  return neverAllowedTool(tool) || destinationIsTrashOrSpam(input, c.flags) || neverActionValue(input, c.actions);
}

// What a denied call is recorded and answered with, if a tool module has something more to say than "blocked by policy" (permissions.ts).
export function denial(tool: string, input: Record<string, unknown>): Denial | undefined {
  for (const m of registered()) {
    const d = m.floor?.onDeny?.(tool, input);
    if (d) return d;
  }
  return undefined;
}

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
// invitation and intake tickets, and the browse worker's page views left on disk (state/browse: pages are untrusted text, and a chat that could read them would
// hand them to the model). The tenants' folders are outside the three above anyway; this is the second lock. The host's admin is not blind:
// these are files on the owner's Mac (docs/SAFETY.md), the lock is for the assistant, not against the machine's owner.
const hiddenData = (): string[] => [settings.tenantsDir, join(settings.stateDir, "openbao"), join(settings.stateDir, "invites.json"), join(settings.stateDir, "intake.json"), join(settings.stateDir, "browse")];
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
// its tools 21k. Hidden: the connectors in HIDDEN_CONNECTORS (except the one of the loaded mail module), the connector of a mail module that is not loaded, every connector
// tool beyond the module's visible list (its `hide`; <MODULE>_TOOLS replaces the list), and anything the never-allowed set denies by its name (it could never run).
// The lists are settings (.env): a skill that needs a hidden tool fails, so keep them in step with your skills.

// Names come from the tools a run has seen (agent.ts records them), so a tool a connector
// adds later is hidden from the run after the one that first saw it.
export function hiddenTools(seen: readonly string[], cfg: { hiddenConnectors: readonly string[]; visibleTools: HideConfig; mailProvider?: string } = settings): string[] {
  const hiding = registered().filter((m) => m.hide);
  const server = (m: ToolModule) => m.hide!.prefix.replace(/__$/, ""); // the connector's server name, as HIDDEN_CONNECTORS writes it
  const inUse = new Set(hiding.filter((m) => loaded(cfg.mailProvider).includes(m)).map(server));
  const unused = hiding.filter((m) => !loaded(cfg.mailProvider).includes(m)).map(server);
  const keeps = hiding.map((m) => ({ prefix: m.hide!.prefix, keep: new Set(cfg.visibleTools[m.name] ?? m.hide!.visible) }));
  const extra = seen.filter((t) => keeps.some((k) => t.startsWith(k.prefix) && !k.keep.has(t.slice(k.prefix.length))) || neverAllowedTool(t));
  return [...new Set([...cfg.hiddenConnectors.filter((c) => !inUse.has(c)), ...unused, ...extra])];
}

// The web. Pages and search results are untrusted content, like mail, and a fetched URL can carry data out in its query
// string. A search is free; opening a page is judged, and the address veto is autojudge.ts. A group or a tenant never opens a page.

// groupNotesDir: for an isolated run (a group, a tenant), THE one folder its file tools may touch (its own notes). Without it an isolated run gets no file access.
// tools: the tools that exist for an isolated conversation (a group, a tenant), from its capability set (capabilities.ts); a group's own by default.
// A tool outside it is denied, whatever it is called.
//
// ONE fold for every source (owner, group, tenant, unattended): each step can only lower the verdict.
//   1. it exists here: the capability set of an isolated run, and `only` of the row
//   2. never allowed (trading, trash, delete, spam, block: by row, by name, by arguments) and no local files: deny
//   3. the manifest: free (a read, the assistant's own plumbing, a call a module declares free) is allow, everything else ask
//   4. every module's floor, the minimum (a friend's Google: no attachments; Gmail: attachment content, archive log-only)
//   5. the note file tools: only on a path inside the notes (a group's: inside that group's notes folder; the owner's chat: or, for Read, the data folders)
// What an isolated run holds and the owner does not is the capability set in 1; there is no second rule for it.
export function classify(tool: string, input: Record<string, unknown>, source: Source, groupNotesDir?: string, tools?: ReadonlySet<string>): Verdict {
  const isolated = source === "group" || tools !== undefined;
  const offered = tools ?? (isolated ? groupTools() : undefined);
  if (offered && !offered.has(tool)) return "deny";
  if (!availableFor(tool, source)) return "deny";
  if (isNeverAllowed(tool, input) || namesLocalFile(input)) return "deny";
  let verdict: Verdict = !confirmsDelete(tool, input) && isFree(tool, undefined, { input, source }) ? "allow" : "ask"; // a delete the person confirms is never free
  for (const m of registered()) verdict = lower(verdict, m.floor?.verdict?.(tool, input, source)); // every registered module's, loaded or not: they only restrict
  if (NOTE_FILE_TOOLS.has(tool)) {
    const ok = isolated ? !!groupNotesDir && isInside(input.file_path, groupNotesDir) : isNotePath(input.file_path) || (tool === "Read" && isReadableData(input.file_path));
    if (!ok) return "deny";
  }
  return verdict;
}

// --- "yes, but make it 16:00": consent with a small edit, applied without re-asking ---

// Only low-risk, non-sending tools may be edited-and-approved in one reply: calendar events.
// Everything else (send, forward, share...) goes back through a fresh approval.
// Fields that decide who is affected (guests.ts isPeopleKey: every field that names people) and which calendar. Never changeable through a chat reply.
const PROTECTED_FIELD = (field: string): boolean => isPeopleKey(field) || /^calendar_?id$/i.test(field);

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
  if (!isModifiable(tool) || confirmsDelete(tool, input) || changes.length === 0 || changes.length > 4) return undefined;
  const patched = { ...input };
  for (const { field, value } of changes) {
    if (!Object.hasOwn(input, field)) return undefined; // no new fields
    if (PROTECTED_FIELD(field)) return undefined;
    if (typeof input[field] !== "string" || typeof value !== "string" || value.length > 200) return undefined;
    patched[field] = value;
  }
  return patched;
}
