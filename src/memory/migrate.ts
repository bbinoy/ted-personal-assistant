import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { emitRecord } from "../core/events.ts";
import { convDbAt } from "../core/convdb.ts";
import { dataRoot, isConvId, layout, OWNER_CONV } from "../core/convpaths.ts";
import { NOTES_MARKER, writeFileAtomic } from "../core/state.ts";
import { NOTE_PATH, parseNote, stemOf, walkNotes, writeIndex } from "./notes.ts";

// TEMPORARY (deleted in the cleanup release, with scripts/restore-premigration.ts and every notes-premigration/ folder): the one-time move of every conversation's notes from the old flat layout, where the
// start of a file name was its category (people-mara.md, setup-calendars.md, routine-brief.md), to pages (docs/ARCHITECTURE.md "Memory"). Code, deterministic, no model, before anything runs on the folders
// (main.ts, before the intake and the heartbeat start). Per conversation (the owner's, each group's, each friend's: one path): a copy of the whole notes folder is kept in notes-premigration/ beside it, then
// each file moves by its old prefix, then the routine records are re-keyed, the index is made again and a marker (notes/.layout) is written LAST: an interrupted run starts the conversation again, every move
// being "write the new file, then remove the old". The pages themselves are merged into subjects over the next nights by the ordinary dream.
// Privacy: what is logged and audited is the conversation's id and counts. Never a file name (a name can be a person's name), for any conversation, errors included.

export const MARKER = NOTES_MARKER;
export const PREMIGRATION = "notes-premigration";
export const SNAPSHOTS = "dream-snapshots"; // in the copy: the dream's snapshots of the old layout
const PREREPAIR = "notes-prerepair"; // beside the notes: the pages as they were before the repair of links and fields first wrote anything
const LAYOUT_VERSION = "3\n"; // the marker's content: 2 = moved to pages, 3 = also repaired (links, person:, name:); a folder born after the upgrade is written as 3 (core/state.ts)
export const KEYS_FILE = ".routine-keys.json"; // in the copy's folder: which routine_runs key became which (the restore replays it backwards)
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
  const to = kind === "setup" ? `setup/${rest}` : kind === "voice" ? `setup/${file}` : kind === "status" ? `status/${rest}` : kind === "routine" ? `routines/${rest}` : rest; // (people, context, scheduling, triage, brief: a plain page)
  if (NOTE_PATH.test(to)) return to;
  // a name that would not be a page name (nothing after the prefix, a leading dot, odd characters): made safe
  const dir = to.includes("/") ? `${to.split("/")[0]}/` : "";
  const stem = rest.replace(/\.md$/i, "").replace(/[^\p{L}\p{N}_.-]/gu, "-").replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 80);
  return `${dir}${stem || "page"}.md`;
}

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

// ---- the repair of what the move left: links, person: and name: ----
// The move renamed files but left the [[links]] in the bodies as they were ("[[people-mara]]" now leads nowhere), gave every people-* page a person: made from its file name (junk for a page about a
// project or a second name) and left the old `name: people-mara` line (nothing reads `name:`). Idempotent; once per conversation (the marker says 3 afterwards); the pages are copied first (notes-prerepair/, once).
interface Repaired { links: number; persons: number; names: number }

