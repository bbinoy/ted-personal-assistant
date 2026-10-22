// Import this right after log.ts, FIRST of everything that reads the data folder (src/main.ts): for its side effect, a data folder in the old layout is moved to the current one (core/migrate.ts) before
// any other module opens a file. (Then, at every start, anything an old process wrote to the old places meanwhile is merged or set aside.) A new, empty folder is stamped with the current version; a folder in a NEWER layout stops the start (this code would write where nothing is expected).
import { settings } from "./settings.ts";
import { useConvDbAgentMode } from "./convdb.ts";
import { layoutState, refusal } from "./migrate.ts";
import { migrateSafely } from "./migrateservices.ts";
import { ledgerDamage, openAtStart } from "./instancedb.ts";

useConvDbAgentMode(); // the AGENT is the one process that may set a damaged conversation database aside (a CLI or the intake page must not rename a file the agent holds open)
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
// instance.db (spend, payments...): opened here, with an integrity_check, so a damaged ledger is found at the start. The agent then runs DEGRADED (core/instancedb.ts): chat works, background work and payments
// are refused, the owner is told once, the doctor says so; it does not exit (launchd would restart it in a loop nobody reads). The damaged file is left exactly as it is.
if (!openAtStart()) process.stderr.write(`${ledgerDamage()}\n`);
