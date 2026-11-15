import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { emitRecord } from "../core/events.ts";
import { convDbAt } from "../core/convdb.ts";
import { dataRoot, isConvId, layout } from "../core/convpaths.ts";
import { writeFileAtomic } from "../core/state.ts";
import { parseNote, writeIndex } from "./notes.ts";

// TEMPORARY (deleted in the cleanup release, with scripts/restore-premigration.ts and every notes-premigration/ folder): the one-time move of every conversation's notes from the old flat layout, where the
// start of a file name was its category (people-mara.md, setup-calendars.md, routine-brief.md), to pages (docs/ARCHITECTURE.md "Memory"). Code, deterministic, no model, before anything runs on the folders
// (main.ts, before the intake and the heartbeat start). Per conversation (the owner's, each group's, each friend's: one path): a copy of the whole notes folder is kept in notes-premigration/ beside it, then
// each file moves by its old prefix, then the routine records are re-keyed, the index is made again and a marker (notes/.layout) is written LAST: an interrupted run starts the conversation again, every move
// being "write the new file, then remove the old". The pages themselves are merged into subjects over the next nights by the ordinary dream.
// Privacy: what is logged and audited is the conversation's id and counts. Never a file name (a name can be a person's name), for any conversation, errors included.

export const MARKER = ".layout";
export const PREMIGRATION = "notes-premigration";
const LEGACY = /^(people|context|scheduling|triage|brief|style|setup|voice|status|routine)-/i;

const norm = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}@.\s-]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string): string[] => norm(s).split(/[\s-]+/).filter(Boolean);

// The name a people note is about, as the old module read it: the words the note starts with when they carry the file's name, else the file's name spelled out.
function personOf(rest: string, text: string): string {
  const slug = rest.replace(/\.md$/i, "").replace(/-/g, " ");
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const lead = /^([^.:;,\n]{2,60}?)(?:\.|:|;|,| - |$)/.exec(first)?.[1]?.trim();
  const head = tokens(slug)[0];
  const spelled = slug.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const name = lead && tokens(lead).length <= 5 && !/@/.test(lead) && (!head || tokens(lead).some((w) => w.startsWith(head))) ? lead : spelled;
  return name || spelled;
}

const withPerson = (raw: string, name: string): string => {
  const text = raw.replace(/\r\n/g, "\n");
  if (/^---\n[\s\S]*?\n---/.test(text)) return /^\s*person:/m.test(text.split(/\n---/)[0]!) ? text : text.replace(/^---\n/, `---\nperson: ${JSON.stringify(name)}\n`);
  return `---\nperson: ${JSON.stringify(name)}\n---\n\n${text}`;
};

// Where a legacy file goes (relative to the notes folder), or undefined for a style note (merged into style.md) and for the index.
function targetOf(file: string): string {
  const m = LEGACY.exec(file);
  if (!m) return file; // an unknown prefix: a plain page under its own name
  const kind = m[1]!.toLowerCase();
  const rest = file.slice(m[0].length);
  if (kind === "setup") return `setup/${rest}`;
  if (kind === "voice") return `setup/${file}`;
  if (kind === "status") return `status/${rest}`;
  if (kind === "routine") return `routines/${rest}`;
  return rest; // people, context, scheduling, triage, brief
}

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

interface Counts { moved: number; mergedStyle: number; collided: number }