const frontOf = (text: string): { front: string; rest: string } | undefined => {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? { front: m[1]!, rest: text.slice(m[0].length) } : undefined;
};
const unq = (v: string): string => v.trim().replace(/^["']|["']$/g, "");
const rebuild = (front: string, rest: string): string => (front.trim() ? `---\n${front}\n---\n${rest}` : rest.replace(/^\n+/, ""));

// The new text of one page and what changed in it. `stems`: the stem (lower case) of every page that exists, and how many files carry it; `original`: the page as it was before the move, when it came from a people-* file.
function repairText(text: string, stems: ReadonlyMap<string, number>, original: string | undefined): { text: string; links: number; person: boolean; name: boolean } {
  let links = 0;
  let out = text.replace(/\[\[([^\]\n|]+)(\|[^\]\n]*)?\]\]/g, (all, target: string, label = "") => {
    const stem = stemOf(target.trim()).toLowerCase();
    if (stems.has(stem) || !LEGACY.test(`${stem}.md`)) return all;
    const now = stemOf(targetOf(`${stem}.md`)).toLowerCase(); // the stem the move gave it (a routine is routines/<stem>: a page's identity for a link is its stem)
    if (now === stem || stems.get(now) !== 1) return all; // no such page, or several: left for the dream
    links++;
    return `[[${now}${label}]]`;
  });
  let person = false;
  let name = false;
  const f = frontOf(out);
  if (f) {
    let front = f.front;
    const added = original !== undefined && !/^\s*person:/m.test(frontOf(original.replace(/\r\n/g, "\n"))?.front ?? ""); // never one the original file had
    const who = /^person:[ \t]*(.*?)[ \t]*$/m.exec(front)?.[1];
    if (added && who && !norm(f.rest).includes(norm(unq(who)))) {
      front = front.replace(/^person:.*\n?/m, "").replace(/\n+$/, "");
      person = true;
    }
    const nm = /^name:[ \t]*(.*?)[ \t]*$/m.exec(front)?.[1];
    if (nm !== undefined && LEGACY.test(unq(nm))) {
      front = front.replace(/^name:.*\n?/m, "").replace(/\n+$/, "");
      name = true;
    }
    if (person || name) out = rebuild(front, f.rest);
  }
  return { text: out, links, person, name };
}

