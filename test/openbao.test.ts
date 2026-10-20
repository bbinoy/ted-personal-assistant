import { test } from "node:test";
import assert from "node:assert/strict";
import { openbaoCheck } from "../src/doctor.ts";
import type { Keychain } from "../src/secrets/keychain.ts";
import { BaoError, OpenBao, checkPath } from "../src/secrets/openbao.ts";
import { appBao, ITEM_NAME, keychainNames, SecretsError, TenantSecrets, TENANT_ID } from "../src/secrets/secrets.ts";
import { settings } from "../src/settings.ts";
import { startFakeBao } from "./fakebao.ts";

// The client and the tenant layer against an in-process fake of OpenBao's HTTP API. Obviously fake values only.
const FAKE = "FAKE-SECRET-VALUE-1234";

test("client: write, read, list and delete an item; a delete removes it for good; a missing item is undefined, a missing folder is empty", async () => {
  const fake = await startFakeBao();
  const bao = fake.bao();
  assert.equal(await bao.read("tenants/owner/profile/x"), undefined);
  assert.deepEqual(await bao.list("tenants/owner/profile"), []);
  await bao.write("tenants/owner/profile/x", { value: FAKE, n: 3, list: ["a", "b"] });
  assert.deepEqual(await bao.read("tenants/owner/profile/x"), { value: FAKE, n: 3, list: ["a", "b"] });
  await bao.write("tenants/owner/profile/y", { value: "2" });
  await bao.write("tenants/owner/other/z", { value: "3" });
  assert.deepEqual(await bao.list("tenants/owner/profile"), ["x", "y"]);
  assert.deepEqual(await bao.list("tenants/owner"), ["other/", "profile/"], "a folder name ends with a slash");
  assert.equal(await bao.delete("tenants/owner/profile/x"), true);
  assert.equal(await bao.delete("tenants/owner/profile/x"), false);
  assert.equal(await bao.read("tenants/owner/profile/x"), undefined);
  // the token goes in a header, the value in the body, nothing in the URL
  assert.ok(fake.requests.every((r) => !r.path.includes(FAKE) && r.token === fake.token));
  await fake.close();
});

test("client: it fails closed with a plain message that holds no value, token or server text", async () => {
  const fake = await startFakeBao();
  await fake.bao().write("tenants/owner/profile/x", { value: FAKE });
  const check = async (mode: Partial<typeof fake.mode>, re: RegExp, o: { token?: string } = {}) => {
    Object.assign(fake.mode, { down: false, sealed: false, garbage: false, delayMs: 0 }, mode);
    await assert.rejects(fake.bao({ timeoutMs: 100, ...o }).read("tenants/owner/profile/x"), (e: Error) => e instanceof BaoError && re.test(e.message) && ![FAKE, fake.token, "permission denied", "Vault is sealed"].some((v) => e.message.includes(v)), JSON.stringify(mode));
  };
  await check({ down: true }, /not reachable/);
  await check({ delayMs: 600 }, /not reachable/); // a timeout
  await check({ sealed: true }, /sealed/);
  await check({ garbage: true }, /not JSON/);
  await check({}, /refused/, { token: "unknown-token" });
  // no token at all (nothing in the Keychain)
  const none = new OpenBao({ addr: fake.url, mount: "ted", token: async () => { throw new Error("x"); } });
  await assert.rejects(none.read("tenants/owner/profile/x"), /no OpenBao token/);
  await fake.close();
});

test("client: only a loopback address, only a plain path; ../ and odd names are refused before any request", async () => {
  const token = async () => "t";
  for (const addr of ["https://example.com:8200", "https://10.0.0.5:8200", "https://127.0.0.1.evil.com:8200", "not an address", "ftp://127.0.0.1"]) assert.throws(() => new OpenBao({ addr, mount: "ted", token }), BaoError, addr);
  assert.doesNotThrow(() => new OpenBao({ addr: "https://127.0.0.1:8200", mount: "ted", token }));
  assert.throws(() => new OpenBao({ addr: "https://127.0.0.1:8200", mount: "../sys", token }), BaoError);
  for (const bad of ["", "tenants/../sys/x", "tenants//x/../y", "tenants/owner/ a", "tenants/owner/%2e%2e/x", "a/b/c/d/e/f/g", "tenants/owner/.hidden"]) assert.throws(() => checkPath(bad), BaoError, bad);
  const fake = await startFakeBao();
  await assert.rejects(fake.bao().read("tenants/owner/../friend/profile/x"), BaoError);
  assert.equal(fake.requests.length, 0);
  await fake.close();
});

