// Import this right after log.ts, FIRST of everything that reads the data folder (src/main.ts): for its side effect, a data folder in the old layout is moved to the current one (core/migrate.ts) before
// any other module opens a file. (Then, at every start, anything an old process wrote to the old places meanwhile is merged or set aside.) A new, empty folder is stamped with the current version; a folder in a NEWER layout stops the start (this code would write where nothing is expected).
import { settings } from "./settings.ts";
import { layoutState, refusal } from "./migrate.ts";
import { migrateSafely } from "./migrateservices.ts";
import { instanceDb } from "./instancedb.ts";

const s = layoutState(settings.dataDir);
if (s.state === "newer") {
  process.stderr.write(`${refusal(s)}\n`);
  process.exit(1);
}
try {
  // the intake page (its own launchd job) is stopped while the data moves, another agent process stops the start, and what an old process wrote after an earlier move is merged or set aside
  migrateSafely(settings.dataDir, { agentLabel: settings.launchdLabel, mode: "agent", log: (line) => console.log(line) });
} catch (e) {
  process.stderr.write(`migrate: the data folder could not be moved to the new layout (${(e as Error).message}); nothing is lost, and the next start continues from the stored plan.\n`);
  process.exit(1);
}
try {
  instanceDb(); // instance.db (spend, payments...): opened here so a damaged ledger stops the start with its own message, not in the middle of a run (core/db.ts LedgerCorruptError)
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
