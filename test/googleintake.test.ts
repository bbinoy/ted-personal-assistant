import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeBao } from "./fakebao.ts";

// "Connect Google" on the intake page (googleoauth.ts, intakeserver.ts): the sign-in link made with PKCE and a state bound to the one-time link, the callback that
// exchanges the code at a FAKE token endpoint and stores the refresh token in HER OpenBao path through the write-only token, the single use of link and state, and that
// the token is in no log, audit row, page or tool answer. Fakes only; the tokens are obviously fake strings.
const dataDir = mkdtempSync(join(tmpdir(), "google-intake-"));
process.env.HARNESS_DATA_DIR = dataDir;
process.env.GOOGLE_OAUTH_CLIENT_ID = "fake-client-id.example";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "fake-client-secret-not-real";
process.env.INTAKE_BASE_URL = "http://127.0.0.1:9";
process.env.INTAKE_ALLOW_HTTP_LOOPBACK = "on";

const { settings } = await import("../src/core/settings.ts");
const { startFakeBao } = await import("./fakebao.ts");
const { readAudit } = await import("../src/core/audit.ts");
const { IntakeWriter } = await import("../src/intake/intakestore.ts");
const T = await import("../src/tenants/tenants.ts");
const L = await import("../src/intake/intakelinks.ts");
const { IntakeServer } = await import("../src/intake/intakeserver.ts");
const { googleProvider } = await import("../src/intake/googleoauth.ts");
const { OAuthFlows, pkce, bindingCookie } = await import("../src/intake/oauth.ts");
const { createIntakeServer } = await import("../src/intake/intaketools.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { TenantSecrets } = await import("../src/secrets/secrets.ts");

const REFRESH = "fake-refresh-token-0123456789-not-real";
const ACCESS = "fake-access-token-9876543210-not-real";
const AUTH_CODE = "fake-authorization-code-4711";
const idToken = (email: string) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url")}.sig`;
const ALL_SCOPES = [...settings.google.scopes];

// ---- the fake token endpoint ----
interface TokenCall { body: URLSearchParams }
const tokenCalls: TokenCall[] = [];
let tokenMode: "ok" | "no-refresh" | "missing-scope" | "refused" = "ok";
let tokenServer: Server;
let tokenUrl = "";
before(async () => {
  tokenServer = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      tokenCalls.push({ body: new URLSearchParams(b) });
      if (tokenMode === "refused") return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
      const scope = tokenMode === "missing-scope" ? ALL_SCOPES.slice(0, -1).join(" ") : ALL_SCOPES.join(" ");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: ACCESS, expires_in: 3599, ...(tokenMode === "no-refresh" ? {} : { refresh_token: REFRESH }), scope, token_type: "Bearer", id_token: idToken("Anna@Example.com") }));
    });
  }).unref();
  await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r));
  tokenUrl = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`;
});

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

let n = 0;
function person(name: string, capabilities: import("../src/tenants/tenants.ts").Capability[]): import("../src/tenants/tenants.ts").TenantRecord {
  const rec = T.addTenant({ aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
  T.setStatus(rec.id, "active");
  for (const c of capabilities) T.grant(rec.id, c);
  return rec;
}
T.ensureOwner({ number: "+15555550114" });
const anna = person("Anna", ["intake", "google", "mail", "calendar"]);
const noGoogle = person("Nora", ["intake", "profile"]);

let bao: FakeBao;
const servers: { close(): void }[] = [];
before(async () => {
  bao = await startFakeBao();
});
after(async () => {
  servers.forEach((s) => s.close());
  await bao.close();
});

async function start() {
  const links = new L.LinkStore(mkdtempSync(join(tmpdir(), "google-links-")));
  let base = "";
  const oauth = new OAuthFlows({ providers: [googleProvider(() => ({ clientId: "fake-client-id.example", clientSecret: "fake-client-secret-not-real", authUrl: "https://accounts.example.test/o/oauth2/v2/auth", tokenUrl, scopes: ALL_SCOPES }))], baseUrl: () => base });
  const page = new IntakeServer({ links, writer: new IntakeWriter(bao.bao({ token: bao.intakeToken })), oauth, limits: { perIpPerMinute: 1000, globalPerMinute: 10_000, badCodesPerIp: 1000 } });
  await new Promise<void>((r) => page.server.listen(0, "127.0.0.1", r));
  servers.push({ close: () => (page.server.closeAllConnections(), page.server.close()) });
  base = `http://127.0.0.1:${(page.server.address() as AddressInfo).port}`;
  return { base, links, page, mint: (tenant: string, purpose = "google") => links.mint({ tenant, purpose }, 15 * 60_000)! };
}

