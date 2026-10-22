import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CardStore } from "../src/modules/browse/card.ts";
import { intakeCheck, openbaoCheck } from "../src/doctor.ts";
import type { Keychain } from "../src/secrets/keychain.ts";
import { BaoError } from "../src/secrets/openbao.ts";
import { Admin, configHcl, ensureCert, ensureDirs, installBinary, layoutOf, writeConfig } from "../src/secrets/openbaoadmin.ts";
import { ProfileStore } from "../src/modules/browse/profile.ts";
import { appBao, keychainNames, TenantSecrets } from "../src/secrets/secrets.ts";
import { settings } from "../src/core/settings.ts";

// A real OpenBao, started by this test as a THROWAWAY server (its own temporary folder, its own port, its own random unseal keys, an in-memory
// stand-in for the Keychain) from the locally installed binary. Only obviously fake values go in, and everything is deleted at the end. It is
// skipped when no OpenBao binary is installed (npm run openbao -- install), so a machine without it still passes.

const here = dirname(fileURLToPath(import.meta.url));
const binary = [process.env.OPENBAO_BIN, join(settings.openbao.dir, "bin/bao"), resolve(here, "../state/openbao/bin/bao")].find((p) => p && existsSync(p));

const FAKE_EMAIL = "e2e.fake.person@example.com";
const FAKE_PASSPORT = "E2E-PASSPORT-FAKE-0001";
const FAKE_PAN = "4242424242424242";
const FAKE_CVC = "737";

const memoryKeychain = (): Keychain & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, get: async (s) => items.get(s), set: async (s, v) => void items.set(s, v), remove: async (s) => items.delete(s) };
};
const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
const allFiles = (dir: string, skip: Set<string>): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (skip.has(e.name) ? [] : e.isDirectory() ? allFiles(join(dir, e.name), skip) : [join(dir, e.name)]));

