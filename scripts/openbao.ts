// npm run openbao -- install|setup|status|unseal|keep|backup|service: the secret store of the app (docs/SETUP.md, src/secrets/openbaoadmin.ts).
// Local terminal only. Nothing here prints a secret except `setup`, which shows the three recovery shares once, on the terminal, and nowhere else.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../src/core/paths.ts";
import { openbaoCheck } from "../src/doctor.ts";
import { macKeychain } from "../src/secrets/keychain.ts";
import { Admin, installBinary, layoutOf, ensureCert, writeConfig, PIN } from "../src/secrets/openbaoadmin.ts";
import { ensureNodePath, installJob, keeperPlist, removeJob, serverPlist, serviceNames } from "../src/secrets/openbaoservice.ts";
import { readHiddenFromTerminal } from "../src/modules/browse/profilecli.ts";
import { settings } from "../src/core/settings.ts";

const repo = ROOT;
const cfg = settings.openbao;
const layout = layoutOf(cfg.dir);
const names = serviceNames();
const out = (l: string) => console.log(l);
const admin = new Admin({ layout, addr: cfg.addr, mount: cfg.mount, role: cfg.role, tenant: "owner", prefix: cfg.keychainPrefix, keychain: macKeychain });

const USAGE = [
  "usage: npm run openbao -- <command>",
  "  install              download the pinned OpenBao release, check its checksum, put it in " + cfg.dir,
  "  setup                everything: install, certificate, config, the two launchd jobs, init (first time) or repair, tokens, audit log",
  "  status               is it running, sealed or open, is the app's token the narrow one it should be",
  "  unseal [--recovery]  unseal from this Mac's Keychain; with --recovery, from two recovery shares typed at hidden prompts",
  "  keep [--quiet]       what the keeper job runs every minute: unseal if sealed, renew the tokens",
  "  forget-tenant <id>   delete a removed friend's items (tenants/<id>/*) with a short-lived root token (npm run tenants -- remove <id> prints this when needed)",
  "  backup               a Raft snapshot (encrypted by OpenBao) into " + layout.backups,
  "  service install|uninstall   the launchd jobs only",
];

function line(ok: boolean | "warn", what: string, detail = ""): void {
  console.log(`${ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`);
}

async function showShares(shares: string[]): Promise<boolean> {
  if (!process.stdout.isTTY) throw new Error("the recovery shares are shown on a terminal only");
  console.log("\n=== RECOVERY SHARES: shown ONCE, never stored by this tool beyond what the Mac keeps for unsealing ===");
  console.log("Any TWO of these three unseal OpenBao. Record each in a different safe place (a password manager, a paper in a safe),");
  console.log("never in this repository, a chat or a note on this Mac. They are the way back if this Mac or its Keychain is lost.\n");
  shares.forEach((s, i) => console.log(`  share ${i + 1} of ${shares.length}: ${s}`));
  const tail = shares[2]!.slice(-6);
  for (let i = 0; ; i++) {
    const typed = (await readHiddenFromTerminal("\nWhen all three are recorded, type the last 6 characters of share 3 (hidden): ")).trim();
    if (typed === tail) break;
    if (i >= 2) return false; // the shares stay on the screen: setup goes on and says so at the end
    console.log("That is not the end of share 3. Look again.");
  }
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear the screen and its scrollback
  console.log("Recovery shares cleared from the screen.");
  return true;
}

