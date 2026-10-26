// The one layout guard. Import this FIRST in a tool that reads the data folder (the CLIs, the intake page): for its side effect, a data folder in another layout than the one this code uses (layoutProblem in
// core/convpaths.ts) stops it with one sentence, and a damaged ledger database stops it with its message (core/db.ts) instead of an error in the middle of the tool. A new, empty folder is fine; the agent
// (core/agentstart.ts) is the one that stamps it.
import { layoutProblem } from "./convpaths.ts";
import { settings } from "./settings.ts";
import { instanceDb } from "./instancedb.ts";

const why = layoutProblem(settings.dataDir);
if (why) {
  process.stderr.write(`${why}\n`); // (not console.error: after log.ts that only reaches agent.log, and the person at the terminal must read it)
  process.exit(1);
}
try {
  instanceDb();
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
