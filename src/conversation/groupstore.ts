import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { Scope } from "../memory/dreamplan.ts";
import { compactIfNeeded, messagesSince, recordMessage, withoutDeleted, type Extra, type Kind, type Sent } from "../core/messages.ts";
import { matchLines } from "../core/logsearch.ts";
import { MAX_NOTE_CHARS, type Note } from "../memory/notes.ts";
import { preset } from "../core/preset.ts";
import { settings } from "../core/settings.ts";
import { convPaths, conversationsDir, groupConvId, isConvId } from "../core/convpaths.ts";
import { moveAside, readText, writeFileAtomic } from "../core/state.ts";
import { summarizeWithHaiku } from "./summarize.ts";
import { LIMITS } from "../core/sanitize.ts";

// Everything a group has: its own notes (what members asked the assistant to remember there) and its own
// message history, in the same formats as the owner's, but in a conversation folder that nothing private reads
// or writes. A group is told apart by a short hash of its id (convpaths.ts groupConvId); its folder is conversations/group-<hash>/:
//   notes/        the group's notes, one fact per file
//   notes-backup/ snapshots of those notes made by the group's dream
//   meta.json     the group's id and name
//   session.json  the group's resumed SDK session (like the owner's)
//   messages.jsonl everything written in the group and the assistant's replies, size-bounded
// The owner's chat cannot read it (policy.ts: only conversations/owner/); she searches a group's history with search_logs (a fixed tool), and nothing flows the other way.

const GROUP_CATEGORIES = preset().notes.others;

export const groupLogFile = (groupId: string): string => convPaths(groupConvId(groupId)).messages;

// meta.json of a group; one that does not parse is moved aside (state.ts) and the group goes on with defaults, instead of throwing on every message of that group.
function readMeta(meta: string): { id?: string; name?: string } | undefined {
  if (!existsSync(meta)) return undefined;
  try {
    const m = JSON.parse(readFileSync(meta, "utf8"));
    if (m && typeof m === "object" && !Array.isArray(m)) return m;
    throw new Error("not an object");
  } catch (e) {
    console.error(`groups: ${meta} is unreadable (${(e as Error).message}); moved aside to ${moveAside(meta) ?? "(could not move it)"}, starting from defaults`);
    return undefined;
  }
}

// The group's folder (made on first use); the name is kept up to date in meta.json.
const named = new Map<string, string>(); // group id -> the name written in meta.json, so it is not re-read per message
export function groupDir(groupId: string, name?: string): string {
  const p = convPaths(groupConvId(groupId));
  const dir = p.dir;
  if (named.has(groupId) && (!name || named.get(groupId) === name) && existsSync(p.notes)) return dir;
  mkdirSync(p.notes, { recursive: true, mode: 0o700 });
  const meta = p.meta;
  const known = readMeta(meta);
  // The folder is named by a 64-bit hash of the id. A different group that hashes to the same folder (someone who grinds ids) must never
  // share the first group's notes, history and session: refuse it instead.
  if (known?.id !== undefined && known.id !== groupId) throw new Error(`group folder ${groupConvId(groupId)} belongs to another group; refusing to share it`);
  const final = name || known?.name || "";
  if (!known || known.name !== final) writeFileAtomic(meta, JSON.stringify({ id: groupId, name: final }));
  named.set(groupId, final);
  return dir;
}

/** A forgotten group: what is remembered in memory of its name (its folder is the caller's to delete). */
export const forgetGroupCache = (groupId: string): void => void named.delete(groupId);

export const groupScope = (groupId: string): Scope => {
  groupDir(groupId); // (the folder is made first)
  const p = convPaths(groupConvId(groupId));
  return { notesDir: p.notes, backupsDir: p.notesBackup, categories: GROUP_CATEGORIES, maxNotes: settings.memoryMaxNotes };
};

interface KnownGroup {
  id: string;
  name: string;
  dir: string;
  convId: string;
}