// One conversation. Throws an error carrying the step that failed. Returns undefined when there was nothing to move (the conversation just gets its marker).
function migrateOne(root: string, conv: string): Counts | undefined {
  const l = layout(root).conv(conv);
  if (!existsSync(l.notes) || existsSync(join(l.notes, MARKER))) return undefined;
  const flat = readdirSync(l.notes, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md").map((e) => e.name).sort();
  const counts: Counts = { moved: 0, mergedStyle: 0, collided: 0 };
  let step = 1;
  try {
    if (flat.some((f) => LEGACY.test(f))) {
      // 1. the copy of the whole folder (status included), kept once: a resumed run does not replace it
      const keep = join(l.dir, PREMIGRATION);
      if (!existsSync(keep)) {
        cpSync(l.notes, `${keep}.tmp`, { recursive: true });
        renameSync(`${keep}.tmp`, keep);
      }
      // 2. the style notes become one page, style.md: the bodies as bullets, nothing reworded; what style.md already holds is not added again
      step = 2;
      const styles = flat.filter((f) => /^style-/i.test(f));
      if (styles.length) {
        const path = join(l.notes, "style.md");
        const have = existsSync(path) ? readFileSync(path, "utf8") : "---\nname: style\ndescription: \"Tone, length and wording (shown to groups)\"\n---\n\n";
        const bullets = styles.flatMap((f) => {
          const body = parseNote(f, readFileSync(join(l.notes, f), "utf8"))?.text.replace(/\s*\n\s*/g, " ").trim();
          return body && !have.includes(body) ? [`- ${body}`] : [];
        });
        writeFileAtomic(path, `${have.trimEnd()}\n${bullets.length ? `${bullets.join("\n")}\n` : ""}`);
        for (const f of styles) rmSync(join(l.notes, f)); // (after style.md is whole: a crash before this keeps every note)
        counts.mergedStyle = styles.length;
      }
      // 3. every other file moves: write the new file, then remove the old
      step = 3;
      for (const f of flat.filter((x) => !/^style-/i.test(x))) {
        const old = join(l.notes, f);
        const raw = readFileSync(old, "utf8");
        let to = targetOf(f);
        if (to === f) continue;
        let out = /^people-/i.test(f) ? withPerson(raw, personOf(f.slice("people-".length), parseNote(f, raw)?.text ?? raw)) : raw;
        for (let n = 2; existsSync(join(l.notes, to)); n++) {
          if (sameText(readFileSync(join(l.notes, to), "utf8"), out)) { out = ""; break; } // already moved by an interrupted run
          if (n === 2) counts.collided++;
          to = targetOf(f).replace(/(\.md)$/i, `-${n}$1`);
        }
        if (out) {
          mkdirSync(dirname(join(l.notes, to)), { recursive: true, mode: 0o700 });
          writeFileAtomic(join(l.notes, to), out);
        }
        rmSync(old);
        counts.moved++;
      }
    }
    // 4. the routines' records: the key was the file name without .md ("routine-pep-talk"), now the page's name ("pep-talk")
    step = 4;
    if (existsSync(l.db)) {
      const db = convDbAt(root, conv);
      db.run("UPDATE OR IGNORE routine_runs SET name = substr(name, 9) WHERE name LIKE 'routine-%'");
      db.run("DELETE FROM routine_runs WHERE name LIKE 'routine-%'"); // (a key that met a record of the new name: the old one is of no use)
    }
    // 5. the index again, the marker last
    step = 5;
    writeIndex(l.notes);
    writeFileAtomic(join(l.notes, MARKER), "2\n");
  } catch (e) {
    throw Object.assign(new Error(`${conv}: failed at step ${step}`), { code: (e as NodeJS.ErrnoException).code, step });
  }
  return counts.moved || counts.mergedStyle || counts.collided ? counts : undefined;
}

// Every conversation folder of the data folder (the owner, each group, each friend). Idempotent: one with its marker is skipped. A conversation that fails is logged and the next one is still done, but at the end this
// throws, so the agent refuses to start on a mixed layout; the failed one is tried again at the next start and its old files stay put.
export function migrateAll(root: string = dataRoot()): void {
  const l = layout(root);
  const failed: string[] = [];
  for (const conv of existsSync(l.conversations) ? readdirSync(l.conversations).filter(isConvId).sort() : []) {
    try {
      const counts = migrateOne(root, conv);
      if (!counts) continue;
      console.log(`memory migrated: ${conv} moved ${counts.moved}, merged-style ${counts.mergedStyle}, collided ${counts.collided}`);
      emitRecord("memory_migrated", "moved", "background", { conv, ...counts });
    } catch (e) {
      failed.push(conv);
      console.error(`memory migration: ${(e as Error).message}${(e as { code?: string }).code ? ` (${(e as { code?: string }).code})` : ""}`);
      emitRecord("memory_migrated", "failed", "background", { conv, step: (e as { step?: number }).step ?? 0 });
    }
  }
  if (failed.length) throw new Error(`memory migration failed for ${failed.length} conversation(s): ${failed.join(", ")}; the agent does not start on a mixed layout (see the log), the old files are untouched`);
}

// The doctor's count (owner only): top-level files that still carry an old prefix in a folder with no marker. A number, never a name.
export function unmigrated(notesDir: string): number {
  if (!existsSync(notesDir) || existsSync(join(notesDir, MARKER))) return 0;
  return readdirSync(notesDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && LEGACY.test(e.name)).length;
}
