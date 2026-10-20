import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readAudit } from "../src/audit.ts";
import { ProfileStore } from "../src/modules/browse/profile.ts";
import { IntakeWriter } from "../src/intakestore.ts";
import { startFakeBao, type FakeBao } from "./fakebao.ts";

// The intake page: links (single use, expiry, bound to a person and a purpose), the form and the store, the hardening of the HTTP side, and the
// tenant's two tools. Fakes only: a fake OpenBao, fake values, fake cards (4242 4242 4242 4242).

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants.ts");
const { resolveCapabilities, toolsFor: toolsForCaps } = await import("../src/policy/capabilities.ts");
const tenantCapabilities = (ctx: { config: any; capabilities: readonly any[] }) => resolveCapabilities(ctx.capabilities, { own: ctx.config }); // (a context not in the registry: the pure step of capabilitiesOf)
const tenantTools = (ctx: { config: any; capabilities: readonly any[] }) => toolsForCaps(tenantCapabilities(ctx));
const L = await import("../src/intakelinks.ts");
const { IntakeServer } = await import("../src/intakeserver.ts");
const { createIntakeServer } = await import("../src/intaketools.ts");
const { classify } = await import("../src/policy/policy.ts");
const { intakeCheck } = await import("../src/doctor.ts");

// everything the process prints is captured, to prove that no value and no code is in it
const printed: string[] = [];
const realLog = console.log;
const realErr = console.error;
before(() => {
  console.log = (...a: unknown[]) => void printed.push(a.join(" "));
  console.error = (...a: unknown[]) => void printed.push(a.join(" "));
});
after(() => {
  console.log = realLog;
  console.error = realErr;
});

const FAKE_ADDRESS = "FAKE-ADDR Teststrasse 1, 8000 Zuerich";
const FAKE_PASSPORT = "FAKE-PASS-0042";
const FAKE_PAN = "4242 4242 4242 4242";
const FAKE_CVC = "737";

let n = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
function person(name: string, capabilities: import("../src/tenants.ts").Capability[]): import("../src/tenants.ts").TenantRecord {
  const rec = T.redeemInvite(T.mintInvite("test")!.code, { aci: fresh(), name })!;
  T.setStatus(rec.id, "active");
  for (const c of capabilities) T.grant(rec.id, c);
  return rec;
}
T.ensureOwner({ number: "+15555550114" });
const ann = person("Ann", ["intake", "profile", "card"]);
const bea = person("Bea", ["intake", "profile"]);
const cy = person("Cy", ["intake", "profile", "card"]);

let bao: FakeBao;
let clock = Date.now();
const baseLimits = { perIpPerMinute: 1000, globalPerMinute: 10_000, badCodesPerIp: 1000 };
const servers: { close(): void }[] = [];
before(async () => {
  bao = await startFakeBao();
});
after(async () => {
  servers.forEach((s) => s.close());
  await bao.close();
});

async function start(limits: Partial<typeof baseLimits> = {}, links = new L.LinkStore(mkdtempSync(join(tmpdir(), "intake-links-"))), writerBao = bao.bao({ token: bao.intakeToken })) {
  const page = new IntakeServer({ links, writer: new IntakeWriter(writerBao), now: () => clock, limits: { ...baseLimits, ...limits } });
  await new Promise<void>((r) => page.server.listen(0, "127.0.0.1", r));
  servers.push({ close: () => (page.server.closeAllConnections(), page.server.close()) });
  const base = `http://127.0.0.1:${(page.server.address() as { port: number }).port}`;
  const mint = (tenant: string, purpose: string, ttl = 15 * 60_000) => links.mint({ tenant, purpose }, ttl, clock)!;
  return { base, links, mint, page };
}

