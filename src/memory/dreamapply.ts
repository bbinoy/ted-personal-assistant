import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { emitRecord } from "../core/events.ts";
import { writeFileAtomic } from "../core/state.ts";
import { OWNER_SCOPE, type Plan, type Scope } from "./dreamplan.ts";
import { settings } from "../core/settings.ts";
import { forgetNote, STATUS_PREFIX } from "./notes.ts";

// Applying a plan to the notes folder, with a snapshot first, and undoing the latest one.

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

// The snapshots of a backups folder, oldest first: only the stamped ones (a folder of anything else in there, such as the retention job's expired/, is neither counted, pruned nor undone).
export const snapshotsOf = (backupsDir: string): string[] => (existsSync(backupsDir) ? readdirSync(backupsDir).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort() : []);

function snapshot(now: Date, scope: Scope): string {
  mkdirSync(scope.backupsDir, { recursive: true, mode: 0o700 });
  const dir = join(scope.backupsDir, stamp(now));
  cpSync(scope.notesDir, dir, { recursive: true, filter: (src) => !basename(src).startsWith(STATUS_PREFIX) }); // a status note is not the dream's: an undo must not bring back yesterday's
  for (const old of snapshotsOf(scope.backupsDir).slice(0, -settings.notesBackupKeep)) rmSync(join(scope.backupsDir, old), { recursive: true, force: true });
  return dir;
}

export function upsertIndex(file: string, description: string, scope: Scope): void {
  const path = join(scope.notesDir, "MEMORY.md");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l && !l.includes(`(${file})`)) : [];
  const title = file.replace(/\.md$/, "").replace(/^[a-z]+-/, "").replace(/-/g, " ");
  lines.push(`- [${title.charAt(0).toUpperCase()}${title.slice(1)}](${file}) - ${description}`);
  writeFileAtomic(path, lines.join("\n") + "\n"); // always a fresh read of the index and only this file's line changed: an edit made meanwhile to any other line survives
}

// What a dream read: each note's content hash at read time. A dream awaits a model for a while; the owner's chat (auto-memory) or a background look may edit or add a note meanwhile.
// At apply time an op whose target no longer matches what the model was shown is skipped (and logged), never written over.
export type NoteBase = ReadonlyMap<string, string>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const baseOf = (notes: readonly { file: string; raw: string }[]): NoteBase => new Map(notes.map((n) => [n.file, sha(n.raw)]));
function changedSince(base: NoteBase, dir: string, file: string): boolean {
  const path = join(dir, file);
  const now = existsSync(path) ? sha(readFileSync(path, "utf8")) : undefined;
  return now !== base.get(file); // absent then and now is the same; a file that appeared or vanished or was edited differs
}

// Applies a plan, after a snapshot. Returns the snapshot's folder (undefined if nothing to do). With `base` (what the dream read), an op whose target note changed since is skipped:
// a write also protects the notes it merges (they are not deleted when the merged note could not be written). The index is merged line by line (upsertIndex, forgetNote), never overwritten.
export function applyPlan(plan: Plan, now = new Date(), scope: Scope = OWNER_SCOPE, base?: NoteBase): string | undefined {
  if (plan.actions.length === 0) return undefined;
  mkdirSync(scope.notesDir, { recursive: true, mode: 0o700 });
  const dir = snapshot(now, scope);
  const stale = (f: string) => !!base && changedSince(base, scope.notesDir, f);
  const protectedFiles = new Set<string>();
  for (const a of plan.actions) if (a.kind !== "delete" && (stale(a.file) || (a.merged ?? []).some(stale))) {
    protectedFiles.add(a.file);
    for (const m of a.merged ?? []) protectedFiles.add(m);
  }
  for (const a of plan.actions) {
    if (protectedFiles.has(a.file) || stale(a.file)) {
      console.log(`dream: skipped ${a.file}: it changed while the dream was running`);
      continue;
    }
    if (a.kind === "delete") forgetNote(a.file, scope.notesDir);
    else {
      writeFileAtomic(join(scope.notesDir, a.file), a.content);
      if (scope.index) upsertIndex(a.file, a.description, scope);
    }
  }
  return dir;
}

// Puts the notes back as they were before the latest dream. The snapshot is used up.
export function undoLatest(scope: Scope = OWNER_SCOPE): { ok: true; restored: number; from: string } | { ok: false; error: string } {
  const snaps = snapshotsOf(scope.backupsDir);
  const latest = snaps.at(-1);
  if (!latest) return { ok: false, error: "there is no dream to undo" };
  const dir = join(scope.backupsDir, latest);
  for (const f of readdirSync(scope.notesDir)) if (f.endsWith(".md") && !f.startsWith(STATUS_PREFIX)) rmSync(join(scope.notesDir, f));
  let restored = 0;
  for (const f of readdirSync(dir)) {
    cpSync(join(dir, f), join(scope.notesDir, f));
    if (f !== "MEMORY.md") restored++;
  }
  rmSync(dir, { recursive: true, force: true });
  emitRecord("dream_undo", "restored", "chat", { restored });
  return { ok: true, restored, from: latest };
}
