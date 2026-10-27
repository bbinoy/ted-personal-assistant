// Preloaded into every test process (`node --import ./test/setup.ts`, see "test" in package.json): each test file gets its own data
// directory. Files run in parallel processes; with one shared directory they all append to the same audit log and write the same state
// files, so a test that reads the log back could see another file's rows. A file that needs a particular directory still sets
// HARNESS_DATA_DIR itself before it imports the settings. Running a single file by hand no longer writes into the repository either.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One time zone for every test process, whatever the machine's (a laptop in London, a CI runner in UTC): run options carry the
// conversation's zone and the snapshots must not depend on where they run. A file that tests another zone still sets TZ itself.
process.env.TZ = "Europe/London";

const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
process.env.HARNESS_DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// The owner's own way of logging in (src/tenants/payer.ts OWN_LOGIN) must not leak from the developer's shell into the tests: the run-options
// snapshot is built from the process environment, and it differs when e.g. ANTHROPIC_BASE_URL is set. Removed before anything is imported.
for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_API_KEY_HELPER", "ANTHROPIC_API_KEY"]) delete process.env[k];
