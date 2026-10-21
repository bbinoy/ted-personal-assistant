// Downloads the headless Chromium that the browse tool uses (src/modules/browse/browse.ts), into state/browse/browsers inside the data folder:
// nothing global, and deleting that folder removes it. About 100 MB, so opt-in: `npm run setup:browse` always downloads it; after `npm install`
// (--quiet, never fails the install) it downloads only with BROWSE=on or BROWSE_INSTALL=1 set, else prints a one-line hint.
// Skipped with BROWSE=off or BROWSE_SKIP_INSTALL=1.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { ROOT } from "../src/core/paths.ts";

const quiet = process.argv.includes("--quiet");
const say = (m: string) => (quiet ? undefined : console.log(m));
const root = ROOT;
const dataDir = process.env.HARNESS_DATA_DIR ? resolve(process.env.HARNESS_DATA_DIR) : root;
const browsers = join(dataDir, "state", "browse", "browsers");

if (process.env.BROWSE === "off" || process.env.BROWSE_SKIP_INSTALL === "1" || (process.env.CI && process.argv.includes("--quiet"))) {
  say("browse: skipped (BROWSE=off or BROWSE_SKIP_INSTALL=1)");
  process.exit(0);
}
if (quiet && process.env.BROWSE !== "on" && process.env.BROWSE_INSTALL !== "1") {
  console.log("browse: the browser tool needs a headless Chromium (~100 MB): run `npm run setup:browse` (or set BROWSE_INSTALL=1 before npm install)");
  process.exit(0);
}
try {
  const have = existsSync(browsers) && readdirSync(browsers).some((d) => d.startsWith("chromium_headless_shell-"));
  if (have) {
    say(`browse: browser already in ${browsers}`);
    process.exit(0);
  }
  const mcp = createRequire(import.meta.url).resolve("@playwright/mcp/package.json");
  const cli = join(dirname(createRequire(mcp).resolve("playwright/package.json")), "cli.js");
  mkdirSync(browsers, { recursive: true });
  console.log(`browse: downloading the headless browser into ${browsers} ...`);
  execFileSync(process.execPath, [cli, "install", "chromium-headless-shell"], { stdio: quiet ? "ignore" : "inherit", env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers } });
  console.log("browse: ready");
} catch (e) {
  // An install without network, or without the package yet, must not break npm install: doctor and the tool say what is missing.
  console.warn(`browse: could not set up the browser (${(e as Error).message.split("\n")[0]}). Run npm run setup:browse later; until then the browse tool says it is not set up.`);
  if (!quiet) process.exit(1);
}