test("tenant layer: names are checked, folders are the tenant's own, and a tenant id cannot climb", async () => {
  const fake = await startFakeBao();
  assert.throws(() => new TenantSecrets(fake.bao(), "../owner"), SecretsError);
  assert.throws(() => new TenantSecrets(fake.bao(), "Owner"), SecretsError);
  assert.ok(TENANT_ID.test("owner") && !TENANT_ID.test("owner/x") && ITEM_NAME.test("loyalty.sbb") && !ITEM_NAME.test("../x"));
  const s = fake.secrets();
  await assert.rejects(s.put("profile", "../friend/x", { value: FAKE }), SecretsError);
  await assert.rejects(s.put("profile", "UPPER", { value: FAKE }), SecretsError);
  await assert.rejects(s.put("passwords" as never, "x", { value: FAKE }), SecretsError);
  await s.put("profile", "ok", { value: FAKE });
  assert.deepEqual(await s.names("profile"), ["ok"]);
  assert.deepEqual([...fake.store.keys()], ["tenants/owner/profile/ok"]);
  await fake.close();
});

test("the app's connection: the token comes from the Keychain once and again after a few minutes, never from the environment", async () => {
  const fake = await startFakeBao();
  const asked: string[] = [];
  const keychain: Keychain = { get: async (svc) => (asked.push(svc), fake.token), set: async () => {}, remove: async () => true };
  const cfg = { ...settings.openbao, addr: fake.url, caCert: "/nonexistent/cert.pem" };
  const bao = appBao({ keychain, cfg });
  await new TenantSecrets(bao).put("profile", "a", { value: FAKE });
  await new TenantSecrets(bao).get("profile", "a");
  assert.deepEqual(asked, [keychainNames(cfg.keychainPrefix).token], "one Keychain read for two calls");
  // https needs the pinned certificate: without it the app does not connect at all
  assert.throws(() => appBao({ keychain, cfg: { ...cfg, addr: "https://127.0.0.1:8200" } }), /pinned certificate/);
  await fake.close();
});

// ---- the doctor ----

const lines = async (o: Parameters<typeof openbaoCheck>[1]) => {
  const out: { ok: boolean | "warn"; what: string; detail: string }[] = [];
  await openbaoCheck((ok, what, detail = "") => out.push({ ok, what, detail }), o);
  return out[0]!;
};

test("doctor: unsealed and narrow is OK; sealed, unreachable, a broad token and a root token are failures; no token is a warning", async () => {
  const fake = await startFakeBao();
  const cfg = { ...settings.openbao, addr: fake.url, caCert: "/nonexistent" };
  const withToken = (t: string | undefined): Keychain => ({ get: async () => t, set: async () => {}, remove: async () => true });
  const mk = (tenant: string) => () => new OpenBao({ addr: fake.url, mount: "ted", token: async () => fake.tokenFor(tenant), timeoutMs: 300 });
  const base = { cfg, keychain: withToken(fake.token), bao: mk("owner") };

  let r = await lines(base);
  assert.equal(r.ok, true);
  assert.match(r.detail, /unsealed, token limited to tenants\/owner\/.*30 day/);

  fake.mode.ttl = 86_400;
  assert.equal((await lines(base)).ok, "warn", "a token close to its end");
  fake.mode.ttl = 30 * 86_400;

  fake.mode.policies = ["default", "ted-owner", "admin"];
  r = await lines(base);
  assert.equal(r.ok, false);
  assert.match(r.detail, /policies besides/);
  fake.mode.policies = ["root"];
  assert.match((await lines(base)).detail, /ROOT token/);
  fake.mode.policies = ["default", "ted-owner"];

  fake.mode.sealed = true;
  r = await lines(base);
  assert.equal(r.ok, false);
  assert.match(r.detail, /SEALED/);
  fake.mode.sealed = false;

  fake.mode.down = true;
  r = await lines(base);
  assert.equal(r.ok, false, "set up but not answering is a failure");
  assert.match(r.detail, /not reachable/);
  r = await lines({ ...base, keychain: withToken(undefined) });
  assert.equal(r.ok, "warn", "never set up: only a warning");
  assert.match(r.detail, /not set up/);
  fake.mode.down = false;

  r = await lines({ ...base, keychain: withToken(undefined) });
  assert.equal(r.ok, "warn");
  assert.match(r.detail, /no app token/);
  await fake.close();
});