const form = (fields: Record<string, string>, csrf?: string) => new URLSearchParams({ ...(csrf ? { csrf } : {}), ...fields }).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
async function open(base: string, code: string) {
  const r = await fetch(`${base}/i/${code}`);
  const html = await r.text();
  return { r, html, csrf: r.status === 200 ? csrfOf(html) : "" };
}
async function post(base: string, code: string, fields: Record<string, string>, csrf?: string, headers: Record<string, string> = FORM) {
  const c = csrf ?? (await open(base, code)).csrf;
  const r = await fetch(`${base}/i/${code}`, { method: "POST", headers, body: form(fields, c) });
  return { r, text: await r.text() };
}
const profileFields = { key: "address.home", value: FAKE_ADDRESS, kind: "address", domains: "", labels: "" };

test("a link opens the form of its purpose, with the strict headers, no cookies and nothing about the person", async () => {
  const s = await start();
  const { r, html } = await open(s.base, s.mint(ann.id, "profile"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("set-cookie"), null, "no cookie at all");
  const csp = r.headers.get("content-security-policy")!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /style-src 'nonce-[A-Za-z0-9+/=]+'/);
  const nonce = /nonce-([^']+)'/.exec(csp)![1]!;
  assert.ok(html.includes(`<style nonce="${nonce}">`));
  assert.doesNotMatch(html, /<script|<link|https?:\/\//i, "no script, no external file, no outside address");
  assert.match(html, /name="key"[\s\S]*name="value"[\s\S]*name="domains"/);
  assert.doesNotMatch(html, new RegExp(ann.id), "the page does not say who");
  assert.doesNotMatch(html, /name="cvc"/);
});

test("a profile detail is stored for the link's person, in the shape the profile store reads, and nothing says the value", async () => {
  const s = await start();
  const code = s.mint(ann.id, "profile");
  const { r, text } = await post(s.base, code, profileFields);
  assert.equal(r.status, 200);
  assert.match(text, /address\.home \(\d+ characters\)/);
  assert.ok(!text.includes(FAKE_ADDRESS), "the value is not echoed");
  const got = await new ProfileStore(bao.secrets(ann.id)).get("address.home");
  assert.deepEqual(got, { value: FAKE_ADDRESS, kind: "address", domains: [] });
  assert.equal(bao.store.has("tenants/owner/profile/address.home"), false);
  assert.match(L.readDone(ann.id, "profile")!.stored.map((x) => `${x.name}:${x.chars}`).join(), new RegExp(`address.home:${FAKE_ADDRESS.length}`));
  const rows = readAudit((e) => e.tool === "intake_store" && e.meta?.tenant === ann.id);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.meta, { tenant: ann.id, purpose: "profile", items: [{ name: "address.home", chars: FAKE_ADDRESS.length }] });
  assert.ok(!JSON.stringify(readAudit(() => true)).includes(FAKE_ADDRESS));
  assert.ok(!printed.join("\n").includes(FAKE_ADDRESS) && !printed.join("\n").includes(code), "no log line holds the value or the code");
});

test("single use: after a store the link is gone, a replay and a second open are the same 404, and two submits at once store once", async () => {
  const s = await start();
  const code = s.mint(ann.id, "profile");
  const { csrf } = await open(s.base, code);
  const before = bao.requests.length;
  const results = await Promise.all([post(s.base, code, profileFields, csrf), post(s.base, code, { ...profileFields, key: "address.work" }, csrf)]);
  assert.deepEqual(results.map((x) => x.r.status).sort(), [200, 404]);
  assert.equal(bao.requests.slice(before).filter((q) => q.method === "POST").length, 1, "one write");
  assert.equal((await post(s.base, code, profileFields, csrf)).r.status, 404);
  assert.equal((await open(s.base, code)).r.status, 404);
  assert.equal(s.links.count(clock), 0);
});

test("expiry: a link is dead after its time, and looks like any other unknown link", async () => {
  const s = await start();
  const code = s.mint(ann.id, "profile", 60_000);
  assert.equal((await open(s.base, code)).r.status, 200);
  clock += 61_000;
  const gone = await open(s.base, code);
  const never = await open(s.base, "A".repeat(22));
  assert.equal(gone.r.status, 404);
  assert.equal(gone.html, never.html);
  assert.equal(s.links.count(clock), 0, "an expired link is removed for good");
});

test("a link is bound to its purpose and its person: a form of another purpose, a tenant field, an unknown purpose or a lost capability store nothing", async () => {
  const s = await start();
  const before = bao.store.size;
  const code = s.mint(ann.id, "profile");
  assert.equal((await post(s.base, code, { number: FAKE_PAN, expiry: "12/99", holder: "Ann Test", label: "Test", currency: "CHF" })).r.status, 400, "card fields on a profile link");
  assert.equal((await post(s.base, code, { ...profileFields, tenant: "owner" })).r.status, 400, "a tenant field is not a thing");
  assert.equal((await post(s.base, code, { ...profileFields, purpose: "card" })).r.status, 400);
  assert.equal(bao.store.size, before);
  assert.equal((await open(s.base, s.mint(ann.id, "google"))).r.status, 404, "a purpose nobody built");
  assert.equal((await open(s.base, s.mint(ann.id, "cvc"))).r.status, 404);
  assert.equal((await open(s.base, s.mint(bea.id, "card"))).r.status, 404, "Bea has no card capability");
  assert.equal((await open(s.base, s.mint("nobody", "profile"))).r.status, 404);
  // Ann's open link dies with her capability and with her suspension
  const second = s.mint(ann.id, "profile");
  T.revoke(ann.id, "profile");
  assert.equal((await open(s.base, second)).r.status, 404);
  T.grant(ann.id, "profile");
  assert.equal((await open(s.base, second)).r.status, 200);
  T.setStatus(ann.id, "suspended");
  assert.equal((await open(s.base, second)).r.status, 404);
  T.setStatus(ann.id, "active");
  // and the store of Bea's link is Bea's folder
  assert.equal((await post(s.base, s.mint(bea.id, "profile"), { ...profileFields, key: "phone", value: "+41 79 000 00 00", kind: "phone" })).r.status, 200);
  assert.ok(bao.store.has(`tenants/${bea.id}/profile/phone`) && !bao.store.has(`tenants/${ann.id}/profile/phone`));
});

test("CSRF: a post without the token, with another form's token or with a forged one stores nothing and leaves the link usable", async () => {
  const s = await start();
  const code = s.mint(ann.id, "profile");
  const other = s.mint(ann.id, "card");
  const before = bao.store.size;
  const otherToken = (await open(s.base, other)).csrf;
  for (const csrf of ["", "forged", otherToken]) {
    const { r, text } = await post(s.base, code, profileFields, csrf);
    assert.equal(r.status, 403);
    assert.ok(!text.includes(FAKE_ADDRESS));
  }
  assert.equal(bao.store.size, before);
  assert.equal((await post(s.base, code, profileFields)).r.status, 200, "the right token still works");
});

test("the body: over 16 KB (declared or chunked) is refused, and only a form content type is read", async () => {
  const s = await start();
  const code = s.mint(ann.id, "profile");
  const { csrf } = await open(s.base, code);
  const before = bao.store.size;
  const big = await fetch(`${s.base}/i/${code}`, { method: "POST", headers: FORM, body: form({ ...profileFields, value: "x".repeat(20_000) }, csrf) });
  assert.equal(big.status, 413);
  const chunked = await new Promise<number>((resolve, reject) => {
    const req = request(`${s.base}/i/${code}`, { method: "POST", headers: { ...FORM, "transfer-encoding": "chunked" } }, (res) => resolve(res.statusCode ?? 0));
    req.on("error", reject);
    for (let i = 0; i < 10; i++) req.write("a=" + "x".repeat(4000) + "&");
    req.end();
  }).catch(() => 413); // a connection cut after the refusal is the same refusal
  assert.equal(chunked, 413);
  for (const type of ["application/json", "multipart/form-data; boundary=x", "text/plain", ""]) {
    const r = await fetch(`${s.base}/i/${code}`, { method: "POST", headers: type ? { "content-type": type } : {}, body: form(profileFields, csrf) });
    assert.equal(r.status, 415, type || "no type");
  }
  const ok = await fetch(`${s.base}/i/${code}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: form({ ...profileFields, key: "body.test" }, csrf) });
  assert.equal(ok.status, 200);
  assert.equal(bao.store.size, before + 1);
});

test("an oversize header is refused by the server before any of our code", async () => {
  const s = await start();
  const status = await new Promise<number>((resolve) => {
    const req = request(`${s.base}/healthz`, { headers: { "x-padding": "x".repeat(20_000) } }, (res) => resolve(res.statusCode ?? 0));
    req.on("error", () => resolve(431));
    req.end();
  });
  assert.equal(status, 431);
});

test("every unknown path, code or method is the same 404; known paths with the wrong method are 405; /healthz says ok and nothing else", async () => {
  const s = await start();
  const used = s.mint(ann.id, "profile");
  await post(s.base, used, profileFields);
  const same = new Set<string>();
  for (const [method, path] of [["GET", "/"], ["POST", "/"], ["GET", "/admin"], ["PUT", "/admin"], ["GET", "/i"], ["GET", "/i/"], ["GET", "/i/short"], ["GET", `/i/${"B".repeat(22)}`], ["GET", `/i/${used}`], ["GET", `/i/${used}/extra`], ["GET", "/healthz/x"], ["GET", "/oauth/google/callback"], ["GET", "/%2e%2e/etc/passwd"], ["DELETE", "/state/tenants.json"], ["POST", `/i/${"C".repeat(22)}`]] as const) {
    const r = await fetch(`${s.base}${path}`, { method, headers: FORM, ...(method === "POST" ? { body: "a=b" } : {}) });
    same.add(`${r.status} ${JSON.stringify(await r.text())} ${r.headers.get("content-type")} ${r.headers.get("cache-control")}`);
  }
  assert.equal(same.size, 1, [...same].join("\n"));
  assert.match([...same][0]!, /^404 /);
  const live = s.mint(ann.id, "profile");
  for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
    const r = await fetch(`${s.base}/i/${live}`, { method });
    assert.equal(r.status, 405, method);
    assert.match(r.headers.get("allow") ?? "", /GET/);
  }
  assert.equal((await fetch(`${s.base}/healthz`, { method: "POST", headers: FORM, body: "" })).status, 405);
  const h = await fetch(`${s.base}/healthz`);
  assert.deepEqual([h.status, await h.text(), h.headers.get("cache-control")], [200, "ok\n", "no-store"]);
  assert.equal((await open(s.base, live)).r.status, 200, "none of that used the link up");
});

test("rate limits: per address, global, and a stricter one for wrong codes (even the right code waits)", async () => {
  const perIp = await start({ perIpPerMinute: 5 });
  const codes = await Promise.all(Array.from({ length: 7 }, () => fetch(`${perIp.base}/healthz`).then((r) => r.status)));
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.ok(codes.slice(5).every((c) => c === 429));
  const all = await start({ globalPerMinute: 3 });
  assert.deepEqual(await Promise.all([1, 2, 3, 4].map(() => fetch(`${all.base}/healthz`).then((r) => r.status))), [200, 200, 200, 429]);
  const bad = await start({ badCodesPerIp: 3 });
  const right = bad.mint(ann.id, "profile");
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${bad.base}/i/${"D".repeat(21)}${i}`)).status, 404);
  const blocked = await fetch(`${bad.base}/i/${right}`);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  clock += 16 * 60_000;
  assert.equal((await fetch(`${bad.base}/healthz`)).status, 200, "the window passes");
});