// Opens the link and returns the sign-in address on the page, as the browser would follow it.
async function signIn(base: string, code: string) {
  const r = await fetch(`${base}/i/${code}`);
  const html = await r.text();
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  const url = href ? new URL(href) : undefined;
  const setCookie = r.headers.get("set-cookie") ?? undefined;
  if (url && setCookie) cookieOfState.set(url.searchParams.get("state")!, setCookie.split(";")[0]!);
  return { r, html, url, setCookie };
}
// The browser that was shown the link sends back the cookie the page set for that state, unless a test says otherwise (`cookie`: another browser's, or "" for none).
const cookieOfState = new Map<string, string>();
const callback = (base: string, params: Record<string, string>, cookie?: string) => {
  const c = cookie ?? cookieOfState.get(params.state ?? "");
  return fetch(`${base}/oauth/google/callback?${new URLSearchParams(params)}`, c ? { headers: { cookie: c } } : {});
};
const GRANT = () => bao.store.get(`tenants/${anna.id}/google/oauth`);

test("google: the link opens a sign-in with offline access, PKCE (S256), the scopes and a state; the callback exchanges the code, stores the grant in HER path and says connected", async () => {
  const s = await start();
  const code = s.mint(anna.id);
  const { r, html, url } = await signIn(s.base, code);
  assert.equal(r.status, 200);
  assert.match(html, /Connect Google/);
  assert.ok(url);
  assert.equal(url!.origin + url!.pathname, "https://accounts.example.test/o/oauth2/v2/auth");
  const q = url!.searchParams;
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("redirect_uri"), `${s.base}/oauth/google/callback`);
  assert.equal(q.get("client_id"), "fake-client-id.example");
  assert.equal(q.get("scope"), ALL_SCOPES.join(" "));
  assert.ok(!q.has("client_secret"), "the secret never goes to the browser");
  assert.match(q.get("state")!, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(html, new RegExp(code), "the state is not the link's code");

  const done = await callback(s.base, { code: AUTH_CODE, state: q.get("state")! });
  const text = await done.text();
  assert.equal(done.status, 200);
  assert.match(text, /Google is connected as anna@example\.com/, "the account is shown so that a mismatch is visible");
  // the token endpoint was asked with the PKCE verifier of this flow, the secret and the same redirect address
  assert.equal(tokenCalls.length, 1);
  const body = tokenCalls[0]!.body;
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), AUTH_CODE);
  assert.equal(body.get("client_secret"), "fake-client-secret-not-real");
  assert.equal(body.get("redirect_uri"), q.get("redirect_uri"));
  assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), q.get("code_challenge"), "the verifier matches the challenge that was sent");
  // stored under HER path, with her address (lower-cased) from the id token
  const grant = GRANT() as Record<string, unknown>;
  assert.equal(grant.refresh_token, REFRESH);
  assert.equal(grant.email, "anna@example.com");
  assert.equal(bao.store.has("tenants/owner/google/oauth"), false);
  assert.equal(bao.requests.filter((x) => x.method === "POST").every((x) => x.token === bao.intakeToken), true, "written only with the write-only token");
  // the link is burnt and the status is "connected", never the token
  assert.equal((await fetch(`${s.base}/i/${code}`)).status, 404);
  assert.equal(L.readDone(anna.id, "google")?.stored.length, 1);
  // nothing prints, audits or answers with the token, the access token, the authorization code, the state or the link code
  const everything = [text, printed.join("\n"), JSON.stringify(readAudit(() => true)), JSON.stringify(L.readDone(anna.id, "google"))].join("\n");
  for (const secret of [REFRESH, ACCESS, AUTH_CODE, q.get("state")!, code, "fake-client-secret-not-real"]) assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 12)}`);
  for (const secret of [REFRESH, ACCESS, AUTH_CODE, code, "fake-client-secret-not-real"]) assert.ok(!html.includes(secret), "the sign-in page holds none of them (only the state, in the address of the link to Google)");
  const rows = readAudit((e) => e.tool === "intake_store" && e.meta?.tenant === anna.id);
  assert.deepEqual(rows[0]!.meta!.purpose, "google");
});

test("google: the binding cookie is HttpOnly, SameSite=Lax, scoped to the callback path and not Secure on http; a callback from a browser without it or with another browser's is refused (nothing exchanged, nothing stored, the state is used up)", async () => {
  const s = await start();
  const eve = await signIn(s.base, s.mint(anna.id));
  assert.match(eve.setCookie!, /^ted_oauth_google=[A-Za-z0-9_-]{43}; Path=\/oauth\/google\/callback; HttpOnly; SameSite=Lax; Max-Age=600$/);
  const victim = await signIn(s.base, s.mint(anna.id)); // another page view: a different binding
  const stateOfEve = eve.url!.searchParams.get("state")!;
  const calls = tokenCalls.length;
  bao.store.delete(`tenants/${anna.id}/google/oauth`);
  // the consent address passed on: the other browser has no cookie, or has its own
  assert.equal((await callback(s.base, { code: AUTH_CODE, state: stateOfEve }, "")).status, 404, "no cookie");
  assert.equal(tokenCalls.length, calls);
  const again = await signIn(s.base, s.mint(anna.id));
  const st2 = again.url!.searchParams.get("state")!;
  const other = victim.setCookie!.split(";")[0]!;
  assert.equal((await callback(s.base, { code: AUTH_CODE, state: st2 }, other)).status, 404, "another browser's cookie");
  assert.equal((await callback(s.base, { code: AUTH_CODE, state: st2 })).status, 404, "and the state is used up either way");
  assert.equal(tokenCalls.length, calls, "nothing exchanged");
  assert.equal(GRANT(), undefined, "nothing stored");
  const text = await (await callback(s.base, { code: AUTH_CODE, state: stateOfEve }, "")).text();
  assert.equal(text, "Not found\n");
  const bindings = [eve.setCookie!, victim.setCookie!].map((c) => c.split(";")[0]!.split("=")[1]!);
  const everything = [text, eve.html, printed.join("\n"), JSON.stringify(readAudit(() => true))].join("\n");
  for (const b of bindings) assert.ok(!everything.includes(b), "the binding is in no page, log or audit row");
});

test("google: a replayed callback, a state from nowhere and a state of a link that was used all get the page's one 404, and nothing is exchanged or stored", async () => {
  const s = await start();
  const code = s.mint(anna.id);
  const { url } = await signIn(s.base, code);
  const state = url!.searchParams.get("state")!;
  const calls = tokenCalls.length;
  bao.store.delete(`tenants/${anna.id}/google/oauth`);
  assert.equal((await callback(s.base, { code: AUTH_CODE, state: "A".repeat(43) })).status, 404, "a state that was never made");
  assert.equal((await callback(s.base, { code: AUTH_CODE, state: "short" })).status, 404);
  assert.equal((await callback(s.base, { code: AUTH_CODE })).status, 404, "no state at all");
  assert.equal(tokenCalls.length, calls, "no exchange");
  assert.equal((await callback(s.base, { code: AUTH_CODE, state })).status, 200, "the real one still works once");
  assert.equal((await callback(s.base, { code: AUTH_CODE, state })).status, 404, "replay");
  // a second page view makes a new state; the first one stops working
  const code2 = s.mint(anna.id);
  const first = (await signIn(s.base, code2)).url!.searchParams.get("state")!;
  const second = (await signIn(s.base, code2)).url!.searchParams.get("state")!;
  assert.notEqual(first, second);
  const n = tokenCalls.length;
  assert.equal((await callback(s.base, { code: AUTH_CODE, state: first })).status, 404);
  assert.equal(tokenCalls.length, n);
  // a state made for one link does not finish another person's link: the link must still be open and hers
  const other = s.mint(anna.id);
  const st = (await signIn(s.base, other)).url!.searchParams.get("state")!;
  s.links.claim(other)!.burn(); // the link was used elsewhere meanwhile
  assert.equal((await callback(s.base, { code: AUTH_CODE, state: st })).status, 404);
  assert.equal(tokenCalls.length, n);
});

test("google: wrong purpose and no capability: a profile link is a form (no sign-in), a person without google cannot open a google link, and revoking it kills a flow in progress", async () => {
  const s = await start();
  const profile = s.mint(anna.id, "profile");
  assert.equal((await fetch(`${s.base}/i/${profile}`)).status, 404, "anna has no profile capability: not that purpose");
  const nora = s.mint(noGoogle.id, "google");
  assert.equal((await fetch(`${s.base}/i/${nora}`)).status, 404, "no google capability");
  const code = s.mint(anna.id);
  const state = (await signIn(s.base, code)).url!.searchParams.get("state")!;
  T.revoke(anna.id, "google");
  const calls = tokenCalls.length;
  assert.equal((await callback(s.base, { code: AUTH_CODE, state })).status, 404);
  assert.equal(tokenCalls.length, calls);
  T.grant(anna.id, "google");
  // POSTing to a sign-in link is not a thing
  const again = s.mint(anna.id);
  assert.equal((await fetch(`${s.base}/i/${again}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "x=1" })).status, 405);
});