test("real OpenBao (throwaway): setup, store and read fake items, narrow token, audit log without values, seal and unseal from the Keychain, repair, backup, cleanup", { skip: binary ? false : "no OpenBao binary installed (npm run openbao -- install)", timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ted-bao-e2e-"));
  const port = await freePort();
  const addr = `https://127.0.0.1:${port}`;
  const layout = layoutOf(dir);
  ensureDirs(layout);
  symlinkSync(binary!, layout.bin);
  assert.equal(await installBinary(layout), "present", "the binary is the pinned version");
  assert.equal(await ensureCert(layout), "made");
  assert.equal(statSync(layout.key).mode & 0o777, 0o600);
  writeConfig(layout, addr);
  assert.match(configHcl(layout, addr), /address\s+= "127\.0\.0\.1:\d+"/, "loopback only");
  assert.equal(statSync(dir).mode & 0o777, 0o700);

  let server: ChildProcess | undefined;
  const start = () => {
    server = spawn(layout.bin, ["server", `-config=${layout.config}`], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
  };
  const stop = async () => {
    const s = server;
    server = undefined;
    if (!s || s.exitCode !== null) return;
    await new Promise<void>((r) => (s.once("exit", () => r()), s.kill("SIGTERM")));
  };
  const keychain = memoryKeychain();
  const prefix = "ted-openbao-e2e";
  const admin = new Admin({ layout, addr, mount: "ted", role: "ted-owner", tenant: "owner", prefix, keychain });
  const cfg = { ...settings.openbao, addr, mount: "ted", caCert: layout.cert, keychainPrefix: prefix, timeoutMs: 10_000, cacheMs: 0 };
  let shown: string[] = [];
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), showShares: async (s: string[]) => (shown = s, false) }; // false: the owner did not confirm the shares

  try {
    start();
    assert.equal(await admin.setup(io), false, "an unconfirmed recovery share does not stop setup half way, it is reported");
    // init: 3 shares shown once; the Keychain has exactly two of them, and the token
    assert.equal(shown.length, 3);
    const names = keychainNames(prefix);
    assert.ok(keychain.items.get(names.token) && keychain.items.get(names.operator), "the tokens were made although the confirmation failed");
    assert.equal(keychain.items.get(names.share(1)), shown[0]);
    assert.equal(keychain.items.get(names.share(2)), shown[1]);
    assert.ok(!keychain.items.has(names.share(3)), "the third share is not kept on the Mac");
    const token = keychain.items.get(names.token)!;
    assert.ok(token);
    assert.ok(!lines.join("\n").includes(token) && !shown.some((s) => lines.join("\n").includes(s)), "setup prints no token and no share");
    assert.ok(lines.some((l) => /root token was revoked/.test(l)));
    assert.equal(statSync(layout.audit).mode & 0o777, 0o600, "the audit log is private");

    // the app's own path: the profile and the card, through the real client and the pinned certificate
    const bao = appBao({ keychain, cfg });
    const secrets = new TenantSecrets(bao, "owner");
    const profile = new ProfileStore(secrets);
    await profile.set("email", { value: FAKE_EMAIL, kind: "email", domains: [] });
    await profile.set("passport", { value: FAKE_PASSPORT, kind: "id", domains: ["sbb.ch"] });
    assert.equal((await profile.read()).passport?.value, FAKE_PASSPORT);
    assert.deepEqual(await secrets.names("profile"), ["email", "passport"]);
    const cards = new CardStore(secrets);
    await cards.save({ pan: FAKE_PAN, expMonth: 12, expYear: 2099, cvc: FAKE_CVC, label: "E2E", last4: "4242", currency: "CHF" });
    assert.deepEqual(await cards.peek(), { last4: "4242", label: "E2E", currency: "CHF" });
    assert.equal((await cards.load())?.cvc, FAKE_CVC);

    // the token is narrow: not another tenant's folder, not the system, not a mount; and a friend's card is refused in code
    await assert.rejects(bao.write("tenants/friend/profile/email", { value: "x" }), (e: Error) => e instanceof BaoError && e.status === 403);
    await assert.rejects(bao.read("tenants/owner-other/profile/email"), (e: Error) => e instanceof BaoError && e.status === 403);
    await assert.rejects(bao.raw("GET", "sys/mounts"), (e: Error) => e instanceof BaoError && e.status === 403);
    await assert.rejects(new TenantSecrets(bao, "friend").put("card", "primary", { pan: FAKE_PAN }), /never stored/);
    const t = await bao.lookupSelf();
    assert.deepEqual(t.policies.sort(), ["default", "ted-owner"]);
    assert.ok(t.ttlSeconds > 700 * 3600, "a periodic token of 768 hours");

    // the intake page's own token: it writes profile and card items of any tenant and does nothing else (no read, list or delete, no other kind, no other path)
    assert.ok(keychain.items.get(names.intake) && keychain.items.get(names.intake) !== token, "the intake page has a token of its own");
    const intake = appBao({ keychain, cfg, as: "intake" });
    await intake.write("tenants/ann/profile/address.home", { value: FAKE_EMAIL, kind: "address", domains: [] });
    await intake.write("tenants/ann/profile/address.home", { value: FAKE_EMAIL, kind: "address", domains: [] }); // an update
    await intake.write("tenants/ann/card/primary", { pan: FAKE_PAN, expMonth: 12, expYear: 2099 });
    for (const f of [() => intake.read("tenants/ann/profile/address.home"), () => intake.list("tenants/ann/profile"), () => intake.delete("tenants/ann/profile/address.home"), () => intake.write("tenants/ann/other/x", { a: 1 }), () => intake.write("tenants/ann/profile", { a: 1 }), () => intake.raw("GET", "sys/mounts")]) await assert.rejects(f(), (e: Error) => e instanceof BaoError && e.status === 403);
    assert.deepEqual((await intake.lookupSelf()).policies.sort(), ["default", "ted-intake"]);
    await assert.rejects(bao.read("tenants/ann/profile/address.home"), (e: Error) => e instanceof BaoError && e.status === 403); // the owner's token does not reach what the page wrote for her
    const seenIntake: { ok: boolean | "warn"; detail: string }[] = [];
    await intakeCheck((ok, _w, detail = "") => seenIntake.push({ ok, detail }), { keychain, prefix, cfg: { baseUrl: "https://intake.example.test", port: 1, allowHttpLoopback: false, linkMinutes: 15, clientIpHeader: "x-forwarded-for", dir: "" }, bao: () => appBao({ keychain, cfg, as: "intake" }), probe: async () => true });
    assert.deepEqual(seenIntake.map((x) => x.ok), [true, true, true], seenIntake.map((x) => x.detail).join(" | "));

    // the doctor sees it healthy
    const seen: { ok: boolean | "warn"; detail: string }[] = [];
    await openbaoCheck((ok, _w, detail = "") => seen.push({ ok, detail }), { keychain, cfg });
    assert.equal(seen[0]!.ok, true, seen[0]!.detail);

    // the audit log: requests are there, values and the token are not (OpenBao hashes the strings)
    const audit = readFileSync(layout.audit, "utf8");
    assert.ok(audit.length > 1000 && audit.includes("tenants/owner/profile/email"), "the requests are audited by path");
    for (const [i, secret] of [FAKE_EMAIL, FAKE_PASSPORT, FAKE_PAN, token, ...shown].entries()) assert.ok(!audit.includes(secret), `no secret value in the audit log (${i})`);
    // and nothing outside the (encrypted) data and audit holds a value or the token
    const skip = new Set(["data", "audit", "bin"]);
    for (const f of allFiles(dir, skip)) {
      const text = readFileSync(f, "utf8");
      for (const secret of [FAKE_EMAIL, FAKE_PASSPORT, FAKE_PAN, token, ...shown]) assert.ok(!text.includes(secret), `${f} holds no secret`);
    }

    // a restart leaves it sealed; the keeper's unseal from the Keychain opens it; reads work again
    await stop();
    start();
    await admin.waitUp();
    assert.equal((await admin.health()).sealed, true);
    await assert.rejects(profile.read(), /sealed/);
    seen.length = 0;
    await openbaoCheck((ok, _w, detail = "") => seen.push({ ok, detail }), { keychain, cfg });
    assert.equal(seen[0]!.ok, false);
    assert.match(seen[0]!.detail, /SEALED/);
    assert.equal(await admin.unsealFromKeychain(), "unsealed");
    assert.equal(await admin.unsealFromKeychain(), "already unsealed");
    assert.equal((await profile.read()).email?.value, FAKE_EMAIL);

    // setup again is a repair: a new token, the old one revoked, nothing lost
    const lines2: string[] = [];
    await admin.setup({ out: (l) => lines2.push(l), showShares: async () => assert.fail("shares are shown once only") });
    const token2 = keychain.items.get(names.token)!;
    const oldIntake = intake;
    assert.notEqual(keychain.items.get(names.intake), undefined);
    await assert.rejects(oldIntake.write("tenants/ann/profile/after", { a: 1 }), (e: Error) => e instanceof BaoError && e.status === 403, "the intake page's old token was revoked by the repair");
    await appBao({ keychain, cfg, as: "intake" }).write("tenants/ann/profile/after", { a: 1 });
    assert.notEqual(token2, token);
    await assert.rejects(appBao({ keychain: { ...keychain, get: async () => token, set: keychain.set, remove: keychain.remove }, cfg }).read("tenants/owner/profile/email"), (e: Error) => e instanceof BaoError && e.status === 403, "the old token was revoked");
    assert.equal((await new ProfileStore(new TenantSecrets(appBao({ keychain, cfg }), "owner")).read()).email?.value, FAKE_EMAIL);
    assert.equal(await admin.renewTokens(), "not due");

    // a backup snapshot (encrypted by OpenBao) with 0600
    const snap = await admin.backup();
    assert.equal(statSync(snap).mode & 0o777, 0o600);
    assert.ok(!readFileSync(snap).includes(FAKE_EMAIL), "the snapshot holds no plain value");

    // delete what the test made, for good (with a connection that picked up the new token)
    const fresh = new TenantSecrets(appBao({ keychain, cfg }), "owner");
    assert.equal(await new CardStore(fresh).remove(), true);
    for (const k of ["email", "passport"]) assert.equal(await new ProfileStore(fresh).delete(k), true);
    assert.deepEqual(await fresh.names("profile"), []);
    assert.equal(await new CardStore(fresh).load(), undefined);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
});