test("hostile fields: very long, unicode, null bytes, markup and duplicates are refused or stored as text, and never come back", async () => {
  const s = await start();
  const code = s.mint(ann.id, "profile");
  const { csrf } = await open(s.base, code);
  const before = bao.store.size;
  const refuse = async (fields: Record<string, string>, status: number, what: string) => {
    const { r, text } = await post(s.base, code, fields, csrf);
    assert.equal(r.status, status, what);
    for (const [k, v] of Object.entries(fields)) if (v !== profileFields[k as keyof typeof profileFields] && v.length > 8) assert.ok(!text.includes(v), `${what}: no value in the answer`);
    return text;
  };
  await refuse({ ...profileFields, value: "y".repeat(5000) }, 400, "very long");
  await refuse({ ...profileFields, value: `abc\u0000def` }, 400, "null byte");
  await refuse({ ...profileFields, value: "line one\nline two" }, 400, "line break");
  await refuse({ ...profileFields, key: `<script>alert("FAKE-XSS")</script>` }, 400, "markup in a key");
  await refuse({ ...profileFields, domains: `<img src=x onerror=FAKE-XSS>` }, 400, "markup in a domain");
  await refuse({ ...profileFields, kind: "<b>FAKE-KIND</b>" }, 400, "a kind that is not a choice");
  await refuse({ ...profileFields, value: FAKE_PAN.replace(/ /g, "") }, 400, "a card number in a detail");
  await refuse({ ...profileFields, key: "passport", value: FAKE_PASSPORT, kind: "id", domains: "" }, 400, "an ID number without its sites");
  const dup = await fetch(`${s.base}/i/${code}`, { method: "POST", headers: FORM, body: `${form(profileFields, csrf)}&value=second` });
  assert.equal(dup.status, 400, "a repeated field");
  assert.equal(bao.store.size, before, "nothing of that was stored");
  const lossy = "Zürich 東京 ‮RTL é 🏠"; // composed and decomposed forms, right-to-left mark, emoji
  const ok = await post(s.base, code, { ...profileFields, value: lossy }, csrf);
  assert.equal(ok.r.status, 200);
  assert.equal((await new ProfileStore(bao.secrets(ann.id)).get("address.home"))!.value, lossy.normalize("NFC"));
  assert.doesNotMatch(ok.text, /Zürich|東京/);
});