test("google: she says no, Google refuses the code, no refresh token comes back, or a permission was unticked: nothing is stored and the same link can be used again", async () => {
  const s = await start();
  const code = s.mint(anna.id);
  const attempt = async (mode: typeof tokenMode, params: (state: string) => Record<string, string>) => {
    tokenMode = mode;
    const state = (await signIn(s.base, code)).url!.searchParams.get("state")!;
    bao.store.delete(`tenants/${anna.id}/google/oauth`);
    const r = await callback(s.base, params(state));
    const text = await r.text();
    assert.equal(r.status, 400, mode);
    assert.equal(GRANT(), undefined, `${mode}: nothing stored`);
    assert.ok(!text.includes(REFRESH) && !text.includes(AUTH_CODE) && !text.includes("invalid_grant"), "fixed sentences only");
    assert.equal(s.links.isOpen({ tenant: anna.id, purpose: "google" }), true, `${mode}: the link is still open`);
    return text;
  };
  await attempt("ok", (state) => ({ error: "access_denied", state }));
  await attempt("refused", (state) => ({ code: AUTH_CODE, state }));
  assert.match(await attempt("no-refresh", (state) => ({ code: AUTH_CODE, state })), /myaccount\.google\.com\/permissions/);
  assert.match(await attempt("missing-scope", (state) => ({ code: AUTH_CODE, state })), /Not every permission/);
  tokenMode = "ok";
  const state = (await signIn(s.base, code)).url!.searchParams.get("state")!;
  assert.equal((await callback(s.base, { code: AUTH_CODE, state })).status, 200, "and then it works");
  assert.ok(GRANT());
});

