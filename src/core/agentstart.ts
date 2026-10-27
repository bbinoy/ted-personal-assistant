// Import this right after log.ts, FIRST of everything that reads the data folder (src/main.ts): for its side effect, a data folder in another layout stops the start with one sentence (layoutProblem,
// core/convpaths.ts), and a new, empty one is stamped with the current layout version.
import { settings } from "./settings.ts";
import { useConvDbAgentMode } from "./convdb.ts";
import { layoutProblem, stampLayout } from "./convpaths.ts";
import { ledgerDamage, openAtStart } from "./instancedb.ts";
import { importPauseFile } from "./pause.ts";

useConvDbAgentMode(); // the AGENT is the one process that may set a damaged conversation database aside (a CLI or the intake page must not rename a file the agent holds open)
const why = layoutProblem(settings.dataDir);
if (why) {
  process.stderr.write(`${why}\n`);
  process.exit(1);
}
stampLayout(settings.dataDir);
// instance.db (spend, payments...): opened here, with an integrity_check, so a damaged ledger is found at the start. The agent then runs DEGRADED (core/instancedb.ts): chat works, background work and payments
// are refused, the owner is told once, the doctor says so; it does not exit (launchd would restart it in a loop nobody reads). The damaged file is left exactly as it is.
if (!openAtStart()) process.stderr.write(`${ledgerDamage()}\n`);
else if (importPauseFile()) process.stderr.write("An old instance/paused file was turned into the pause switch in instance.db (/resume lifts it); the file is gone.\n"); // (once: the switch is a row now)