async function installServices(): Promise<void> {
  ensureNodePath(repo);
  const server = serverPlist(readFileSync(resolve(repo, "launchd/openbao.plist.template"), "utf8"), layout, names.server);
  out(`launchd ${names.server}: ${await installJob(names.server, server, layout)}`);
  const env: Record<string, string> = { OPENBAO_ADDR: cfg.addr, OPENBAO_MOUNT: cfg.mount, OPENBAO_HOME: layout.dir, OPENBAO_CACERT: cfg.caCert, OPENBAO_ROLE: cfg.role, OPENBAO_KEYCHAIN_PREFIX: cfg.keychainPrefix, ...(process.env.HARNESS_DATA_DIR ? { HARNESS_DATA_DIR: process.env.HARNESS_DATA_DIR } : {}) };
  const keeper = keeperPlist(readFileSync(resolve(repo, "launchd/openbao-keeper.plist.template"), "utf8"), layout, names.keeper, repo, env);
  out(`launchd ${names.keeper}: ${await installJob(names.keeper, keeper, layout)}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === "install") {
    out(`OpenBao ${PIN.version}: ${await installBinary(layout, { out })} (${layout.bin})`);
    return 0;
  }
  if (cmd === "setup") {
    if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error("setup needs a terminal (it shows the recovery shares there, once)");
    out(`OpenBao ${PIN.version}: ${await installBinary(layout, { out })}`);
    out(`certificate: ${await ensureCert(layout)} (${layout.cert})`);
    writeConfig(layout, cfg.addr);
    await installJob(names.server, serverPlist(readFileSync(resolve(repo, "launchd/openbao.plist.template"), "utf8"), layout, names.server), layout).then((r) => out(`launchd ${names.server}: ${r}`));
    const confirmed = await admin.setup({ out, showShares });
    await installServices();
    out("\nDone. Check: npm run doctor    Saved details: npm run profile -- set <key>");
    if (!confirmed) {
      out("\nWARNING: the recovery shares were NOT confirmed as recorded, and they were not cleared from your terminal. OpenBao works, but if this Mac or its Keychain is lost, only your recorded shares bring the secrets back.");
      out("Record them now from the scrollback above. If you cannot, start over while nothing is saved yet: see docs/SETUP.md (empty data directory).");
      return 1;
    }
    return 0;
  }
  if (cmd === "status") {
    try {
      const h = await admin.health();
      out(`OpenBao ${h.version ?? "?"}: ${h.initialized ? (h.sealed ? "SEALED" : "unsealed") : "not initialised"} at ${cfg.addr}`);
    } catch (e) {
      out(`OpenBao is not reachable at ${cfg.addr}: ${(e as Error).message}`);
    }
    await openbaoCheck(line);
    return 0;
  }
  if (cmd === "unseal") {
    if (argv.includes("--recovery")) {
      const shares = [(await readHiddenFromTerminal("Recovery share (hidden): ")).trim(), (await readHiddenFromTerminal("A second recovery share (hidden): ")).trim()];
      out((await admin.unsealWith(shares)) ? "Unsealed." : "Still sealed: those shares did not unseal it.");
    } else out(`OpenBao is ${await admin.unsealFromKeychain()}.`);
    return 0;
  }
  if (cmd === "keep") {
    const quiet = argv.includes("--quiet");
    try {
      const did = await admin.unsealFromKeychain();
      if (did === "unsealed" || !quiet) out(`${new Date().toISOString()} OpenBao ${did}`);
      if (did !== "not initialised") {
        const renewed = await admin.renewTokens();
        if (renewed === "renewed" || !quiet) out(`${new Date().toISOString()} tokens ${renewed}`);
      }
      return 0;
    } catch (e) {
      out(`${new Date().toISOString()} keeper: ${(e as Error).message}`);
      return 1;
    }
  }
  if (cmd === "backup") {
    out(`Snapshot: ${await admin.backup()} (encrypted by OpenBao; restoring it needs the unseal shares)`);
    return 0;
  }
  if (cmd === "forget-tenant" && arg) {
    // The admin side of removing a friend (npm run tenants -- remove <id> prints this command when the app's token could not): her items, with a short-lived root token.
    out(`${arg}: ${await admin.forgetTenant(arg)} secret-store item(s) removed.`);
    return 0;
  }
  if (cmd === "service" && (arg === "install" || arg === "uninstall")) {
    if (arg === "install") await installServices();
    else for (const l of [names.keeper, names.server]) out(`${l}: ${(await removeJob(l)) ? "removed" : "was not installed"}`);
    return 0;
  }
  USAGE.forEach(out);
  return cmd ? 1 : 0;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  const be = e as Error & { detail?: string };
  console.error(be.message + (be.detail ? ` (${be.detail})` : ""));
  process.exit(1);
}