test("google: the page says it is not available when the client is not set up, and the callback address answers GET only", async () => {
  const links = new L.LinkStore(mkdtempSync(join(tmpdir(), "google-links-")));
  const off = new OAuthFlows({ providers: [googleProvider(() => ({ clientId: undefined, clientSecret: undefined, authUrl: "x", tokenUrl, scopes: [] }))], baseUrl: () => "http://x" });
  const page = new IntakeServer({ links, writer: new IntakeWriter(bao.bao({ token: bao.intakeToken })), oauth: off });
  await new Promise<void>((r) => page.server.listen(0, "127.0.0.1", r));
  servers.push({ close: () => (page.server.closeAllConnections(), page.server.close()) });
  const base = `http://127.0.0.1:${(page.server.address() as AddressInfo).port}`;
  const code = links.mint({ tenant: anna.id, purpose: "google" }, 60_000)!;
  assert.equal((await fetch(`${base}/i/${code}`)).status, 503);
  assert.equal((await fetch(`${base}/oauth/google/callback`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/oauth/google/other`)).status, 404);
});

test("google: pkce and the consent address are well formed", async () => {
  const p = pkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(createHash("sha256").update(p.verifier).digest("base64url"), p.challenge);
  const flows = new OAuthFlows({ providers: [googleProvider(() => ({ clientId: "c", clientSecret: "s", authUrl: "https://a.example/auth", tokenUrl: "t", scopes: ["a", "b"] }))], baseUrl: () => "https://ted.example" });
  const u = new URL((await flows.begin("google", "LINKCODE", "anna")).url);
  assert.equal(u.searchParams.get("redirect_uri"), "https://ted.example/oauth/google/callback");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("scope"), "a b");
  assert.equal(flows.secure(), true, "https: the binding cookie is Secure");
  assert.match(bindingCookie("google", "x", flows.secure(), 600), /; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
});

test("google: the chat tool offers the google purpose only with the capability and a configured client, and reports 'connected', never a token", async () => {
  const links = new L.LinkStore(mkdtempSync(join(tmpdir(), "google-links-")));
  assert.deepEqual(L.purposesFor(["intake", "google"]), ["google"]);
  assert.deepEqual(L.purposesFor(["intake"]), []);
  assert.ok(L.intakeToolsFor(["intake", "google"]).length > 0);
  const bea = person("Bea", ["intake", "google"]);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createIntakeServer({ id: bea.id }, links).instance.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const text = async (name: string, purpose: string) => ((await client.callTool({ name, arguments: { purpose } })) as { content: { text: string }[] }).content[0]!.text;
  const link = await text("get_setup_link", "google");
  assert.match(link, /http:\/\/127\.0\.0\.1:9\/i\/[A-Za-z0-9_-]{22}/);
  assert.match(link, /Connect Google/);
  assert.match(await text("setup_status", "google"), /Not yet|Nothing saved/);
  L.recordDone(bea.id, "google", [{ name: "google connection", chars: 16 }]);
  const status = await text("setup_status", "google");
  assert.match(status, /Google is connected/);
  assert.doesNotMatch(status, /token|anna@/i);
  assert.match(await text("get_setup_link", "profile"), /cannot set up/);
  const bad = await client.callTool({ name: "get_setup_link", arguments: { purpose: "google" } });
  assert.ok(bad);
});

test("google: the write-only intake token cannot read the grant; the app's token can read a friend's Google item and no other item of hers; one friend cannot read another's", async () => {
  bao.store.set(`tenants/${anna.id}/google/oauth`, { refresh_token: REFRESH, email: "anna@example.com" });
  bao.store.set(`tenants/${anna.id}/profile/address.home`, { value: "FAKE-ADDR" });
  const intake = bao.bao({ token: bao.intakeToken });
  await assert.rejects(intake.read(`tenants/${anna.id}/google/oauth`));
  const app = new TenantSecrets(bao.bao({ token: bao.token }), anna.id);
  assert.equal((await app.get("google", "oauth"))?.refresh_token, REFRESH);
  await assert.rejects(app.get("profile", "address.home"), "the app's token reads her Google grant and nothing else of hers");
  const other = new TenantSecrets(bao.bao({ token: bao.tokenFor(noGoogle.id) }), anna.id);
  await assert.rejects(other.get("google", "oauth"), "another friend's token reaches only her own folder");
});

test("doctor: a google line appears only when a friend has the capability; it names what is missing, never a value, and each friend's connection", async () => {
  const { servicesCheck } = await import("../src/doctor.ts");
  const out: { ok: unknown; what: string; detail: string }[] = [];
  const line = (ok: boolean | "warn", what: string, detail = "") => void out.push({ ok, what, detail });
  servicesCheck(line, { friends: T.people().filter((r) => !r.capabilities.includes("google") && !r.capabilities.includes("notion")) });
  assert.equal(out.length, 0, "nobody has it: no line");
  const friends = T.people().filter((r) => r.id === anna.id || r.id === noGoogle.id);
  servicesCheck(line, { needs: { google: ["GOOGLE_OAUTH_CLIENT_SECRET"] }, baseUrl: "https://ted.example.test", friends });
  assert.equal(out[0]!.ok, false);
  assert.match(out[0]!.detail, /GOOGLE_OAUTH_CLIENT_SECRET is not set/);
  out.length = 0;
  servicesCheck(line, { needs: { google: [] }, baseUrl: "https://ted.example.test", friends, onPath: () => true, state: (id) => (id === anna.id ? { state: "connected", at: "2026-10-20T08:00:00.000Z" } : { state: "none" }) });
  assert.equal(out.length, 2, "the command and the one friend with the capability");
  assert.deepEqual(out.map((x) => x.ok), [true, true]);
  assert.match(out[1]!.detail, /connected since 2026-10-20/);
  assert.match(out[1]!.detail, /tools: mail, calendar/);
  assert.ok(!JSON.stringify(out).includes("fake-client-secret"), "no secret in a doctor line");
  out.length = 0;
  servicesCheck(line, { needs: { google: [] }, baseUrl: "https://ted.example.test", friends, onPath: () => false, state: () => ({ state: "none" }) });
  assert.equal(out[0]!.ok, "warn");
  assert.equal(out[1]!.ok, "warn");
});
