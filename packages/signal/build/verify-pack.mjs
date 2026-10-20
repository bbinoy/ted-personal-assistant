// Proves the published tarball works: packs the package (which builds it), installs the tarball into an empty folder
// outside the repo, and imports every entry point with plain Node (no TypeScript, no workspace condition).
// Run from anywhere: `node packages/signal/build/verify-pack.mjs`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "signal-pack-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
try {
  run("npm", ["pack", "--pack-destination", tmp], pkg);
  const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack produced no tarball");
  writeFileSync(join(tmp, "package.json"), '{"name":"scratch","private":true,"type":"module"}');
  run("npm", ["install", "--no-audit", "--no-fund", join(tmp, tgz)], tmp);
  writeFileSync(
    join(tmp, "smoke.mjs"),
    `import { SignalClient } from "@ted-personal-assistant/signal";
import { FakeSignalDaemon } from "@ted-personal-assistant/signal/testing";
const d = await FakeSignalDaemon.start();
const c = new SignalClient({ host: d.host, port: d.port, account: "+10000000000" });
await c.connect();
if (typeof (await c.send("hello")) !== "number") throw new Error("send did not return a timestamp");
c.close();
await d.close();
console.log("ok: the packed tarball installs and every entry point imports under plain Node");
`,
  );
  process.stdout.write(run("node", ["smoke.mjs"], tmp));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
