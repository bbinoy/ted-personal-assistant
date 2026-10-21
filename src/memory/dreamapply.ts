import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { audit } from "../core/audit.ts";
import { OWNER_SCOPE, type Plan, type Scope } from "./dreamplan.ts";
import { forgetNote, STATUS_PREFIX } from "./notes.ts";

// Applying a plan to the notes folder, with a snapshot first, and undoing the latest one.

const KEEP_SNAPSHOTS = 7;

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

function snapshot(now: Date, scope: Scope): string {
  mkdirSync(scope.backupsDir, { recursive: true, mode: 0o700 });
  const dir = join(scope.backupsDir, stamp(now));
  cpSync(scope.notesDir, dir, { recursive: true, filter: (src) => !basename(src).startsWith(STATUS_PREFIX) }); // a status note is not the dream's: an undo must not bring back yesterday's
  for (const old of readdirSync(scope.backupsDir).sort().slice(0, -KEEP_SNAPSHOTS)) rmSync(join(scope.backupsDir, old), { recursive: true, force: true });
  return dir;
}

export function upsertIndex(file: string, description: string, scope: Scope): void {
  const path = join(scope.notesDir, "MEMORY.md");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l && !l.includes(`(${file})`)) : [];
  const title = file.replace(/\.md$/, "").replace(/^[a-z]+-/, "").replace(/-/g, " ");
  lines.push(`- [${title.charAt(0).toUpperCase()}${title.slice(1)}](${file}) - ${description}`);
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
}

// Applies a plan, after a snapshot. Returns the snapshot's folder (undefined if nothing to do).
export function applyPlan(plan: Plan, now = new Date(), scope: Scope = OWNER_SCOPE): string | undefined {
  if (plan.actions.length === 0) return undefined;
  mkdirSync(scope.notesDir, { recursive: true, mode: 0o700 });
  const dir = snapshot(now, scope);
  for (const a of plan.actions) {
    if (a.kind === "delete") forgetNote(a.file, scope.notesDir);
    else {
      writeFileSync(join(scope.notesDir, a.file), a.content, { mode: 0o600 });
      if (scope.index) upsertIndex(a.file, a.description, scope);
    }
  }
  return dir;
}

// Puts the notes back as they were before the latest dream. The snapshot is used up.
export function undoLatest(scope: Scope = OWNER_SCOPE): { ok: true; restored: number; from: string } | { ok: false; error: string } {
  const snaps = existsSync(scope.backupsDir) ? readdirSync(scope.backupsDir).sort() : [];
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
  audit("dream_undo", "restored", "chat", { restored });
  return { ok: true, restored, from: latest };
}
