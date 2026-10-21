// npm run retention -- --dry-run | --now: the retention job by hand (core/retention.ts; the agent runs it by itself once a day at 03:30).
//   --dry-run   run every rule in a mode that only LISTS what it would remove, and remove nothing
//   --now       run every rule now, due or not
// Safe to run while the agent is up (each rule removes only what is past its window).
import "../src/core/requirelayout.ts";
import { instancePaths } from "../src/core/convpaths.ts";
import { registerFileRules } from "../src/heartbeat/retentionrules.ts";
import { megabytes, runRetention } from "../src/core/retention.ts";
import { settings } from "../src/core/settings.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
if (!dryRun && !args.includes("--now")) {
  console.log("usage: npm run retention -- --dry-run | --now");
  process.exit(1);
}
registerFileRules();
if (!settings.retention) console.log("(RETENTION=off: the agent does not run this by itself; running it by hand as asked)");
const report = await runRetention(new Date(), { stateFile: instancePaths().retention, dryRun, force: true });
for (const r of report.ran) {
  console.log(`  ${r.name.padEnd(20)} ${r.error ? `FAILED: ${r.error}` : `${dryRun ? "would remove" : "removed"} ${r.result.removed}, ${megabytes(r.result.freedBytes)}${r.result.notes ? `  (${r.result.notes})` : ""}`}`);
}
process.exit(report.ran.some((r) => r.error) ? 1 : 0);