// The pages of one conversation, repaired in place: the counts, or undefined when nothing needed it. The copy is made before the first write (`copied`: the move's own copy already holds the old state).
function repairOne(notes: string, convDir: string, copied: boolean): Repaired | undefined {
  const files = walkNotes(notes).filter((f) => !/^status\//i.test(f));
  const stems = new Map<string, number>();
  for (const f of files) stems.set(stemOf(f).toLowerCase(), (stems.get(stemOf(f).toLowerCase()) ?? 0) + 1);
  const total: Repaired = { links: 0, persons: 0, names: 0 };
  const next: [string, string][] = [];
  for (const f of files) {
    const raw = readFileSync(join(notes, f), "utf8");
    const old = f.includes("/") ? undefined : join(convDir, PREMIGRATION, `people-${f}`); // (only a top-level page can have come from a people-* file)
    const r = repairText(raw, stems, old && existsSync(old) ? readFileSync(old, "utf8") : undefined);
    if (r.text === raw) continue;
    total.links += r.links;
    total.persons += +r.person;
    total.names += +r.name;
    next.push([f, r.text]);
  }
  if (!next.length) return undefined;
  const bak = join(convDir, PREREPAIR);
  if (!copied && !existsSync(bak)) {
    cpSync(notes, `${bak}.tmp`, { recursive: true });
    renameSync(`${bak}.tmp`, bak);
  }
  for (const [f, text] of next) writeFileAtomic(join(notes, f), text);
  return total;
}

interface Counts { moved: number; mergedStyle: number; collided: number; repaired?: Repaired }

// One conversation. Throws an error carrying the step that failed. Returns undefined when there was nothing to move (the conversation just gets its marker).
function migrateOne(root: string, conv: string): Counts | undefined {
  const l = layout(root).conv(conv);
  const marker = join(l.notes, MARKER);
  if (!existsSync(l.notes)) return undefined;
  const moved = existsSync(marker); // already on pages: only the repair may be left
  if (moved && readFileSync(marker, "utf8") === LAYOUT_VERSION) return undefined;
  const flat = moved ? [] : readdirSync(l.notes, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md").map((e) => e.name).sort();
  const counts: Counts = { moved: 0, mergedStyle: 0, collided: 0 };
  let step = 1;
  const keysPath = join(l.dir, PREMIGRATION, KEYS_FILE);
  try {
    if (flat.some((f) => LEGACY.test(f))) {
      // 1. the copy of the whole folder (status included), kept once: a resumed run does not replace it
      const keep = join(l.dir, PREMIGRATION);
      if (!existsSync(keep)) {
        cpSync(l.notes, `${keep}.tmp`, { recursive: true });
        renameSync(`${keep}.tmp`, keep);
      }
      // the dream's old snapshots are of the old layout: "undo the dream" must never restore one over pages, so they go into the copy (the restore brings them back)
      if (existsSync(l.notesBackup) && !existsSync(join(keep, SNAPSHOTS))) renameSync(l.notesBackup, join(keep, SNAPSHOTS));
      const keys: Record<string, string> = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : {};
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
        if (/^routine-/i.test(f)) {
          keys[f.replace(/\.md$/i, "")] = to.replace(/^.*\//, "").replace(/\.md$/i, ""); // (written before the old file goes: a restart still knows)
          writeFileAtomic(keysPath, JSON.stringify(keys));
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
      const keys: Record<string, string> = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : {};
      for (const [old, now] of Object.entries(keys)) {
        db.run("UPDATE OR IGNORE routine_runs SET name = ? WHERE name = ?", now, old);
        db.run("DELETE FROM routine_runs WHERE name = ?", old); // (a key that met a record of the new name: the old one is of no use)
      }
    }
    // 5. the links, person: and name: of the moved pages (the copy above is their backup), the index again, the marker last
    step = 5;
    const fixed = repairOne(l.notes, l.dir, !moved && existsSync(join(l.dir, PREMIGRATION)));
    if (fixed) counts.repaired = fixed;
    writeIndex(l.notes);
    writeFileAtomic(marker, LAYOUT_VERSION);
  } catch (e) {
    throw Object.assign(new Error(`${conv}: failed at step ${step}`), { code: (e as NodeJS.ErrnoException).code, step });
  }
  return counts.moved || counts.mergedStyle || counts.collided || counts.repaired ? counts : undefined;
}

// Every conversation folder of the data folder (the owner first, then each group and friend). Idempotent: one with its marker is skipped. A failure of the OWNER's conversation throws, so the agent refuses to start on
// a mixed layout of its own chat. Any other conversation that fails is logged (its id and the error code) and the agent starts; it is tried again at the next start, its old files stay put (its old-prefixed files
// are plain pages meanwhile), and the doctor counts it.
export function migrateAll(root: string = dataRoot()): void {
  const l = layout(root);
  const failed: string[] = [];
  const ids = (existsSync(l.conversations) ? readdirSync(l.conversations).filter(isConvId).sort() : []).sort((a, b) => Number(b === OWNER_CONV) - Number(a === OWNER_CONV));
  for (const conv of ids) {
    try {
      const counts = migrateOne(root, conv);
      if (!counts) continue;
      console.log(`memory migrated: ${conv} moved ${counts.moved}, merged-style ${counts.mergedStyle}, collided ${counts.collided}, links ${counts.repaired?.links ?? 0}, person ${counts.repaired?.persons ?? 0}, name ${counts.repaired?.names ?? 0}`);
      emitRecord("memory_migrated", "moved", "background", { conv, moved: counts.moved, mergedStyle: counts.mergedStyle, collided: counts.collided, ...counts.repaired });
    } catch (e) {
      failed.push(conv);
      console.error(`memory migration: ${(e as Error).message}${(e as { code?: string }).code ? ` (${(e as { code?: string }).code})` : ""}`);
      emitRecord("memory_migrated", "failed", "background", { conv, step: (e as { step?: number }).step ?? 0 });
      if (conv === OWNER_CONV) throw new Error("memory migration failed for the owner's conversation; the agent does not start on a mixed layout (see the log), the old files are untouched");
    }
  }
  if (failed.length) console.error(`memory migration: ${failed.length} other conversation(s) not moved yet, tried again at the next start`);
}

// The doctor's count: how many conversations (any kind) still have old-prefixed files in a folder with no marker. A number, never a name.
export function unmigrated(root: string = dataRoot()): number {
  const l = layout(root);
  return (existsSync(l.conversations) ? readdirSync(l.conversations).filter(isConvId) : []).filter((conv) => {
    const dir = l.conv(conv).notes;
    return existsSync(dir) && !existsSync(join(dir, MARKER)) && readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && e.name.endsWith(".md") && LEGACY.test(e.name));
  }).length;
}
