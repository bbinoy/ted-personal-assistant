import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../core/state.ts";
import { join } from "node:path";
import { LIMITS } from "../core/sanitize.ts";
import { localDay } from "../core/pause.ts";
import { upsertIndex } from "./dreamapply.ts";
import { noteContent } from "./dreamplan.ts";
import { MAX_NOTE_CHARS, NOTES_DIR, parseNote, readNotes } from "./notes.ts";

// A note a background look writes itself (the write_note tool): the heartbeat run learned something (a person moved, a trip, a new contact) while the owner was not talking to it.
// It is never confirmed: the note says `origin: inferred` (the index shows it, a later run weighs it less), the save is logged by the tool (not announced), and only the owner's
// own words, through the chat or the dream's quote rule, turn it into a confirmed note. What it may do is narrow by construction: categories the preset allows it (facts, not
// rules), a new note or one of its own earlier inferred notes (never a note the owner confirmed), one fact, a bounded size and number.

const FILE = /^[a-z]+-[a-z0-9][a-z0-9-]{0,60}\.md$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type InferredResult = { ok: true; file: string; created: boolean; gist: string } | { ok: false; error: string };

export function writeInferredNote(
  a: { file: string; text: string; description: string; expires?: string },
  o: { dir?: string; categories: readonly string[]; maxNotes: number; now?: Date; zone?: string },
): InferredResult {
  const dir = o.dir ?? NOTES_DIR;
  const now = o.now ?? new Date();
  if (!FILE.test(a.file) || !o.categories.some((c) => a.file.startsWith(`${c}-`))) return { ok: false, error: `name the note <category>-<short-slug>.md with a category of ${o.categories.join(", ")}` };
  const text = a.text.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/g, "").trim();
  const description = a.description.replace(/\s+/g, " ").trim().slice(0, LIMITS.gist);
  if (!text || !description) return { ok: false, error: "the note needs its text and a one-line description" };
  if (text.length > MAX_NOTE_CHARS) return { ok: false, error: `too long (${text.length} characters, the most is ${MAX_NOTE_CHARS})` };
  if (a.expires !== undefined && !(DATE.test(a.expires) && a.expires >= localDay(now, o.zone))) return { ok: false, error: "expires is a YYYY-MM-DD date that has not passed" };
  const path = join(dir, a.file);
  const existing = existsSync(path) ? parseNote(a.file, readFileSync(path, "utf8")) : undefined;
  if (existing && !existing.inferred) return { ok: false, error: `${a.file} is a note the owner confirmed: you cannot change it. Save what you learned as a new note, or tell the owner.` };
  if (!existing && readNotes(now, dir, o.zone).length >= o.maxNotes) return { ok: false, error: "memory is full" };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(path, noteContent(a.file, description, text, a.expires, now, "inferred"));
  upsertIndex(a.file, `${description} (inferred)`, { notesDir: dir } as never);
  return { ok: true, file: a.file, created: !existing, gist: description };
}
