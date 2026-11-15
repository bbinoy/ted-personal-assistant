// TEMPORARY (deleted in the cleanup release with src/memory/migrate.ts): puts one conversation's notes back as they were before the move to pages, from the copy the migration kept beside them.
//   node scripts/restore-premigration.ts <conversation id>        (owner, group-<hash> or friend-<id>: a folder name under conversations/)
// It replaces the notes folder with notes-premigration/, deletes the marker and gives the routines' run records their old keys back. Use it with the agent stopped, together with reverting the release (the old code
// reads the old layout; the new code would move the files again at its next start). The copy stays until the cleanup release. Prints counts only.
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { convDbAt } from "../src/core/convdb.ts";
import { dataRoot, isConvId, layout } from "../src/core/convpaths.ts";
import { MARKER, PREMIGRATION } from "../src/memory/migrate.ts";

const conv = process.argv[2];
if (!isConvId(conv)) {
  console.error("usage: node scripts/restore-premigration.ts <conversation id>");
  process.exit(2);
}
const l = layout(dataRoot()).conv(conv);
const copy = join(l.dir, PREMIGRATION);
if (!existsSync(copy)) {
  console.error(`${conv}: there is no ${PREMIGRATION}/ copy (nothing was moved, or it was already removed)`);
  process.exit(1);
}
rmSync(l.notes, { recursive: true, force: true });
cpSync(copy, l.notes, { recursive: true });
rmSync(join(l.notes, MARKER), { force: true });
const routines = readdirSync(l.notes).filter((f) => /^routine-.+\.md$/.test(f)).map((f) => f.slice("routine-".length, -".md".length));
if (existsSync(l.db)) {
  const db = convDbAt(dataRoot(), conv);
  for (const name of routines) db.run("UPDATE OR IGNORE routine_runs SET name = ? WHERE name = ?", `routine-${name}`, name);
}
console.log(`${conv}: notes restored (${readdirSync(l.notes).length} entries, ${routines.length} routine(s)); the marker is gone`);
