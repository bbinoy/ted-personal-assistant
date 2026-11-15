// TEMPORARY (deleted in the cleanup release with src/memory/migrate.ts): puts one conversation's notes back as they were before the move to pages, from the copy the migration kept beside them.
//   node scripts/restore-premigration.ts <conversation id>        (owner, group-<hash> or friend-<id>: a folder name under conversations/)
// It replaces the notes folder with the copy, brings back the dream's old snapshots (notes-backup/), deletes the marker and gives the routines' run records their old keys (the migration wrote down which became which).
// The copy is renamed notes-premigration.restored-<time> (a later migration takes a fresh one). Use it with the agent stopped, together with reverting the release (the old code reads the old layout; the new code would
// move the files again at its next start). Prints counts only.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { convDbAt } from "../src/core/convdb.ts";
import { dataRoot, isConvId, layout } from "../src/core/convpaths.ts";
import { KEYS_FILE, MARKER, PREMIGRATION, SNAPSHOTS } from "../src/memory/migrate.ts";

const conv = process.argv[2];
if (!isConvId(conv)) {
  console.error("usage: node scripts/restore-premigration.ts <conversation id>");
  process.exit(2);
}
const l = layout(dataRoot()).conv(conv);
const copy = join(l.dir, PREMIGRATION);
if (!existsSync(copy)) {
  console.error(`${conv}: there is no ${PREMIGRATION}/ copy (nothing was moved, or it was already restored)`);
  process.exit(1);
}
rmSync(l.notes, { recursive: true, force: true });
cpSync(copy, l.notes, { recursive: true, filter: (src) => src !== join(copy, SNAPSHOTS) && src !== join(copy, KEYS_FILE) });
rmSync(join(l.notes, MARKER), { force: true });
if (existsSync(join(copy, SNAPSHOTS))) {
  rmSync(l.notesBackup, { recursive: true, force: true }); // (the snapshots of the new layout)
  cpSync(join(copy, SNAPSHOTS), l.notesBackup, { recursive: true });
}
const keys: Record<string, string> = existsSync(join(copy, KEYS_FILE)) ? JSON.parse(readFileSync(join(copy, KEYS_FILE), "utf8")) : {};
if (existsSync(l.db)) {
  const db = convDbAt(dataRoot(), conv);
  for (const [old, now] of Object.entries(keys)) db.run("UPDATE OR IGNORE routine_runs SET name = ? WHERE name = ?", old, now);
}
renameSync(copy, `${copy}.restored-${Date.now()}`);
console.log(`${conv}: notes restored (${readdirSync(l.notes).length} entries, ${Object.keys(keys).length} routine key(s)); the marker is gone`);
