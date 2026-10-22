// Import this FIRST in a tool that reads the data folder but does not migrate it (the CLIs, the intake page): for its side effect, a data folder in the old layout, or in a newer one than this code
// understands, stops it with a clear sentence instead of letting it read the wrong places. `npm run migrate` (or starting the agent) moves an old one; a new, empty folder is fine.
import { settings } from "./settings.ts";
import { layoutState, refusal } from "./migrate.ts";
import { instanceDb } from "./instancedb.ts";

const why = refusal(layoutState(settings.dataDir));
if (why) {
  process.stderr.write(`${why}\n`); // (not console.error: after log.ts that only reaches agent.log, and the person at the terminal must read it)
  process.exit(1);
}
try {
  instanceDb(); // a damaged ledger database stops the tool with its message (core/db.ts), instead of an error in the middle of it
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
