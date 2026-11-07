import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARD_NAMES_NOTE, MAX_NOTE_CHARS, STATUS_PREFIX, parseNote, type Category } from "./notes.ts";
import { LIMITS } from "../core/sanitize.ts";

// The dream's rules, pure: which of the model's proposals may be applied (see dream.ts for the whole picture). Never trusts
// shape or content; a scope says where a dream works and what it may touch.

const MAX_OPS = 30;
const MAX_WRITES = 12; // a merge, a split and a few new people notes in one night
const MAX_DELETES = 12;
const MIN_EVIDENCE = 12; // characters of the owner's own words a new fact must quote
const MAX_REASONED_DELETES = 3; // deletes a night that rest on the model's reason alone (not an expiry, a quote or a rewrite of the note's content)
const MIN_REASON = 10; // characters of the model's own reason for deleting a note


// What the dream may write or delete. setup-* notes are the setup skill's (calendar ids, Notion
// pages) and voice-* notes come from the owner's sent mail: neither is learned from chat.
// Where a dream works and what it may touch. The owner's own notes are one scope; every group has its own
// (groupstore.ts), so a group's dream can never read or write anything but that group's notes.
export interface Scope {
  notesDir: string;
  backupsDir: string; // snapshots go here, never inside notesDir
  categories: readonly Category[];
  maxNotes: number;
}

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
export function noteContent(file: string, description: string, text: string, expires: string | undefined, now: Date): string {
  const name = file.replace(/\.md$/, "");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${expires ? `expires: ${expires}\n` : ""}metadata:\n  node_type: memory\n  type: user\n  modified: ${now.toISOString()}\n---\n\n${text}\n`;
}

// The floor for a write built from existing notes: no number, capitalised word (but a sentence's first), email or link in it that no note or word of the person holds. Reworded instructions
// are not caught here (the prompt and the assistant-lines rule hold those); new names, numbers, addresses and links are.
const NEW_DETAIL = /\d+(?:[.,:]\d+)*|\S+@\S+|(?:https?:\/\/|www\.)\S+|(?<![.!?\n:*#>-]\s*)(?<!^)\p{Lu}[\p{L}'-]*/gu;
function addsDetails(text: string, known: string): boolean {
  const k = norm(known);
  return (text.match(NEW_DETAIL) ?? []).some((t) => {
    const w = norm(t.replace(/[.,;:)]+$/, ""));
    return /^\d/.test(w) ? !new RegExp(`(?<!\\d)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(k) : !k.includes(w);
  });
}

