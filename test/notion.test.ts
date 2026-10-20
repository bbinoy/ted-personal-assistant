import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { scopeOf } from "../src/turnscope.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startFakeNotion } from "./fakenotion.ts";
import type { FakeBao } from "./fakebao.ts";

// Notion for friends (src/notionoauth.ts, src/notionmcp.ts, src/modules/notionhosted.ts, the shared src/oauth.ts and src/mcpproxy.ts) against FAKES: a fake Notion OAuth server
// with discovery, dynamic registration and ROTATING refresh tokens, a fake hosted MCP endpoint that answers only a live bearer, and a fake OpenBao. Nothing talks to Notion.
// Every token is an obviously fake string. The point of the tests: the client is registered once, the grant lands in HER path through the write-only token, a refresh
// never loses the rotated token (not even with several at once), the new refresh token is stored before the new access token is used, an expired or revoked grant is told
// to her and never silent, the token is never where a process list, a log, an audit row, a prompt or a tool result could show it, two friends do not meet, and the owner is untouched.
const fake = await startFakeNotion();
const dataDir = mkdtempSync(join(tmpdir(), "notion-"));
process.env.HARNESS_DATA_DIR = dataDir;
process.env.NOTION_MCP_URL = fake.mcpUrl;
process.env.INTAKE_BASE_URL = "http://127.0.0.1:9";
process.env.INTAKE_ALLOW_HTTP_LOOPBACK = "on";
process.env.GOOGLE_OAUTH_CLIENT_ID = "fake-client-id.example";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "fake-client-secret-not-real";

const { settings } = await import("../src/settings.ts");
const { startFakeBao } = await import("./fakebao.ts");
const { readAudit } = await import("../src/audit.ts");
const { IntakeWriter } = await import("../src/intakestore.ts");
const T = await import("../src/tenants.ts");
const L = await import("../src/intakelinks.ts");
const { IntakeServer } = await import("../src/intakeserver.ts");
const { OAuthFlows } = await import("../src/oauth.ts");
const { googleProvider } = await import("../src/googleoauth.ts");
const N = await import("../src/notionoauth.ts");
const { NotionHub, NotionSession, notionProxy, RECONNECT_TEXT } = await import("../src/notionmcp.ts");
const { UpstreamError } = await import("../src/mcpproxy.ts");
const { createIntakeServer } = await import("../src/intaketools.ts");
const { TenantSecrets } = await import("../src/secrets.ts");
const { serversFor } = await import("../src/modules/runtime.ts");
const { NOTION_FRIEND_PREFIX: P, NOTION_FRIEND_TOOLS } = await import("../src/modules/notionhosted.ts");
const { tenantCapabilities, tenantTools } = await import("../src/capabilities.ts");
const { makeCanUseTool } = await import("../src/permissions.ts");
const { classify } = await import("../src/policy.ts");
const { describeTenants } = await import("../src/tenanttools.ts");
const { connectionSummary } = await import("../src/connections.ts");
const { notionCheck, intakeCheck } = await import("../src/doctor.ts");

const printed: string[] = [];
const realLog = console.log;
const realErr = console.error;
before(() => {
  console.log = (...a: unknown[]) => void printed.push(a.join(" "));
  console.error = (...a: unknown[]) => void printed.push(a.join(" "));
});
after(async () => {
  console.log = realLog;
  console.error = realErr;
  await fake.close();
});

let bao: FakeBao;
const servers: { close(): void }[] = [];
before(async () => {
  bao = await startFakeBao();
});
after(async () => {
  servers.forEach((s) => s.close());
  await bao.close();
});

