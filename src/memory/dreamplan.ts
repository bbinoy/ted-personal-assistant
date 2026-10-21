import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAX_NOTE_CHARS, NOTES_DIR, parseNote, type Category } from "./notes.ts";
import { preset } from "../core/preset.ts";
import { convPaths, OWNER_CONV } from "../core/convpaths.ts";
import { settings } from "../core/settings.ts";
import { LIMITS } from "../core/sanitize.ts";

// The dream's rules, pure: which of the model's proposals may be applied (see dream.ts for the whole picture). Never trusts
// shape or content; a scope says where a dream works and what it may touch.

const MAX_OPS = 16;
const MAX_WRITES = 8;
const MAX_DELETES = 12;
const MIN_EVIDENCE = 12; // characters of the owner's own words a new fact must quote


// What the dream may write or delete. setup-* notes are the setup skill's (calendar ids, Notion
// pages) and voice-* notes come from the owner's sent mail: neither is learned from chat.
const DREAM_CATEGORIES: readonly Category[] = preset().notes.dream;

// Where a dream works and what it may touch. The owner's own notes are one scope; every group has its own
// (groupstore.ts), so a group's dream can never read or write anything but that group's notes.
export interface Scope {
  notesDir: string;
  backupsDir: string; // snapshots go here, never inside notesDir
  categories: readonly Category[];
  index: boolean; // keep MEMORY.md (the index the owner's chat loads) up to date
  maxNotes: number;
}

export const OWNER_SCOPE: Scope = { notesDir: NOTES_DIR, backupsDir: convPaths(OWNER_CONV).notesBackup, categories: DREAM_CATEGORIES, index: true, maxNotes: settings.memoryMaxNotes };

interface Op {
  op: "write" | "delete";
  file: string;
  description?: string;
  text?: string;
  expires?: string;
  evidence?: string; // a verbatim quote of the owner's own words
  consolidates?: string[]; // existing notes this one replaces (a merge or a rewrite)
  reason?: string;
}

type Action =
  | { kind: "add" | "update" | "merge"; file: string; description: string; content: string; merged: string[] }
  | { kind: "delete"; file: string; why: string };

export interface Plan {
  actions: Action[];
  rejected: { file: string; why: string }[];
}

export interface NoteFile {
  file: string;
  raw: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const FILE = /^[a-z0-9][a-z0-9-]{0,70}\.md$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Pure: the note file the dream writes (same shape the chat's notes have).
export function noteContent(file: string, description: string, text: string, expires: string | undefined, now: Date, origin: "dream" | "inferred" = "dream"): string {
  const name = file.replace(/\.md$/, "");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${expires ? `expires: ${expires}\n` : ""}metadata:\n  node_type: memory\n  type: user\n  origin: ${origin}\n  modified: ${now.toISOString()}\n---\n\n${text}\n`;
}

// Pure: which of the model's proposals may be applied. Never trusts shape or content.
export function planOps(raw: unknown, ctx: { ownerText: string; notes: readonly NoteFile[]; today: string; now: Date; maxNotes?: number; scope?: Scope }): Plan {
  const scope = ctx.scope ?? OWNER_SCOPE;
  const plan: Plan = { actions: [], rejected: [] };
  const list = (raw as { ops?: unknown } | null | undefined)?.ops;
  if (!Array.isArray(list)) return plan;
  const owner = norm(ctx.ownerText);
  const existing = new Map(ctx.notes.map((n) => [n.file, parseNote(n.file, n.raw)]));
  const gone = new Set<string>(); // files an earlier action in this plan removes
  const deleted: string[] = [];
  let writes = 0;
  let count = existing.size;
  const reject = (file: string, why: string) => plan.rejected.push({ file, why });
  const quoted = (e: unknown) => typeof e === "string" && norm(e).length >= MIN_EVIDENCE && owner.includes(norm(e));
  const writable = (file: string) => scope.categories.some((c) => file.startsWith(`${c}-`));

  for (const o of list.slice(0, MAX_OPS) as Op[]) {
    const file = typeof o?.file === "string" ? o.file : "";
    if (!FILE.test(file) || !writable(file)) { reject(file, "not a note the dream may change"); continue; }

    if (o.op === "delete") {
      const note = existing.get(file);
      if (!existsSync(join(scope.notesDir, file)) || gone.has(file)) { reject(file, "no such note"); continue; }
      const expired = !!note?.expires && note.expires < ctx.today;
      if (!expired && !quoted(o.evidence)) { reject(file, "not expired, and no quote from the owner"); continue; }
      if (deleted.length >= MAX_DELETES) { reject(file, "too many deletions"); continue; }
      gone.add(file);
      deleted.push(file);
      plan.actions.push({ kind: "delete", file, why: expired ? "expired" : "the owner said so" });
      count--;
      continue;
    }

    if (o.op !== "write") { reject(file, "unknown operation"); continue; }
    const text = typeof o.text === "string" ? o.text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim() : "";
    const description = typeof o.description === "string" ? o.description.replace(/\s+/g, " ").trim().slice(0, LIMITS.gist) : "";
    if (!text || text.length > MAX_NOTE_CHARS || !description) { reject(file, "empty, or longer than a note may be"); continue; }
    if (o.expires !== undefined && !(typeof o.expires === "string" && DATE.test(o.expires) && o.expires >= ctx.today)) { reject(file, "bad expiry date"); continue; }
    if (writes >= MAX_WRITES) { reject(file, "too many changes in one run"); continue; }

    const sources = [...new Set(Array.isArray(o.consolidates) ? o.consolidates.filter((s): s is string => typeof s === "string") : [])];
    let kind: "add" | "update" | "merge";
    if (sources.length > 0) {
      // A merge may only shorten: it can carry no new information, so it needs no quote.
      if (!sources.every((s) => writable(s) && existing.get(s) && !gone.has(s))) { reject(file, "merge of a note that does not exist or is not the dream's"); continue; }
      const total = sources.reduce((n, s) => n + (existing.get(s)?.text.length ?? 0), 0);
      if (text.length > total) { reject(file, "a merge must not be longer than what it merges"); continue; }
      kind = "merge";
    } else {
      if (!quoted(o.evidence)) { reject(file, "no verbatim quote from the owner's own words"); continue; }
      kind = existing.has(file) ? "update" : "add";
    }
    if (kind === "add" && count >= (ctx.maxNotes ?? scope.maxNotes)) { reject(file, "memory is full"); continue; }
    writes++;
    if (kind === "add") count++;
    const inferred = kind === "merge" && sources.some((s) => existing.get(s)?.inferred); // merging unconfirmed notes confirms nothing; only the owner's own words do
    plan.actions.push({ kind, file, description, content: noteContent(file, description, text, o.expires, ctx.now, inferred ? "inferred" : "dream"), merged: sources });
    for (const s of sources) {
      if (s !== file && !gone.has(s)) {
        gone.add(s);
        plan.actions.push({ kind: "delete", file: s, why: `merged into ${file}` });
        count--;
      }
    }
  }
  return plan;
}