test("an ID number is stored with its sites, normalised to registered domains", async () => {
  const s = await start();
  const { r } = await post(s.base, s.mint(ann.id, "profile"), { key: "passport", value: FAKE_PASSPORT, kind: "id", domains: "https://www.sbb.ch/en, trainline.com", labels: "" });
  assert.equal(r.status, 200);
  assert.deepEqual((await new ProfileStore(bao.secrets(ann.id)).get("passport"))!.domains, ["sbb.ch", "trainline.com"]);
});

test("a friend's card: number, expiry and holder are stored; a security code is refused wherever it comes from; the owner's own card has one", async () => {
  const s = await start();
  const code = s.mint(ann.id, "card");
  const page = await open(s.base, code);
  assert.doesNotMatch(page.html, /name="cvc"|security code/i, "her form has no such field");
  assert.match(page.html, /type="password" name="number"|name="number"[^>]*type="password"|type="password"[^>]*name="number"/);
  const card = { label: "Test card", number: FAKE_PAN, expiry: "12/99", holder: "Ann Test", currency: "chf" };
  const before = bao.store.size;
  for (const extra of [{ cvc: FAKE_CVC } as Record<string, string>, { CVC: FAKE_CVC }, { cvv: FAKE_CVC }, { security_code: FAKE_CVC }]) {
    const { r, text } = await post(s.base, code, { ...card, ...extra }, page.csrf);
    assert.equal(r.status, 400);
    assert.ok(!text.includes(FAKE_CVC));
  }
  assert.equal(bao.store.size, before);
  const ok = await post(s.base, code, card, page.csrf);
  assert.equal(ok.r.status, 200);
  assert.ok(!ok.text.includes("4242"), "not even the last digits are echoed");
  const stored = bao.store.get(`tenants/${ann.id}/card/primary`)!;
  assert.deepEqual(Object.keys(stored).sort(), ["currency", "expMonth", "expYear", "holder", "label", "last4", "pan"]);
  assert.equal(stored.pan, "4242424242424242");
  assert.equal(stored.currency, "CHF");
  // the writer itself refuses a security code for her, whatever the page does
  await assert.rejects(new IntakeWriter(bao.bao({ token: bao.intakeToken })).for(ann.id)("card", "primary", { ...stored, cvc: FAKE_CVC }), /security code is never stored/);
  await assert.rejects(new IntakeWriter(bao.bao({ token: bao.intakeToken })).for(ann.id)("card", "primary", { ...stored, CVV: FAKE_CVC }), /security code is never stored/);
  // a bad card: not valid, expired, not a number
  for (const bad of [{ number: "4242 4242 4242 4241" }, { expiry: "01/20" }, { expiry: "soon" }, { currency: "CHFF" }, { number: "abcd" }, { holder: "" }]) assert.equal((await post(s.base, s.mint(ann.id, "card"), { ...card, ...bad })).r.status, 400, JSON.stringify(bad));
  // the owner's own card
  const mine = s.mint("owner", "card");
  const own = await open(s.base, mine);
  assert.match(own.html, /name="cvc"/);
  assert.equal((await post(s.base, mine, { ...card, cvc: "73" }, own.csrf)).r.status, 400);
  assert.equal((await post(s.base, mine, { ...card, cvc: FAKE_CVC }, own.csrf)).r.status, 200);
  assert.equal(bao.store.get("tenants/owner/card/primary")!.cvc, FAKE_CVC);
  assert.ok(!printed.join("\n").includes(FAKE_CVC) && !printed.join("\n").includes("4242424242424242"));
});