let n = 0;
function person(name: string, capabilities: import("../src/tenants.ts").Capability[]) {
  const rec = T.redeemInvite(T.mintInvite("test")!.code, { aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
  T.provision(rec);
  T.recordConsent(T.tenantContext(rec), "Germany");
  for (const c of capabilities) T.grant(rec.id, c);
  return T.tenantById(rec.id)!;
}
T.ensureOwner({ number: "+15555550114" });
const anna = person("Anna", ["intake", "notion"]);
const bea = person("Bea", ["intake", "notion"]);
const plain = person("Pia", ["intake"]);

const grantPath = (id: string) => `tenants/${id}/notion/oauth`;
const grantOf = (id: string) => bao.store.get(grantPath(id)) as Record<string, any> | undefined;
// The app's own access to her item (its token reads and writes tenants/+/notion/*): what the harness uses at run time.
const store = (): import("../src/notionoauth.ts").GrantStore => ({
  read: (t) => new TenantSecrets(bao.bao({ token: bao.token }), t).get("notion", "oauth", { cache: false }),
  write: (t, d) => new TenantSecrets(bao.bao({ token: bao.token }), t).put("notion", "oauth", d),
});
const provider = () => N.notionProvider({ mcpUrl: () => fake.mcpUrl });
const flows = (base = "http://127.0.0.1:9") => new OAuthFlows({ providers: [provider(), googleProvider(() => ({ clientId: "g", clientSecret: "s", authUrl: "https://g.example/auth", tokenUrl: "https://g.example/token", scopes: ["a"] }))], baseUrl: () => base });
const freshClientFile = () => rmSync(join(dataDir, "state/notion-client.json"), { force: true });

let codeN = 0;
// The whole sign-in without the page: link -> consent address -> (the browser leg) -> state -> code exchange -> her item, like the callback does it.
async function connect(tenant: string, base = "http://127.0.0.1:9") {
  const f = flows(base);
  const started = await f.begin("notion", `LINK${++codeN}`, tenant);
  const url = new URL(started.url);
  const code = `fake-notion-code-${codeN}`;
  fake.expect(code, url.searchParams.get("code_challenge")!);
  const flow = f.take("notion", url.searchParams.get("state")!, started.binding)!;
  const grant = await f.exchange("notion", code, flow.verifier);
  bao.store.set(grantPath(tenant), { ...grant.data, at: new Date().toISOString() });
  return { url, grant };
}

// ---- discovery and the one registration ----

test("notion: discovery reads the protected-resource and authorization-server documents; a server without them or without S256 is refused with a fixed sentence", async () => {
  const ep = await N.discover(fake.mcpUrl);
  assert.deepEqual(ep, { authorization: `${fake.url}/authorize`, token: `${fake.url}/token`, registration: `${fake.url}/register` });
  fake.mode.discovery = "broken";
  await assert.rejects(N.discover(fake.mcpUrl), /Notion's sign-in could not be set up right now/);
  fake.mode.discovery = "ok";
  await assert.rejects(N.discover(fake.mcpUrl, (async () => new Response(JSON.stringify({ authorization_servers: ["http://127.0.0.1:1"] }), { status: 200 })) as never), /could not be set up/);
});

test("notion: the instance registers ONE public client (dynamic registration) and never again for a second person, a second link or a restart; a new redirect address registers a new one", async () => {
  freshClientFile();
  const before = fake.registrations.length;
  const a = await connect(anna.id);
  const b = await connect(bea.id);
  assert.equal(fake.registrations.length, before + 1, "one registration for two people and two links");
  const reg = fake.registrations.at(-1)!;
  assert.deepEqual(reg.redirect_uris, ["http://127.0.0.1:9/oauth/notion/callback"]);
  assert.equal(reg.token_endpoint_auth_method, "none", "a public client: no secret");
  assert.deepEqual(reg.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(reg.client_name, settings.assistant);
  assert.equal(a.url.searchParams.get("client_id"), b.url.searchParams.get("client_id"));
  assert.ok(N.clientRegistered("http://127.0.0.1:9"));
  // the registration is remembered on disk (an id is no secret; the intake page, with a write-only OpenBao token, must be able to read it)
  assert.ok(existsSync(join(dataDir, "state/notion-client.json")));
  // two processes at the same moment: the lock makes one registration
  freshClientFile();
  const count = fake.registrations.length;
  await Promise.all([N.ensureClient("http://127.0.0.1:9/oauth/notion/callback", fetch, fake.mcpUrl), N.ensureClient("http://127.0.0.1:9/oauth/notion/callback", fetch, fake.mcpUrl), N.ensureClient("http://127.0.0.1:9/oauth/notion/callback", fetch, fake.mcpUrl)]);
  assert.equal(fake.registrations.length, count + 1);
  // a new tunnel address is a new redirect URI: a new registration, and the old grants keep the client id they were issued to
  const old = grantOf(anna.id)!.client_id;
  const moved = await connect(anna.id, "http://127.0.0.1:10");
  assert.equal(fake.registrations.length, count + 2);
  assert.notEqual(moved.url.searchParams.get("client_id"), old);
});

test("notion: the consent address carries PKCE (S256), the state, the redirect and the resource; the grant keeps the client id and the token endpoint it was issued to", async () => {
  freshClientFile();
  const { url, grant } = await connect(anna.id);
  assert.equal(url.origin + url.pathname, `${fake.url}/authorize`);
  const q = url.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("state")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:9/oauth/notion/callback");
  assert.equal(q.get("resource"), fake.mcpUrl);
  assert.ok(!q.has("client_secret"));
  const tokenCall = fake.tokenCalls.filter((c) => c.grant_type === "authorization_code").at(-1)!;
  assert.equal(tokenCall.client_id, q.get("client_id"));
  assert.equal(grant.data.client_id, q.get("client_id"));
  assert.equal(grant.data.token_endpoint, `${fake.url}/token`);
  assert.ok(typeof grant.data.expires_at === "number" && (grant.data.expires_at as number) > Date.now());
});

// ---- the intake page: Connect Notion ----

async function start() {
  const links = new L.LinkStore(mkdtempSync(join(tmpdir(), "notion-links-")));
  let base = "";
  const f = new OAuthFlows({ providers: [provider()], baseUrl: () => base });
  const page = new IntakeServer({ links, writer: new IntakeWriter(bao.bao({ token: bao.intakeToken })), oauth: f, limits: { perIpPerMinute: 1000, globalPerMinute: 10_000, badCodesPerIp: 1000 } });
  await new Promise<void>((r) => page.server.listen(0, "127.0.0.1", r));
  servers.push({ close: () => (page.server.closeAllConnections(), page.server.close()) });
  base = `http://127.0.0.1:${(page.server.address() as AddressInfo).port}`;
  return { base, links, mint: (tenant: string, purpose = "notion") => links.mint({ tenant, purpose }, 15 * 60_000)! };
}

test("notion: the page shows Connect Notion; the callback exchanges the code, stores the grant in HER path with the write-only token, burns the link and says connected", async () => {
  freshClientFile();
  const s = await start();
  const code = s.mint(anna.id);
  const r = await fetch(`${s.base}/i/${code}`);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /Connect Notion/);
  const href = new URL(/href="([^"]+)"/.exec(html)![1]!.replaceAll("&amp;", "&"));
  const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(r.headers.get("set-cookie")!, /; Path=\/oauth\/notion\/callback; HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.equal(href.searchParams.get("redirect_uri"), `${s.base}/oauth/notion/callback`);
  const auth = "fake-notion-code-page";
  fake.expect(auth, href.searchParams.get("code_challenge")!);
  bao.store.delete(grantPath(anna.id));
  const at = (state: string, c?: string) => fetch(`${s.base}/oauth/notion/callback?${new URLSearchParams({ code: auth, state })}`, c ? { headers: { cookie: c } } : {});
  // the consent address passed on to another browser (no cookie, or its own) finishes nothing and uses the state up
  const stolen = await at(href.searchParams.get("state")!);
  assert.equal(stolen.status, 404, "no cookie");
  assert.equal(await stolen.text(), "Not found\n");
  const r2 = await fetch(`${s.base}/i/${code}`); // the page again: a new state and a new binding
  const href2 = new URL(/href="([^"]+)"/.exec(await r2.text())![1]!.replaceAll("&amp;", "&"));
  const cookie2 = r2.headers.get("set-cookie")!.split(";")[0]!;
  assert.notEqual(cookie2, cookie);
  fake.expect(auth, href2.searchParams.get("code_challenge")!);
  assert.equal((await at(href2.searchParams.get("state")!, cookie)).status, 404, "another flow's cookie");
  assert.equal(grantOf(anna.id), undefined, "nothing stored");
  const r3 = await fetch(`${s.base}/i/${code}`);
  const href3 = new URL(/href="([^"]+)"/.exec(await r3.text())![1]!.replaceAll("&amp;", "&"));
  const cookie3 = r3.headers.get("set-cookie")!.split(";")[0]!;
  fake.expect(auth, href3.searchParams.get("code_challenge")!);
  const done = await at(href3.searchParams.get("state")!, cookie3);
  const text = await done.text();
  assert.equal(done.status, 200);
  assert.match(text, /Notion is connected/);
  const grant = grantOf(anna.id)!;
  assert.match(grant.access_token, /^fake-notion-access-/);
  assert.match(grant.refresh_token, /^fake-notion-refresh-/);
  assert.equal(bao.store.has(grantPath("owner")), false);
  assert.ok(bao.requests.filter((x) => x.method === "POST" && x.path.includes("/notion/")).every((x) => x.token === bao.intakeToken), "written only with the write-only token");
  assert.equal((await fetch(`${s.base}/i/${code}`)).status, 404, "the link is burnt");
  assert.equal(L.connectionState(anna.id, "notion").state, "connected");
  assert.equal((await at(href3.searchParams.get("state")!, cookie3)).status, 404, "a replayed state finds nothing");
  const everything = [text, printed.join("\n"), JSON.stringify(readAudit(() => true)), JSON.stringify(L.readDone(anna.id, "notion"))].join("\n");
  for (const secret of [grant.access_token, grant.refresh_token, auth, code]) assert.ok(!html.includes(secret), "the sign-in page holds none of them (only the state, in the address of the link to Notion)");
  for (const secret of [grant.access_token, grant.refresh_token, auth, code, href.searchParams.get("state")!, href3.searchParams.get("state")!, cookie3.split("=")[1]!, cookie.split("=")[1]!]) assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 14)}`);
  assert.equal(readAudit((e) => e.tool === "intake_store" && e.meta?.tenant === anna.id).at(-1)!.meta!.purpose, "notion");
});

test("notion: a person without the capability cannot open a notion link, a Google state does not finish a Notion link, and she can say no", async () => {
  const s = await start();
  assert.equal((await fetch(`${s.base}/i/${s.mint(plain.id)}`)).status, 404, "no notion capability");
  const code = s.mint(bea.id);
  const page = await fetch(`${s.base}/i/${code}`);
  const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
  const href = new URL(/href="([^"]+)"/.exec(await page.text())![1]!.replaceAll("&amp;", "&"));
  const calls = fake.tokenCalls.length;
  assert.equal((await fetch(`${s.base}/oauth/google/callback?${new URLSearchParams({ code: "x", state: href.searchParams.get("state")! })}`, { headers: { cookie } })).status, 404, "a notion state at the google callback");
  const no = await fetch(`${s.base}/oauth/notion/callback?${new URLSearchParams({ error: "access_denied", state: href.searchParams.get("state")! })}`, { headers: { cookie } });
  assert.equal(no.status, 400);
  assert.match(await no.text(), /Notion was not connected/);
  assert.equal(fake.tokenCalls.length, calls, "nothing exchanged");
  assert.equal(s.links.isOpen({ tenant: bea.id, purpose: "notion" }), true, "the link stays open");
});

// ---- the tokens: rotation, ordering, expiry, revocation, the lock ----

const tokensFor = (o: { write?: (t: string, d: Record<string, unknown>) => Promise<void>; reconnect?: (t: string) => void; now?: () => number } = {}) => {
  const base = store();
  return new N.NotionTokens({ store: { read: base.read, write: o.write ?? base.write }, fetch, ...(o.reconnect ? { reconnect: o.reconnect } : {}), ...(o.now ? { now: o.now } : {}) });
};
const expireIn = (id: string, ms: number) => bao.store.set(grantPath(id), { ...grantOf(id)!, expires_at: Date.now() + ms });

test("notion: a fresh access token is used as it is; one near its end is renewed with ROTATION, sending the original client id, and the new refresh token is stored BEFORE the new access token is returned", async () => {
  freshClientFile();
  await connect(anna.id);
  const before = grantOf(anna.id)!;
  const log: string[] = [];
  const tokens = tokensFor({ write: async (t, d) => (log.push(`write ${String(d.refresh_token).slice(-12)}`), store().write(t, d)) });
  assert.equal(await tokens.accessToken(anna.id), before.access_token);
  assert.equal(tokens.refreshes, 0);
  expireIn(anna.id, 60_000); // inside the 5 minute margin
  const calls = fake.tokenCalls.length;
  const got = await tokens.accessToken(anna.id);
  log.push(`returned ${got.slice(-12)}`);
  assert.notEqual(got, before.access_token);
  assert.equal(tokens.refreshes, 1);
  const call = fake.tokenCalls.at(-1)!;
  assert.equal(fake.tokenCalls.length, calls + 1);
  assert.equal(call.grant_type, "refresh_token");
  assert.equal(call.client_id, before.client_id, "the client id the grant was issued to");
  assert.equal(call.refresh_token, before.refresh_token);
  const after = grantOf(anna.id)!;
  assert.notEqual(after.refresh_token, before.refresh_token, "the rotated refresh token is the stored one");
  assert.equal(after.refresh_token, fake.chainOf(got)!.refresh, "and it is the one Notion now honours");
  assert.equal(after.access_token, got);
  assert.equal(after.client_id, before.client_id);
  assert.match(log[0]!, /^write /, "stored first");
  assert.match(log[1]!, /^returned /, "used after");
  assert.ok(Number(after.expires_at) > Date.now() + 3600_000);
  // and the next call needs no refresh
  assert.equal(await tokens.accessToken(anna.id), got);
  assert.equal(tokens.refreshes, 1);
});

test("notion: if the rotated token cannot be stored, the new access token is NOT used and nothing is lost: the next call writes it first and does not refresh again", async () => {
  await connect(anna.id);
  expireIn(anna.id, 1000);
  let down = true;
  const tokens = tokensFor({ write: async (t, d) => (down ? Promise.reject(new Error("the secret store is down")) : store().write(t, d)) });
  const before = grantOf(anna.id)!;
  await assert.rejects(tokens.accessToken(anna.id), (e: Error) => e instanceof UpstreamError && /could not be saved/.test(e.message) && !e.message.includes("fake-notion"));
  assert.equal(grantOf(anna.id)!.refresh_token, before.refresh_token, "the store still holds the old, now dead, token");
  assert.equal(fake.chains.find((c) => c.refresh === before.refresh_token), undefined, "(the old refresh token is dead at Notion: the rotation happened)");
  down = false;
  const calls = fake.tokenCalls.length;
  const got = await tokens.accessToken(anna.id);
  assert.equal(fake.tokenCalls.length, calls, "no second refresh: the rotated pair was kept in memory and written");
  assert.equal(grantOf(anna.id)!.access_token, got);
  assert.equal(grantOf(anna.id)!.refresh_token, fake.chainOf(got)!.refresh);
});

test("notion: CONCURRENT refreshes of one person run one after the other: one call to Notion, every caller gets the new token, and the stored refresh token is the valid one", async () => {
  await connect(anna.id);
  expireIn(anna.id, 1000);
  fake.mode.delayMs = 60; // a slow token endpoint widens the window in which a second refresh would start
  const tokens = tokensFor();
  const calls = fake.tokenCalls.filter((c) => c.grant_type === "refresh_token").length;
  const got = await Promise.all(Array.from({ length: 8 }, () => tokens.accessToken(anna.id)));
  fake.mode.delayMs = 0;
  assert.equal(new Set(got).size, 1, "everyone has the same new token");
  assert.equal(fake.tokenCalls.filter((c) => c.grant_type === "refresh_token").length, calls + 1, "one refresh, not eight");
  assert.equal(grantOf(anna.id)!.refresh_token, fake.chainOf(got[0]!)!.refresh, "the stored refresh token is the one Notion honours: nothing was lost");
  // and again, expiring once more, still works (it would not if a rotation had been lost)
  expireIn(anna.id, 1000);
  const next = await Promise.all([tokens.accessToken(anna.id), tokens.accessToken(anna.id), tokens.accessToken(anna.id)]);
  assert.equal(new Set(next).size, 1);
  assert.notEqual(next[0], got[0]);
  // two people refresh independently
  await connect(bea.id);
  expireIn(anna.id, 1000);
  expireIn(bea.id, 1000);
  const [ta, tb] = await Promise.all([tokens.accessToken(anna.id), tokens.accessToken(bea.id)]);
  assert.notEqual(ta, tb);
  assert.equal(grantOf(anna.id)!.refresh_token, fake.chainOf(ta)!.refresh);
  assert.equal(grantOf(bea.id)!.refresh_token, fake.chainOf(tb)!.refresh);
});

test("notion: a refresh token that Notion refuses (expired, revoked) is a reconnect, recorded and never silent; Notion being down is only try-again-later and changes nothing", async () => {
  await connect(anna.id);
  expireIn(anna.id, 1000);
  const marks: string[] = [];
  const tokens = tokensFor({ reconnect: (t) => void marks.push(t) });
  const before = grantOf(anna.id)!;
  fake.mode.refresh = "down";
  await assert.rejects(tokens.accessToken(anna.id), (e: Error) => e instanceof UpstreamError && !(e instanceof N.NotionReconnect));
  assert.deepEqual(marks, []);
  assert.deepEqual(grantOf(anna.id), before, "nothing changed");
  fake.mode.refresh = "revoked";
  await assert.rejects(tokens.accessToken(anna.id), N.NotionReconnect);
  assert.deepEqual(marks, [anna.id]);
  fake.mode.refresh = "ok";
  // the real marker: the admin's list and setup_status say so, and connecting again clears it
  const real = new N.NotionTokens({ store: store(), fetch });
  fake.mode.refresh = "revoked";
  await assert.rejects(real.accessToken(anna.id), N.NotionReconnect);
  fake.mode.refresh = "ok";
  assert.equal(L.connectionState(anna.id, "notion").state, "reconnect");
  assert.match(connectionSummary(anna)!, /notion needs to be reconnected/);
  await new Promise((r) => setTimeout(r, 5));
  L.recordDone(anna.id, "notion", [{ name: "notion connection", chars: 40 }]);
  assert.equal(L.connectionState(anna.id, "notion").state, "connected");
  // never connected
  await assert.rejects(tokens.accessToken(plain.id), N.NotionReconnect);
});

// ---- the hosted server, through the credentialed proxy ----

const hub = (tokens = tokensFor()) => new NotionHub((id) => new NotionSession(id, tokens, () => ({ url: fake.mcpUrl, idleMs: 60_000, callMs: 10_000 })));
async function runClient(h: InstanceType<typeof NotionHub>, id: string, allowed: (n: string) => boolean = (name) => `${P}${name}` !== "" && NOTION_FRIEND_TOOLS.includes(P + name)) {
  const cfg = notionProxy(id, allowed, NOTION_FRIEND_TOOLS.map((t) => t.slice(P.length)), h);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(a as never);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return { cfg, client, call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean } };
}

test("notion: the proxy adds HER bearer inside the harness: the hosted endpoint sees it, the run's config holds no token and no header, and tools beyond her set are hidden and refused", async () => {
  freshClientFile();
  await connect(anna.id);
  const h = hub();
  try {
    const { cfg, client, call } = await runClient(h, anna.id);
    assert.equal(cfg.type, "sdk", "no command line, no environment, no http headers for the CLI to carry");
    const config = JSON.stringify({ type: cfg.type, name: cfg.name }) + Object.keys(cfg).join();
    const secrets = [grantOf(anna.id)!.access_token, grantOf(anna.id)!.refresh_token];
    for (const s of secrets) assert.ok(!config.includes(s) && !/bearer|authorization|headers/i.test(config));
    const listed = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(listed.sort(), NOTION_FRIEND_TOOLS.map((t) => t.slice(P.length)).sort());
    for (const hidden of ["notion-get-users", "notion-create-database"]) assert.ok(!listed.includes(hidden), hidden);
    const res = await call("notion-search", { query: "plans" });
    assert.match(res.content[0]!.text, /fake notion-search/);
    const seen = fake.mcpCalls.filter((c) => c.tool === "notion-search").at(-1)!;
    assert.equal(seen.bearer, grantOf(anna.id)!.access_token, "the hosted endpoint was called with her bearer");
    assert.ok(fake.mcpCalls.every((c) => c.bearer === grantOf(anna.id)!.access_token), "every request carried it, the initialise and the list included");
    const refused = await call("notion-get-users");
    assert.equal(refused.isError, true);
    assert.equal(fake.mcpCalls.filter((c) => c.tool === "notion-get-users").length, 0, "never forwarded");
    // no tool result, error or log holds a token
    const all = [res.content[0]!.text, refused.content[0]!.text, printed.join("\n"), JSON.stringify(readAudit(() => true))].join("\n");
    for (const s of secrets) assert.ok(!all.includes(s));
  } finally {
    h.closeAll();
  }
});

test("notion: a token that expired meanwhile is renewed before the run's next call, and the call after it carries the NEW bearer on the same connection", async () => {
  await connect(anna.id);
  const h = hub();
  try {
    const { call } = await runClient(h, anna.id);
    await call("notion-search", { query: "a" });
    const old = grantOf(anna.id)!;
    expireIn(anna.id, 1000);
    const res = await call("notion-fetch", { id: "p1" });
    assert.match(res.content[0]!.text, /fake notion-fetch/);
    const now = grantOf(anna.id)!;
    assert.notEqual(now.access_token, old.access_token);
    assert.equal(fake.mcpCalls.filter((c) => c.tool === "notion-fetch").at(-1)!.bearer, now.access_token);
    assert.equal(now.refresh_token, fake.chainOf(now.access_token)!.refresh);
  } finally {
    h.closeAll();
  }
});

test("notion: expired, revoked or never connected: the run is still shown her tools, and using one says plainly to tell her and to make a new link (purpose notion); no token in it", async () => {
  await connect(anna.id);
  expireIn(anna.id, 1000);
  fake.mode.refresh = "revoked";
  const h = hub(new N.NotionTokens({ store: store(), fetch }));
  try {
    const { client, call } = await runClient(h, anna.id);
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.map((t) => t.name).sort(), NOTION_FRIEND_TOOLS.map((t) => t.slice(P.length)).sort(), "stand-in tools, so the model can try one and be told");
    const res = await call("notion-search", { query: "x" });
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, RECONNECT_TEXT);
    assert.match(res.content[0]!.text, /get_setup_link/);
    assert.match(res.content[0]!.text, /purpose "notion"/);
    assert.equal(fake.mcpCalls.filter((c) => c.tool === "notion-search" && c.bearer === grantOf(anna.id)!.access_token).length, 0, "nothing was sent to Notion with a dead token");
    const nobody = await runClient(h, plain.id);
    assert.equal((await nobody.call("notion-search")).content[0]!.text, RECONNECT_TEXT);
    // Notion down: a different, plain sentence
    fake.mode.refresh = "down";
    expireIn(anna.id, 1000);
    const down = await call("notion-search");
    assert.match(down.content[0]!.text, /not available for her right now/);
    assert.ok(!/fake-notion/.test(down.content[0]!.text));
  } finally {
    fake.mode.refresh = "ok";
    h.closeAll();
  }
});

test("notion: two friends are isolated: each call carries her own bearer and reaches her own workspace, and neither can name the other", async () => {
  await connect(anna.id);
  await connect(bea.id);
  const h = hub();
  try {
    const a = await runClient(h, anna.id);
    const b = await runClient(h, bea.id);
    const ra = (await a.call("notion-search", { query: "mine" })).content[0]!.text;
    const rb = (await b.call("notion-search", { query: "mine" })).content[0]!.text;
    const ca = fake.chains.indexOf(fake.chainOf(grantOf(anna.id)!.access_token)!);
    const cb = fake.chains.indexOf(fake.chainOf(grantOf(bea.id)!.access_token)!);
    assert.notEqual(ca, cb);
    assert.match(ra, new RegExp(`chain ${ca}:`));
    assert.match(rb, new RegExp(`chain ${cb}:`));
    // a model that writes another person's id or token into the arguments changes nothing: the bearer is the harness's, from the session of the run
    await a.call("notion-fetch", { id: "x", authorization: `Bearer ${grantOf(bea.id)!.access_token}`, tenant: bea.id });
    assert.equal(fake.mcpCalls.filter((c) => c.tool === "notion-fetch").at(-1)!.bearer, grantOf(anna.id)!.access_token);
    assert.equal(h.session(anna.id).starts, 1);
    assert.equal(h.session(bea.id).starts, 1);
    h.drop(anna.id);
    assert.deepEqual(h.open, [bea.id]);
  } finally {
    h.closeAll();
  }
});

// ---- the capability table, the floor, the judge, her chat ----

const runCtx = (ctx: ReturnType<typeof T.tenantContext>) => {
  const tools = tenantTools(ctx);
  return { source: "group" as const, browsing: false, key: `tenant:${ctx.id}`, mode: "group" as const, tenant: { id: ctx.id } as never, offers: (t: string) => tools.has(t), browseRun: async () => ({ text: "", costUsd: 0 }), memory: { dir: ctx.notesDir } };
};
const ctxOf = (rec: { id: string }) => T.tenantContext(T.tenantById(rec.id)!);

test("notion: the capability decides: only a friend with notion (and a page to sign in on) is offered the tools and a server; the owner's Notion connector is never hers, and hers is never the owner's", () => {
  const set = tenantTools(ctxOf(anna));
  for (const t of ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page", "notion-create-comment", "notion-move-pages"]) assert.ok(set.has(P + t), t);
  for (const t of ["notion-get-users", "notion-create-database", "notion-duplicate-page"]) assert.ok(!set.has(P + t), `${t} is not hers`);
  assert.ok(![...set].some((t) => t.startsWith("mcp__claude_ai_")), "never the owner's connectors");
  assert.equal(serversFor(runCtx(ctxOf(anna))).notion!.type, "sdk");
  assert.equal(serversFor(runCtx(ctxOf(plain))).notion, undefined);
  assert.equal([...tenantTools(ctxOf(plain))].filter((t) => t.startsWith(P)).length, 0);
  assert.equal(serversFor({ ...runCtx(ctxOf(anna)), source: "chat", tenant: undefined, key: "owner", mode: "owner", offers: () => true }).notion, undefined, "the owner's runs never have her server");
  // without a page to sign in on there is no way to connect: the capability is dropped
  const on = settings as unknown as { intake: { baseUrl: string | undefined } };
  const keep = on.intake.baseUrl;
  on.intake.baseUrl = undefined;
  try {
    assert.ok(!tenantCapabilities(ctxOf(anna)).has("notion"));
    assert.equal(serversFor(runCtx(ctxOf(anna))).notion, undefined);
  } finally {
    on.intake.baseUrl = keep;
  }
  // the owner's own rows are the connector's and unchanged
  assert.equal(classify("mcp__claude_ai_Notion__notion-search", {}, "group", ctxOf(anna).notesDir, set), "deny", "a friend never gets the owner's Notion");
  assert.equal(classify("mcp__claude_ai_Notion__notion-search", {}, "chat"), "allow", "the owner's read is as it was");
  assert.equal(classify(P + "notion-search", {}, "chat"), "deny", "and the owner's source has no tool of hers");
});

const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; message?: string };
function rig(ctx: ReturnType<typeof T.tenantContext>, verdict: "auto" | "ask" = "ask") {
  const asked: string[] = [];
  const judged: { description: string; untrustedInput?: boolean }[] = [];
  const approve = async (description: string) => (asked.push(description), { approved: true });
  const judge = (async (i: { description: string; untrustedInput?: boolean }) => (judged.push(i), { decision: verdict, reason: "t" })) as never;
  const can = makeCanUseTool(approve as never, "group", ctx.notesDir, judge, undefined, tenantTools(ctx), true, { provenance: scopeOf(`tenant:${ctx.id}`).read, conversation: `tenant:${ctx.id}` });
  return { asked, judged, run: (tool: string, input: Record<string, unknown>) => can(P + tool, input, opts) as Promise<Out> };
}

test("notion: reads run free and are shown to the judge as outside text; a page write goes to the judge and, unless it passes, to HER chat; a move, a trashing and anything unlisted are never judged or never offered", async () => {
  const ctx = ctxOf(anna);
  scopeOf(`tenant:${ctx.id}`).say("add a page for the trip to my Notion");
  let r = rig(ctx);
  assert.equal((await r.run("notion-search", { query: "trip" })).behavior, "allow");
  assert.equal((await r.run("notion-fetch", { id: "p1" })).behavior, "allow");
  assert.equal(r.judged.length + r.asked.length, 0, "a read is not judged");
  assert.equal((await r.run("notion-create-pages", { pages: [{ title: "Trip" }] })).behavior, "allow");
  assert.equal(r.asked.length, 1, "asked in her chat");
  assert.match(r.asked[0]!, /Create Notion page/);
  assert.equal(r.judged.at(-1)!.untrustedInput, true, "after reading pages the arguments may be steered");
  r = rig(ctx, "auto");
  assert.equal((await r.run("notion-update-page", { page_id: "p1", command: "replace_content", new_str: "x" })).behavior, "allow");
  assert.equal(r.judged.length, 1);
  assert.equal(r.asked.length, 0, "the unified judge may pass a plain page change");
  assert.equal((await r.run("notion-create-comment", { page_id: "p1", rich_text: [] })).behavior, "allow");
  assert.equal(r.judged.length, 2);
  // never judged: a move, and a page sent to the bin however the call spells it
  r = rig(ctx, "auto");
  await r.run("notion-move-pages", { page_ids: ["p1"], new_parent: { page_id: "p2" } });
  await r.run("notion-update-page", { page_id: "p1", properties: { in_trash: true } });
  await r.run("notion-update-page", { page_id: "p1", archived: true });
  assert.equal(r.judged.length, 0);
  assert.equal(r.asked.length, 1, "a move is her call; a page sent to the bin is denied, however the call spells it");
  // not offered at all
  r = rig(ctx, "auto");
  for (const t of ["notion-get-users", "notion-create-database", "notion-duplicate-page", "notion-delete-page"]) assert.equal((await r.run(t, {})).behavior, "deny", t);
  assert.equal(r.asked.length + r.judged.length, 0);
  // someone without the capability has none of it
  const nobody = rig(ctxOf(plain), "auto");
  assert.equal((await nobody.run("notion-search", {})).behavior, "deny");
});

test("notion: the audit of her calls is wordless: the page content she wrote or read is in no audit row, and no row holds a token", async () => {
  const ctx = ctxOf(anna);
  scopeOf(`tenant:${ctx.id}`).say("save the secret plan page");
  const r = rig(ctx, "auto");
  await r.run("notion-create-pages", { pages: [{ title: "ZZ-PRIVATE-TITLE-ZZ", content: "ZZ-PRIVATE-BODY-ZZ" }] });
  const rows = JSON.stringify(readAudit((e) => String(e.tool).startsWith(P)));
  assert.ok(!/ZZ-PRIVATE/.test(rows), "no words of hers");
  assert.ok(!/fake-notion/.test(rows));
});

// ---- intake tools, admin visibility, the secret store policy ----

test("notion: get_setup_link and setup_status know notion: 'Notion is connected', a reconnect when it stopped working, never a token", async () => {
  const links = new L.LinkStore(mkdtempSync(join(tmpdir(), "notion-links-")));
  const cat = person("Cat", ["intake", "notion"]);
  assert.deepEqual(L.purposesFor(["intake", "notion"]), ["notion"]);
  assert.deepEqual(L.purposesFor(["intake"]), []);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createIntakeServer({ id: cat.id }, links).instance.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const text = async (name: string, purpose: string) => ((await client.callTool({ name, arguments: { purpose } })) as { content: { text: string }[] }).content[0]!.text;
  assert.match(await text("get_setup_link", "notion"), /Connect Notion/);
  assert.match(await text("setup_status", "notion"), /Not yet|Nothing saved/);
  await connect(cat.id);
  L.recordDone(cat.id, "notion", [{ name: "notion connection", chars: 40 }]);
  const status = await text("setup_status", "notion");
  assert.match(status, /Notion is connected/);
  assert.doesNotMatch(status, /fake-notion|token/i);
  await new Promise((r) => setTimeout(r, 5));
  L.markNeedsReconnect(cat.id, "notion");
  assert.match(await text("setup_status", "notion"), /no longer works.*connect again: make her a new link/);
  assert.match(await text("get_setup_link", "notion"), /Connect Notion/, "and a new link can be made");
});

test("notion: the secret store: the write-only token cannot read the grant; the app's token reads and writes back a friend's Notion item and no other item of hers; no friend reaches another's", async () => {
  await connect(anna.id);
  bao.store.set(`tenants/${anna.id}/profile/address.home`, { value: "FAKE-ADDR" });
  await assert.rejects(bao.bao({ token: bao.intakeToken }).read(grantPath(anna.id)));
  const app = new TenantSecrets(bao.bao({ token: bao.token }), anna.id);
  assert.match(String((await app.get("notion", "oauth"))?.refresh_token), /^fake-notion-refresh-/);
  await app.put("notion", "oauth", { ...grantOf(anna.id)!, at: "x" });
  await assert.rejects(app.get("profile", "address.home"), "nothing else of hers");
  await assert.rejects(new TenantSecrets(bao.bao({ token: bao.tokenFor(bea.id) }), anna.id).get("notion", "oauth"), "another friend's token reaches only her own folder");
});

test("admin: the tenants list shows each friend's capabilities and whether her Google and Notion are connected, never a token", async () => {
  const dee = person("Dee", ["intake", "notion", "google", "mail", "calendar"]);
  L.recordDone(dee.id, "notion", [{ name: "notion connection", chars: 40 }]);
  const lines = describeTenants();
  const mine = lines.find((l) => l.startsWith(`${dee.id} (`))!;
  assert.match(mine, /capabilities [^;]*intake[^;]*notion[^;]*google[^;]*mail[^;]*calendar/);
  assert.match(mine, /connections: google not connected yet, notion connected since \d{4}-\d\d-\d\d/);
  const pia = lines.find((l) => l.startsWith(`${plain.id} (`))!;
  assert.ok(!/connections:/.test(pia), "nothing to connect: no connection words");
  assert.match(lines[0]!, /^owner .*capabilities .*notion/, "the owner's line is as it was");
  assert.ok(!lines.join("\n").includes("fake-notion"));
});

test("doctor: a notion line appears only when a friend has the capability; it names what is missing, never a value, and each friend's connection", async () => {
  const out: { ok: unknown; what: string; detail: string }[] = [];
  const line = (ok: boolean | "warn", what: string, detail = "") => void out.push({ ok, what, detail });
  notionCheck(line, { friends: T.people().filter((r) => !r.capabilities.includes("notion")) });
  assert.equal(out.length, 0, "nobody has it: no line");
  const friends = T.people().filter((r) => r.id !== "owner" && r.capabilities.includes("notion"));
  notionCheck(line, { friends, baseUrl: undefined });
  assert.equal(out[0]!.ok, false);
  assert.match(out[0]!.detail, /INTAKE_BASE_URL is not set/);
  out.length = 0;
  notionCheck(line, { friends, baseUrl: "https://ted.example.test", registered: false, state: (t) => (t === anna.id ? { state: "connected", at: "2026-10-20T10:00:00Z" } : t === bea.id ? { state: "reconnect", at: "2026-10-21T10:00:00Z" } : { state: "none" }) });
  assert.equal(out[0]!.what, "notion for friends: client");
  assert.match(out[0]!.detail, /not registered yet/);
  assert.match(out.find((o) => o.what.endsWith(anna.id))!.detail, /connected since 2026-10-20/);
  assert.equal(out.find((o) => o.what.endsWith(anna.id))!.ok, true);
  assert.match(out.find((o) => o.what.endsWith(bea.id))!.detail, /no longer accepts her connection/);
  assert.equal(out.find((o) => o.what.endsWith(bea.id))!.ok, "warn");
  out.length = 0;
  notionCheck(line, { friends, baseUrl: "https://ted.example.test", registered: true, state: () => ({ state: "none" }) });
  assert.match(out[0]!.detail, /registered with Notion for https:\/\/ted\.example\.test/);
  assert.ok(!JSON.stringify(out).includes("fake-notion"));
  // the intake token's check knows the notion items too
  const lines: string[] = [];
  await intakeCheck((ok, what, detail = "") => void lines.push(`${ok} ${what} ${detail}`), { cfg: { ...settings.intake, baseUrl: "https://ted.example.test" }, bao: () => bao.bao({ token: bao.intakeToken }), keychain: { get: async () => "x" } as never, probe: async () => true });
  assert.ok(lines.some((l) => /^true intake write-only token .*notion/.test(l)), lines.join("\n"));
});