// Pure: which of the model's proposals may be applied. Never trusts shape or content.
export function planOps(raw: unknown, ctx: { ownerText: string; notes: readonly NoteFile[]; today: string; now: Date; maxNotes?: number; scope: Scope }): Plan {
  const { scope } = ctx;
  const plan: Plan = { actions: [], rejected: [] };
  const list = (raw as { ops?: unknown } | null | undefined)?.ops;
  if (!Array.isArray(list)) return plan;
  const owner = norm(ctx.ownerText);
  const existing = new Map(ctx.notes.map((n) => [n.file, parseNote(n.file, n.raw)]));
  const gone = new Set<string>(); // files an earlier action in this plan removes
  const deleted: string[] = [];
  const written = new Set<string>(); // files an accepted write in this plan targets
  const reasonOnly = new Set<string>(); // deletes that rest on the model's reason alone
  const lost = new Set<string>(); // sources of a rejected write: nothing about them changes
  const known = [...existing.values()].map((n) => n?.text ?? "").join("\n") + "\n" + ctx.ownerText;
  const textLen = new Map<string, number>();
  let writes = 0;
  let count = existing.size;
  const reject = (file: string, why: string) => plan.rejected.push({ file, why });
  const quoted = (e: unknown) => typeof e === "string" && norm(e).length >= MIN_EVIDENCE && owner.includes(norm(e));
  const writable = (file: string) => scope.categories.some((c) => file.startsWith(`${c}-`));

  if (list.length > MAX_OPS) console.log(`dream: ${list.length - MAX_OPS} of ${list.length} proposals left out (too many)`);
  for (const o of list.slice(0, MAX_OPS) as Op[]) {
    const file = typeof o?.file === "string" ? o.file : "";
    if (!FILE.test(file) || !writable(file)) { reject(file, "not a note the dream may change"); continue; }

    if (o.op === "delete") {
      const note = existing.get(file);
      if (!existsSync(join(scope.notesDir, file)) || gone.has(file)) { reject(file, "no such note"); continue; }
      if (written.has(file)) { reject(file, "written in this plan"); continue; }
      const expired = !!note?.expires && note.expires < ctx.today;
      const reasoned = typeof o.reason === "string" && o.reason.trim().length >= MIN_REASON;
      if (!expired && !quoted(o.evidence) && !reasoned) { reject(file, "not expired, no quote from the owner and no reason"); continue; }
      if (deleted.length >= MAX_DELETES) { reject(file, "too many deletions"); continue; }
      if (!expired && !quoted(o.evidence)) reasonOnly.add(file);
      gone.add(file);
      deleted.push(file);
      plan.actions.push({ kind: "delete", file, why: expired ? "expired" : reasoned ? String(o.reason).trim().slice(0, 120) : "the owner said so" });
      count--;
      continue;
    }

    if (o.op !== "write") { reject(file, "unknown operation"); continue; }
    // Source names are tidied (no directory, ".md" added); any existing note may be a source (reading adds nothing new), the target itself is not one. A missing source is dropped, naming it if the write then fails.
    const named = [...new Set((Array.isArray(o.consolidates) ? o.consolidates : []).filter((s): s is string => typeof s === "string").map((s) => s.trim().split(/[\\/]/).pop()!.trim()).filter(Boolean).map((s) => (s.endsWith(".md") ? s : `${s}.md`)))];
    const selfNamed = named.includes(file);
    // A status note is a record of runs that read mail, not memory: it is no source (dropped like a missing one).
    const isStatus = (s: string) => s.startsWith(STATUS_PREFIX);
    const sources = named.filter((s) => s !== file && existing.get(s) && !isStatus(s));
    const missing = named.filter((s) => s !== file && (!existing.get(s) || isStatus(s))).map((s) => (isStatus(s) ? `source not memory: ${s}` : `source missing: ${s}`)).join(", ");
    const bad = (why: string) => { reject(file, missing ? `${why} (${missing})` : why); for (const x of named) lost.add(x); };
    const text = typeof o.text === "string" ? o.text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim() : "";
    const description = typeof o.description === "string" ? o.description.replace(/\s+/g, " ").trim().slice(0, LIMITS.gist) : "";
    if (!text || text.length > MAX_NOTE_CHARS || !description) { bad("empty, or longer than a note may be"); continue; }
    if (o.expires !== undefined && !(typeof o.expires === "string" && DATE.test(o.expires) && o.expires >= ctx.today)) { bad("bad expiry date"); continue; }
    if (writes >= MAX_WRITES) { bad("too many changes in one run"); continue; }

    let kind: "add" | "update" | "merge";
    if (sources.length > 0 || (selfNamed && existing.has(file))) {
      // Written from existing notes (merge, split, reformat, a note for a person they mention, a note rewritten from itself): what they hold is already memory, so no quote and no length limit.
      if (addsDetails(text, known)) { bad("adds details no note or quote holds"); continue; }
      kind = "merge";
    } else {
      if (!quoted(o.evidence)) { bad("no verbatim quote from the owner's own words"); continue; }
      kind = existing.has(file) ? "update" : "add";
    }
    if (!existing.has(file) && count >= (ctx.maxNotes ?? scope.maxNotes)) { bad("memory is full"); continue; }
    if (gone.has(file)) { bad("deleted in this plan"); continue; }
    writes++;
    written.add(file);
    textLen.set(file, text.length);
    if (!existing.has(file)) count++;
    plan.actions.push({ kind, file, description, content: noteContent(file, description, text, o.expires, ctx.now), merged: named.filter((s) => existing.get(s) && !isStatus(s)) }); // (sources are only deleted by a delete of their own)
  }

  // A rejected write takes back every delete and rewrite of its sources (a split loses nothing it did not keep).
  const drop = (keep: (a: Action) => boolean, why: string) => { plan.actions = plan.actions.filter((a) => keep(a) || (reject(a.file, why), false)); };
  drop((a) => !lost.has(a.file), "a write built from this note was rejected");
  const live = plan.actions.filter((a) => a.kind !== "delete") as Exclude<Action, { kind: "delete" }>[];
  const fed = new Map<string, number>(); // source -> writes to another file it feeds
  for (const w of live) for (const x of w.merged) if (x !== w.file) fed.set(x, (fed.get(x) ?? 0) + 1);
  let reasoned = 0;
  drop((a) => a.kind !== "delete" || !reasonOnly.has(a.file) || fed.has(a.file) || ++reasoned <= MAX_REASONED_DELETES, "too many deletions on a reason alone");
  // A merge into another file of the same kind that is no longer than its sources takes them away (else duplicates grow every night); a source feeding two or more writes is a split and stays, as does one written again.
  const gonePlan = new Set(plan.actions.filter((a) => a.kind === "delete").map((a) => a.file));
  for (const w of live) {
    const total = w.merged.reduce((n, x) => n + (existing.get(x)?.text.length ?? 0), 0);
    for (const x of w.merged) {
      if (x === w.file || !writable(x) || w.file === HARD_NAMES_NOTE || fed.get(x) !== 1 || written.has(x) || gonePlan.has(x) || (textLen.get(w.file) ?? 0) > total) continue;
      if (x.split("-")[0] !== w.file.split("-")[0] || gonePlan.size >= MAX_DELETES) continue;
      gonePlan.add(x);
      plan.actions.push({ kind: "delete", file: x, why: `merged into ${w.file}` });
    }
  }
  return plan;
}
