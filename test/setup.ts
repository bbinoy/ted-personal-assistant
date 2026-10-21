// Preloaded into every test process (`node --import ./test/setup.ts`, see "test" in package.json): each test file gets its own data
// directory. Files run in parallel processes; with one shared directory they all append to the same audit log and write the same state
// files, so a test that reads the log back could see another file's rows. A file that needs a particular directory still sets
// HARNESS_DATA_DIR itself before it imports the settings. Running a single file by hand no longer writes into the repository either.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
process.env.HARNESS_DATA_DIR = dir;
process.env.LOOK_STAGGER_MS ??= "0"; // looks of different conversations start together in tests; test/heartbeatrun.test.ts and test/heartbeat-sleep.test.ts check the staggering itself
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
