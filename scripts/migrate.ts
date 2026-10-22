// npm run migrate [-- --dry-run]: move the data folder from the old layout (state/, memory/, tenants/, logs/ by kind of file) to the current one (instance/, conversations/<id>/, logs/).
// The agent does the same by itself at every start; this is for doing it on purpose, or for looking first: --dry-run prints every step and touches nothing.
// It refuses while the agent or the intake page is running (they would write to the old places meanwhile), and says what to stop; --stop-services stops both, migrates, and starts them again.
// Safe to run again: it continues an interrupted run from instance/migration-plan.json, and a folder that is migrated already says so. Local terminal only.
import { settings } from "../src/core/settings.ts";
import { describePlan, layoutState, planMigration, readVersion, refusal, stragglers } from "../src/core/migrate.ts";
import { migrateSafely } from "../src/core/migrateservices.ts";
import { describeImport } from "../src/core/dbimport.ts";
import { describeConvImport } from "../src/core/convimport.ts";
import { INSTANCE_DB_VERSION, LAYOUT_VERSION, MOVES_VERSION } from "../src/core/convpaths.ts";

const args = process.argv.slice(2);
const say = (l: string) => void process.stdout.write(`${l}\n`); // (not console.log: after log.ts that only reaches agent.log)
if (args.some((a) => a !== "--dry-run" && a !== "--stop-services")) {
  say("usage: npm run migrate [-- --dry-run | --stop-services]");
  process.exit(1);
}
const root = settings.dataDir;
const state = layoutState(root);
if (state.state === "newer") {
  say(refusal(state)!);
  process.exit(1);
}
say(`data folder: ${root}`);
say(`layout version: ${readVersion(root) ?? "none (old layout, or a new folder)"}; this code writes ${LAYOUT_VERSION}`);
if (args.includes("--dry-run")) {
  const plan = state.state === "current" || readVersion(root) === MOVES_VERSION || readVersion(root) === INSTANCE_DB_VERSION ? { ...planMigration(root), ops: stragglers(root) } : planMigration(root);
  const willExist = plan.ops.map((o) => o.to);
  const imports = [...(readVersion(root) === INSTANCE_DB_VERSION ? [] : describeImport(root, willExist)), ...describeConvImport(root, willExist, plan.ops.map((o) => ({ from: o.from, to: o.to })))]; // layouts 3 and 4: the small files that go into instance/instance.db, and each conversation's into its assistant.db
  for (const l of plan.ops.length === 0 && imports.length > 0 ? [] : describePlan(plan)) say(l);
  for (const l of imports) say(l);
  say("Dry run: nothing was moved.");
  process.exit(0);
}
await import("../src/core/log.ts"); // (not for a dry run: it creates folders) timestamps and redaction; the steps are listed in logs/agent.log too
try {
  const r = migrateSafely(root, { agentLabel: settings.launchdLabel, mode: "cli", stopServices: args.includes("--stop-services"), log: say });
  say(r.already ? "Already in the current layout: nothing to do." : r.moved ? `Done: ${r.moved} step(s)${r.orphans.length ? `, ${r.orphans.length} set aside in instance/migration-orphans/ (listed above and in logs/agent.log)` : ""}.` : "Stamped as the current layout (there was nothing to move).");
} catch (e) {
  say(`Not finished: ${(e as Error).message}. Nothing is lost; run it again to continue.`);
  process.exit(1);
}
