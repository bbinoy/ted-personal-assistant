// Proves the published tarballs work together: packs @ted-assistant/messenger and @ted-assistant/signal (which builds
// them), installs BOTH tarballs into an empty folder outside the repo (signal depends on messenger, which is not on npm
// until it is published, so the pair is installed together), and imports every entry point of both with plain Node (no
// TypeScript, no workspace condition), then runs a smoke test.
// Run from anywhere: `node packages/signal/build/verify-pack.mjs`. With `--keep-tarballs <dir>` the tarballs are also
// copied to <dir> (CI scans them for secrets).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "signal-pack-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const keepAt = process.argv.includes("--keep-tarballs") ? process.argv[process.argv.indexOf("--keep-tarballs") + 1] : undefined;
try {
  const tarballs = [];
  for (const name of ["messenger", "signal"]) {
    const dest = join(tmp, "tarballs", name);
    mkdirSync(dest, { recursive: true });
    run("npm", ["pack", "--pack-destination", dest], join(packages, name));
    const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack of ${name} produced no tarball`);
    tarballs.push(join(dest, tgz));
    if (keepAt) {
      mkdirSync(keepAt, { recursive: true });
      copyFileSync(join(dest, tgz), join(keepAt, tgz));
    }
  }
  const scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  writeFileSync(join(scratch, "package.json"), '{"name":"scratch","private":true,"type":"module"}');
  run("npm", ["install", "--no-audit", "--no-fund", ...tarballs], scratch);
  writeFileSync(
    join(scratch, "smoke.mjs"),
    `import * as messenger from "@ted-assistant/messenger";
import * as messengerTesting from "@ted-assistant/messenger/testing";
import * as messengerContract from "@ted-assistant/messenger/contract";
import * as messengerEnv from "@ted-assistant/messenger/env";
import * as signalMessenger from "@ted-assistant/signal/messenger";
import { SignalClient } from "@ted-assistant/signal";
import { FakeSignalDaemon } from "@ted-assistant/signal/testing";
for (const [name, mod, symbol] of [
  ["@ted-assistant/messenger", messenger, "loadMessenger"],
  ["@ted-assistant/messenger/testing", messengerTesting, "FakeMessenger"],
  ["@ted-assistant/messenger/contract", messengerContract, "messengerContract"],
  ["@ted-assistant/messenger/env", messengerEnv, "withoutSecrets"],
  ["@ted-assistant/signal/messenger", signalMessenger, "createMessenger"],
]) {
  if (typeof mod[symbol] !== "function") throw new Error(name + " does not export " + symbol);
}
const d = await FakeSignalDaemon.start();
const c = new SignalClient({ host: d.host, port: d.port, account: "+10000000000" });
await c.connect();
if (typeof (await c.send("hello")) !== "number") throw new Error("send did not return a timestamp");
c.close();
await d.close();
console.log("ok: the packed messenger and signal tarballs install together and every entry point imports under plain Node");
`,
  );
  process.stdout.write(run("node", ["smoke.mjs"], scratch));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
