// Import this right after log.ts, FIRST of everything that reads the data folder (src/main.ts): for its side effect, a data folder in the old layout is moved to the current one (core/migrate.ts) before
// any other module opens a file. A new, empty folder is stamped with the current version; a folder in a NEWER layout stops the start (this code would write where nothing is expected).
import { settings } from "./settings.ts";
import { layoutState, migrate, refusal } from "./migrate.ts";

const s = layoutState(settings.dataDir);
if (s.state === "newer") {
  process.stderr.write(`${refusal(s)}\n`);
  process.exit(1);
}
try {
  migrate(settings.dataDir, { log: (line) => console.log(line) });
} catch (e) {
  process.stderr.write(`migrate: the data folder could not be moved to the new layout (${(e as Error).message}); nothing is lost, and the next start continues from the stored plan.\n`);
  process.exit(1);
}