test("if the store is down nothing is saved, the answer says so without a detail, and the same link works again", async () => {
  const s = await start();
  const code = s.mint(ann.id, "profile");
  const { csrf } = await open(s.base, code);
  const before = bao.store.size;
  bao.mode.down = true;
  const failed = await post(s.base, code, profileFields, csrf);
  bao.mode.down = false;
  assert.equal(failed.r.status, 503);
  assert.match(failed.text, /Nothing was saved/);
  assert.ok(!failed.text.includes(FAKE_ADDRESS));
  assert.equal(bao.store.size, before);
  assert.deepEqual(readAudit((e) => e.tool === "intake_store" && e.decision === "failed").at(-1)!.meta, { tenant: ann.id, purpose: "profile" });
  assert.equal((await post(s.base, code, profileFields, csrf)).r.status, 200);
  assert.ok(!printed.join("\n").includes(FAKE_ADDRESS));
});

test("the intake token is write-only: it creates and updates profile and card items and can read, list, delete or reach nothing else", async () => {
  const w = bao.bao({ token: bao.intakeToken });
  await w.write("tenants/ann/profile/x", { value: "FAKE" });
  await w.write("tenants/ann/profile/x", { value: "FAKE2" });
  await w.write("tenants/ann/card/primary", { pan: "FAKE" });
  for (const f of [() => w.read("tenants/ann/profile/x"), () => w.list("tenants/ann/profile"), () => w.delete("tenants/ann/profile/x"), () => w.write("tenants/ann/other/x", { a: 1 }), () => w.write("sys/x", { a: 1 }), () => w.write("tenants/ann/profile", { a: 1 })]) {
    await assert.rejects(f(), (e: Error) => (e as { status?: number }).status === 403);
  }
  // the runtime token is separate: it reads its own tenant, not through the intake token
  assert.deepEqual(await bao.secrets("ann").get("profile", "x"), { value: "FAKE2" });
});

