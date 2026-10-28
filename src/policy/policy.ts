import type { RunKind } from "../core/runkind.ts";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isInside, realish } from "../core/contain.ts";
import { NOTES_DIR, withinCaps } from "../memory/notes.ts";
import { settings } from "../core/settings.ts";
import { convPaths, conversationsDir, instancePaths, logPaths, OWNER_CONV } from "../core/convpaths.ts";
import { browseTools, runCapabilities, toolsFor } from "./capabilities.ts";
import { loaded, registered } from "../modules/index.ts";
import type { Denial, HideConfig, ToolModule } from "../modules/types.ts";
import { confirmedArguments, destinationIsTrashOrSpam, namesLocalFile, neverActionValue } from "./neverallowed.ts";
import { isPeopleKey } from "./guests.ts";
import { availableFor, confirmDeleteOf, confirmsDelete, entryFor, isFree, isReadTool, moduleOf, neverAllowedTool } from "./toolmanifest.ts";

// Permissions as code. Every tool call any agent run wants to make passes classify():
//   allow - run it
//   ask   - the owner approves or declines on their phone
//   deny  - never, whatever anyone says
// The same for every tool in every place, ONE fold (classify below): a tool that does not exist for this run (its conversation's capability set, attended or not) is denied; the
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

// Every conversation's memory is the SDK's auto-memory: every run, a chat turn or a look, keeps small notes in its notes folder with the built-in Read, Write and Edit tools, plus our forget_note.
// Those tools are allowed ONLY on a path inside that folder (anywhere else is denied), and the owner's chat announces every change on the phone with how to undo it (agent.ts),
// so a note planted by something the agent read is seen at once; a look's are in the journal. Checked before any allow list, so adding them to one can never open them up.
const NOTE_FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
// The owner's chat may READ (never write) a SHORT ALLOW-LIST of the assistant's own data with the built-in Read, so the owner can ask what a voice message
// said or what the assistant did: readableData() below (conversations/owner/notes/ incl. MEMORY.md; conversations/owner/messages.jsonl; logs/audit.jsonl, agent.log, signal-daemon.log).
// EVERYTHING ELSE under the data folder is unreadable by default (the rest of conversations/owner/ too: its session, notes-backup, search index, pending approvals), so a new store is private the
// day it is written. (It used to be the other way round, a deny-list, and it missed friends' voice-note snippets and cloned reference audio, the friends list with every friend's name
// and ACI, the intake table of instance.db, notes-backup/ with notes deleted by forget_note, and a database file with every friend's marks and spend, and every group's folder.)
// Reading the logs by SEARCH (search_logs, a tool with its own fixed folder) is not affected. Symlinks are resolved first, so a link cannot lead out of
// an allowed entry. The repo, .env and the rest of the disk stay out of reach.
// hiddenData is the second lock, kept on top of the allow-list: every other conversation's folder (a friend's and a group's notes, history, sessions: the owner reads none of them through the
// assistant, which is what keeps one person's chat from becoming another's, tenants.ts), the whole instance/ folder (the friends list, pending registrations, intake tickets, the browse
// worker's page views, the cost ledgers) and the installed software's folder (the secret store's config, TLS key and audit log). Those stay unreadable even if someone widens the allow-list.
// The host's admin is not blind: these are files on the owner's Mac (docs/SAFETY.md), the lock is for the assistant, not against the machine's owner.
const hiddenData = (): string[] => [instancePaths().dir, instancePaths().installed];
// Is this real path in a conversation folder that is not the owner's? (Judged by the first folder under conversations/, so a folder that does not exist yet is covered too.)
const inOtherConversation = (real: string): boolean =>
  [conversationsDir(), realish(conversationsDir())].some((root) => {
    const rel = relative(root, real);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== OWNER_CONV;
  });
// A folder (anything inside it) or a single file, exactly.
export const readableData = (): string[] => [convPaths(OWNER_CONV).notes, convPaths(OWNER_CONV).messages, logPaths().audit, logPaths().agent, logPaths().signalDaemon];
const inside = (real: string, dir: string): boolean => real === dir || real.startsWith(dir + sep);