export function listGroups(): KnownGroup[] {
  try {
    return readdirSync(conversationsDir())
      .filter((c) => isConvId(c) && c.startsWith("group-"))
      .map((convId) => ({ convId, dir: convPaths(convId).dir, meta: convPaths(convId).meta }))
      .filter(({ meta }) => existsSync(meta))
      .map(({ convId, dir, meta }) => ({ ...(JSON.parse(readFileSync(meta, "utf8")) as { id: string; name: string }), dir, convId }));
  } catch {
    return [];
  }
}

// ---- history ----

// A line in the group's log. What members wrote is kind "member" (text starts with who wrote it); the
// assistant's own replies are kind "chat". An edit is kind "edit" (the new text of an earlier line) and a deletion kind "delete" (a marker).
export function recordGroup(groupId: string, kind: Kind, ts: number, text: string, extra?: Extra): void {
  const file = groupLogFile(groupId);
  recordMessage(kind, ts, text, new Date(), file, extra);
  void compactIfNeeded(summarizeWithHaiku, settings.groupLogMb * 1_000_000, file).catch((e) => console.error("group log: compaction failed:", (e as Error).message));
}

export const groupHistorySince = (groupId: string, sinceIso?: string): Sent[] => messagesSince(sinceIso, groupLogFile(groupId));

const MAX_UNSEEN = 60;
const lineOf = (m: Sent) => `[${new Date(m.at).toTimeString().slice(0, 5)}] ${m.kind === "chat" ? `${settings.assistant}: ` : m.kind === "edit" ? "(edited an earlier message, this is its new text) " : ""}${m.text.replace(/\n+/g, " / ").slice(0, LIMITS.logLine)}`;

// The lines a run should be shown, oldest first. A fresh session gets the last n lines. A resumed one already
// holds everything up to `since` (and the assistant's own replies), so it gets only what members wrote after
// that: the cheaper way for messages nobody answered to reach the model, prepended to the next turn instead of
// a model call each. seenAt is the newest line in the log now, stored with the session once the run is made.
export function groupContext(groupId: string, since?: string, n = 25): { lines: string[]; seenAt?: string } {
  // What a member took back (deleted for everyone) is not shown, only that it happened; an edit is a line of its own that says so.
  const all = withoutDeleted(groupHistorySince(groupId)).filter((m) => m.kind === "member" || m.kind === "chat" || m.kind === "edit" || m.kind === "delete" || m.kind === "reaction");
  const picked = since ? all.filter((m) => m.kind !== "chat" && m.at > since).slice(-MAX_UNSEEN) : all.slice(-n);
  return { lines: picked.map(lineOf), seenAt: all.at(-1)?.at ?? since };
}

// The last few lines of context before a new message, oldest first.

// Search the group's whole log (the oldest part is one summary line). Words must all appear.
export const searchGroupHistory = (groupId: string, args: { query?: string; sinceHours?: number; limit?: number }): string => searchHistoryFile(groupLogFile(groupId), args);

// The same over any one conversation's history file (a tenant's, tenants.ts): the file is the scope, closed over by the memory server.
export function searchHistoryFile(file: string, args: { query?: string; sinceHours?: number; limit?: number }): string {
  const hits = matchLines(readText(file) ?? "", { query: args.query, sinceHours: args.sinceHours });
  if (hits.length === 0) return "No matching messages.";
  const limit = Math.max(1, Math.min(60, Math.floor(args.limit ?? 25)));
  return `${hits.length > limit ? `Showing the last ${limit} of ${hits.length} matching lines.\n` : ""}${hits.slice(-limit).join("\n")}`;
}

// ---- notes ----

// The group's notes are the SDK's auto-memory, written with the file tools inside this folder (policy.ts).
// There is no write-time check on them: containment is the only gate. What is read back is bounded where it
// is read (groupNotesBlock, the dream).
export const groupNotesDir = (groupId: string): string => convPaths(groupConvId(groupId)).notes;


// Pure: the group's notes as fenced data for the group's prompt.
export function groupNotesBlock(notes: readonly Note[]): string {
  const lines = notes.map((n) => `- [${n.category}] ${n.file}: ${n.text.replace(/\s*\n\s*/g, " ").slice(0, MAX_NOTE_CHARS)}${n.expires ? ` (until ${n.expires})` : ""}`);
  return lines.length ? lines.join("\n") : "";
}