test("the minted link: a tenant's tool, offered only with INTAKE_BASE_URL, the intake capability and a purpose she may use", async () => {
  const cfg = settings.intake as { baseUrl: string | undefined; allowHttpLoopback: boolean };
  const was = { ...cfg };
  const caps = (...c: import("../src/tenants.ts").Capability[]) => ({ config: {}, capabilities: c });
  const has = (c: ReturnType<typeof caps>) => [...tenantTools(c)].filter((t) => t.startsWith("mcp__intake__"));
  try {
    cfg.baseUrl = undefined;
    assert.deepEqual(has(caps("chat", "intake", "profile", "card")), [], "no INTAKE_BASE_URL: no tool");
    cfg.baseUrl = "http://intake.example.test";
    assert.deepEqual(has(caps("intake", "profile")), [], "plain http is not offered");
    assert.match(L.baseUrlProblem(cfg)!, /https/);
    cfg.baseUrl = "http://127.0.0.1:8787";
    assert.deepEqual(has(caps("intake", "profile")), [], "loopback http only with the test switch");
    cfg.allowHttpLoopback = true;
    assert.equal(has(caps("intake", "profile")).length, 2);
    cfg.allowHttpLoopback = false;
    cfg.baseUrl = "https://intake.example.test/";
    assert.equal(has(caps("intake", "profile")).length, 2);
    assert.deepEqual(has(caps("profile", "card")), [], "profile and card alone do not switch it on");
    assert.deepEqual(has(caps("intake", "chat")), [], "intake alone has no purpose");
    assert.deepEqual(has(caps("intake", "mail")), []);
    assert.equal(classify("mcp__intake__get_setup_link", { purpose: "profile" }, "group", "/n", tenantTools(caps("intake", "profile"))), "allow");
    assert.equal(classify("mcp__intake__get_setup_link", { purpose: "profile" }, "group", "/n", tenantTools(caps("chat"))), "deny");
    assert.equal(classify("mcp__intake__get_setup_link", { purpose: "profile" }, "chat"), "deny", "not a tool of the owner's chat");
    assert.equal(classify("mcp__intake__get_setup_link", { purpose: "profile" }, "background"), "deny");

    // the tool itself, over an in-process MCP connection
    const links = new L.LinkStore(mkdtempSync(join(tmpdir(), "intake-tool-")));
    const server = createIntakeServer({ id: cy.id }, links);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (server.instance as { connect(t: unknown): Promise<void> }).connect(b);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(a);
    const call = async (name: string, purpose: string) => {
      const out = (await client.callTool({ name, arguments: { purpose } })) as { content: { text: string }[]; isError?: boolean };
      return { text: out.content[0]!.text, error: !!out.isError };
    };
    const made = await call("get_setup_link", "profile");
    assert.equal(made.error, false);
    const url = /https:\/\/intake\.example\.test\/i\/([A-Za-z0-9_-]{22})/.exec(made.text);
    assert.ok(url, made.text);
    assert.deepEqual(links.peek(url![1]!), { tenant: cy.id, purpose: "profile" });
    assert.ok(!made.text.includes("//i/"), "no doubled slash");
    assert.match(readFileSync(links.dir + "/" + readdirSync(links.dir)[0]!, "utf8"), /"purpose":"profile"/);
    assert.ok(!readdirSync(links.dir).some((f) => f.includes(url![1]!)), "only a hash is kept");
    assert.equal(links.count(), 1);
    await call("get_setup_link", "profile");
    assert.equal(links.count(), 1, "a new link replaces the old one of the same purpose");
    assert.equal((await call("get_setup_link", "google")).error, true, "a purpose nobody built");
    assert.equal((await call("get_setup_link", "cvc")).error, true);
    assert.match((await call("setup_status", "card")).text, /Nothing saved yet|still open/);
    L.recordDone(cy.id, "card", [{ name: "card", chars: 16 }]);
    assert.match((await call("setup_status", "card")).text, /card \(16 characters\)/);
    cfg.baseUrl = undefined;
    assert.match((await call("get_setup_link", "profile")).text, /not available yet/);
    T.revoke(cy.id, "card");
    assert.equal((await call("get_setup_link", "card")).error, true, "a revoked purpose is refused at once");
    T.grant(cy.id, "card");
    await client.close();
  } finally {
    Object.assign(cfg, was);
  }
});