export function isReadableData(path: unknown, allowed: readonly string[] = readableData()): path is string {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return false;
  try {
    const real = realpathSync(resolve(path));
    if (hiddenData().some((h) => inside(real, resolve(h)) || inside(real, realish(h))) || inOtherConversation(real)) return false;
    return allowed.some((d) => inside(real, realish(d)));
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
  const inUse = new Set(hiding.filter((m) => m.slot && loaded(cfg.mailProvider).includes(m)).map(server));
  const unused = hiding.filter((m) => !loaded(cfg.mailProvider).includes(m)).map(server);
  const keeps = hiding.map((m) => ({ prefix: m.hide!.prefix, keep: new Set(cfg.visibleTools[m.name] ?? m.hide!.visible) }));
  const extra = seen.filter((t) => keeps.some((k) => t.startsWith(k.prefix) && !k.keep.has(t.slice(k.prefix.length))) || neverAllowedTool(t));
  return [...new Set([...cfg.hiddenConnectors.filter((c) => !inUse.has(c)), ...unused, ...extra])];
}

// The web. Pages and search results are untrusted content, like mail, and a fetched URL can carry data out in its query
// string. A search is free; opening a page is judged, and the address veto is autojudge.ts. Every conversation has the tool alike.

// groupNotesDir: for an isolated run (a group, a tenant), THE one folder its file tools may touch (its own notes). Without it an isolated run gets no file access.
// tools: the tools that exist for the run, from its conversation's capability set (capabilities.ts toolsFor; the owner's included); a group's own by default. The browse worker and
// a bare check have none: only the row decides. A tool outside the set is denied, whatever it is called.
//
// ONE fold for every run (the owner's, a group's, a friend's; attended or not): each step can only lower the verdict.
//   1. it exists here: the run's tool set, and the row's `attended` / `who`
//   2. never allowed (trading, trash, delete, spam, block: by row, by name, by arguments) and no local files: deny
//   3. the manifest: free (a read, the assistant's own plumbing, a call a module declares free) is allow, everything else ask
//   4. every module's floor, the minimum (a friend's Google: no attachments; Gmail: attachment content)
//   5. the note file tools: only on a path inside the notes (a group's: inside that group's notes folder; the owner's chat: or, for Read, the data folders)
// What an isolated run holds and the owner does not is the capability set in 1; there is no second rule for it.
export function classify(tool: string, input: Record<string, unknown>, run: RunKind, notesDir?: string, tools?: ReadonlySet<string>): Verdict {
  const caps = runCapabilities(run);
  const login = caps.has("login"); // (the instance's own login: the owner's. Everyone else, and the browse worker, has none of the owner's data; the files they may touch are their own notes)
  const offered = tools ?? (run.who === "browse" ? browseTools() : toolsFor(caps, run));
  if (!offered.has(tool) && (!login || entryFor(tool))) return "deny"; // (a tool the manifest does not know asks the login's owner, as it always did: a look skips it; without the login there is never one)
  if (!availableFor(tool, run)) return "deny";
  if (isNeverAllowed(tool, input) || namesLocalFile(input)) return "deny";
  let verdict: Verdict = !confirmsDelete(tool, input) && isFree(tool, undefined, { input, run }) ? "allow" : "ask"; // a delete the person confirms is never free
  for (const m of registered()) verdict = lower(verdict, m.floor?.verdict?.(tool, input, run)); // every registered module's, loaded or not: they only restrict
  if (NOTE_FILE_TOOLS.has(tool)) {
    const dir = notesDir ?? (login ? NOTES_DIR : undefined); // (the login's notes are the owner's)
    const ok = (!!dir && isInside(input.file_path, dir)) || (login && tool === "Read" && isReadableData(input.file_path));
    if (!ok || !withinCaps(tool, input, dir)) return "deny";
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