test("links: hashed at rest, 128 bits, one open link per person and purpose, a bounded number open, constant-time compare, release puts a claim back", () => {
  const dir = mkdtempSync(join(tmpdir(), "intake-store-"));
  const links = new L.LinkStore(dir);
  const t0 = 1_000_000;
  const code = links.mint({ tenant: "ann", purpose: "profile" }, 1000, t0)!;
  assert.match(code, L.LINK_CODE);
  assert.ok(readdirSync(dir).every((f) => !f.includes(code)) && readdirSync(dir).every((f) => !readFileSync(join(dir, f), "utf8").includes(code)));
  assert.equal(links.peek(code, t0 + 999)?.tenant, "ann");
  assert.equal(links.peek(code, t0 + 1000), undefined, "expired at its time");
  const second = links.mint({ tenant: "ann", purpose: "profile" }, 1000, t0)!;
  const claim = links.claim(second, t0)!;
  assert.equal(links.claim(second, t0), undefined, "a claimed link cannot be claimed again");
  assert.equal(links.peek(second, t0), undefined, "nor opened while it is being stored");
  claim.release();
  assert.ok(links.peek(second, t0));
  links.claim(second, t0)!.burn();
  assert.equal(links.peek(second, t0), undefined);
  assert.equal(links.claim("not-a-code", t0), undefined);
  for (let i = 0; i < 200; i++) assert.ok(links.mint({ tenant: `t${i}`, purpose: "profile" }, 1000, t0));
  assert.equal(links.mint({ tenant: "one-more", purpose: "profile" }, 1000, t0), undefined, "at most 200 open");
  assert.ok(links.mint({ tenant: "t3", purpose: "profile" }, 1000, t0), "but a person's own new link replaces her old one");
  assert.equal(existsSync(join(dir, "nothing")), false);
});

test("doctor: the page is off without INTAKE_BASE_URL, and a token that can read is reported", async () => {
  const lines: { ok: boolean | "warn"; what: string; detail: string }[] = [];
  const line = (ok: boolean | "warn", what: string, detail = "") => void lines.push({ ok, what, detail });
  const keychain = { get: async () => "fake-intake-token", set: async () => {}, remove: async () => true };
  const off = { baseUrl: undefined, port: 1, allowHttpLoopback: false, linkMinutes: 15, dir: "" };
  await intakeCheck(line, { cfg: off, keychain, bao: () => bao.bao({ token: bao.intakeToken }) });
  assert.equal(lines[0]!.what, "intake page: off");
  assert.equal(lines[0]!.ok, true);
  lines.length = 0;
  await intakeCheck(line, { cfg: { ...off, baseUrl: "http://example.test" }, keychain, bao: () => bao.bao({ token: bao.intakeToken }) });
  assert.equal(lines[0]!.ok, false);
  assert.match(lines[0]!.detail, /https/);
  lines.length = 0;
  await intakeCheck(line, { cfg: { ...off, baseUrl: "https://intake.example.test" }, keychain, bao: () => bao.bao({ token: bao.token }), probe: async () => false });
  assert.deepEqual(lines.map((l) => l.ok), [true, false, "warn"], "the owner's runtime token is not the write-only one");
  assert.match(lines[1]!.detail, /more than write|besides|beyond/);
  assert.match(lines[2]!.detail, /npm run intake/);
});
