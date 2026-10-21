import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { markNeedsReconnect } from "./intakelinks.ts";
import { UpstreamError } from "./mcpproxy.ts";
import { OAuthProblem, postForm, type OAuthProvider } from "./oauth.ts";
import type { Data } from "../secrets/openbao.ts";
import { appBao, NOTION_ITEM, TenantSecrets } from "../secrets/secrets.ts";
import { settings } from "../core/settings.ts";
import { dataPath, readJson, writeJson } from "../core/state.ts";
import { instancePaths } from "../core/convpaths.ts";

// Notion for friends, the sign-in half (the calls to the hosted server are notionmcp.ts). Notion runs a hosted MCP server (settings.notion.mcpUrl, by default
// https://mcp.notion.com/mcp) that gives a person access by HER OWN workspace permissions after a one-click OAuth consent. As a client of it, this instance:
//
//   1. DISCOVERS the server's OAuth endpoints: the MCP server's /.well-known/oauth-protected-resource names its authorization server, whose
//      /.well-known/oauth-authorization-server lists the authorization, token and registration endpoints (RFC 9728 / 8414).
//   2. REGISTERS ONE CLIENT for the whole instance, once (RFC 7591 dynamic registration, a public client: no secret), with the redirect address
//      <INTAKE_BASE_URL>/oauth/notion/callback. Its id is remembered in instance/notion-client.json (an id is not a secret; the intake page, which has only a write-only
//      OpenBao token, must be able to read it). It is never registered again per person or per session: registering again orphans refresh tokens. Only a changed redirect
//      address (a new tunnel address) makes a new registration, and grants made under the old client keep refreshing, because each grant stores the client id it was issued to.
//   3. Runs the authorisation-code flow with PKCE (S256) that every service shares (oauth.ts), and stores her grant under tenants/<id>/notion/oauth.
//   4. KEEPS IT ALIVE (NotionTokens): Notion's access tokens last hours and its refresh tokens ROTATE (each refresh returns a new refresh token and retires the old one, with
//      a short grace). So a refresh is made under a per-person lock (two at once would each use the same old token and lose the rotation), sends the original client id, and
//      WRITES THE NEW REFRESH TOKEN TO HER OPENBAO PATH BEFORE the new access token is used for anything. A refresh Notion refuses for good (expired after the long
//      inactivity or absolute lifetime, revoked by her) is recorded (intakelinks.ts markNeedsReconnect) and surfaces as NotionReconnect, which the proxy turns into
//      "tell her to reconnect and make her a new link". A refresh that fails for any other reason (Notion down, a timeout) is a plain try-again-later and loses nothing.
//
// Nothing here puts a token in a log, an audit row, an error message or a tool result.

const SECURE_FETCH_MS = 15_000;

export interface Endpoints {
  authorization: string;
  token: string;
  registration: string;
}

// What is remembered of the one registration (instance/notion-client.json).
export interface ClientRecord {
  client_id: string;
  redirect_uri: string;
  mcp_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registered_at: string;
}
export const CLIENT_FILE = instancePaths().notionClient;
const LOCK_DIR = instancePaths().notionClientLock;

const NOT_NOW = "Notion's sign-in could not be set up right now. Nothing was saved; try the same link again in a moment.";

const httpsOnly = (u: string): boolean => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && settings.intake.allowHttpLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
};

async function getJson(doFetch: typeof fetch, url: string): Promise<Record<string, unknown> | undefined> {
  if (!httpsOnly(url)) return undefined;
  try {
    const res = await doFetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(SECURE_FETCH_MS) });
    if (!res.ok) return undefined;
    const body = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const wellKnown = (issuer: string, name: string): string[] => {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  return [...new Set([path ? `${u.origin}/.well-known/${name}${path}` : "", `${u.origin}/.well-known/${name}`].filter(Boolean))];
};

// Step 1. The endpoints of the server's authorization server. Every URL must be https (or loopback in tests) and the server must support PKCE S256 when it says what it supports.
export async function discover(mcpUrl: string, doFetch: typeof fetch = fetch): Promise<Endpoints> {
  let resource: Record<string, unknown> | undefined;
  for (const url of wellKnown(mcpUrl, "oauth-protected-resource")) {
    resource = await getJson(doFetch, url);
    if (Array.isArray(resource?.authorization_servers) && typeof resource.authorization_servers[0] === "string") break;
    resource = undefined;
  }
  const issuer = (resource?.authorization_servers as string[] | undefined)?.[0];
  if (!issuer || !httpsOnly(issuer)) throw new OAuthProblem(NOT_NOW);
  let meta: Record<string, unknown> | undefined;
  for (const url of [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")]) {
    meta = await getJson(doFetch, url);
    if (meta) break;
  }
  const field = (k: string): string | undefined => (typeof meta?.[k] === "string" && httpsOnly(meta[k] as string) ? (meta[k] as string) : undefined);
  const authorization = field("authorization_endpoint");
  const token = field("token_endpoint");
  const registration = field("registration_endpoint");
  const methods = meta?.code_challenge_methods_supported;
  if (!authorization || !token || !registration || (Array.isArray(methods) && !methods.includes("S256"))) throw new OAuthProblem(NOT_NOW);
  return { authorization, token, registration };
}

// Step 2. The remembered client, if it is the one for this redirect address and this server.
export function readClient(redirectUri: string, mcpUrl: string): ClientRecord | undefined {
  const c = readJson<Partial<ClientRecord>>(CLIENT_FILE, {});
  return typeof c.client_id === "string" && c.client_id && c.redirect_uri === redirectUri && c.mcp_url === mcpUrl && typeof c.authorization_endpoint === "string" && typeof c.token_endpoint === "string" ? (c as ClientRecord) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Registers the instance's client unless it is registered for this redirect address already. The agent and the intake page are two processes, so a lock directory
// keeps them from registering twice at the same moment (the loser waits and reads the winner's record).
export async function ensureClient(redirectUri: string, doFetch: typeof fetch = fetch, mcpUrl: string = settings.notion.mcpUrl, name: string = settings.assistant): Promise<ClientRecord> {
  const have = readClient(redirectUri, mcpUrl);
  if (have) return have;
  const lock = dataPath(LOCK_DIR);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch {
      // Held by the other process (or left by a crash: older than a minute, it is taken over).
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      await sleep(100);
      const now = readClient(redirectUri, mcpUrl);
      if (now) return now;
      if (i > 150) throw new OAuthProblem(NOT_NOW);
    }
  }
  try {
    const again = readClient(redirectUri, mcpUrl);
    if (again) return again;
    const ep = await discover(mcpUrl, doFetch);
    let res: Response;
    try {
      res = await doFetch(ep.registration, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
        redirect: "error",
        signal: AbortSignal.timeout(SECURE_FETCH_MS),
      });
    } catch {
      throw new OAuthProblem(NOT_NOW);
    }
    const body = (await res.json().catch(() => ({}))) as { client_id?: unknown; redirect_uris?: unknown };
    if (!res.ok || typeof body.client_id !== "string" || !body.client_id || (Array.isArray(body.redirect_uris) && !body.redirect_uris.includes(redirectUri))) throw new OAuthProblem(NOT_NOW);
    const rec: ClientRecord = { client_id: body.client_id, redirect_uri: redirectUri, mcp_url: mcpUrl, authorization_endpoint: ep.authorization, token_endpoint: ep.token, registered_at: new Date().toISOString() };
    writeJson(CLIENT_FILE, rec);
    return rec;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Is an instance client registered for this redirect address (the doctor: no secret in it)?
export const clientRegistered = (baseUrl: string | undefined, mcpUrl: string = settings.notion.mcpUrl): boolean => !!baseUrl && !!readClient(`${baseUrl}/oauth/notion/callback`, mcpUrl);

// ---- the grant ----

// What is stored at tenants/<id>/notion/oauth. expires_at is epoch milliseconds.
export interface NotionGrant {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  client_id: string;
  token_endpoint: string;
  [k: string]: unknown;
}

export function parseGrant(d: Data | undefined): NotionGrant | undefined {
  if (!d) return undefined;
  const { access_token, refresh_token, expires_at, client_id, token_endpoint } = d;
  return typeof access_token === "string" && typeof refresh_token === "string" && refresh_token && typeof expires_at === "number" && typeof client_id === "string" && client_id && typeof token_endpoint === "string" && httpsOnly(token_endpoint) ? (d as NotionGrant) : undefined;
}

const lifetime = (expiresIn: unknown): number => (typeof expiresIn === "number" && expiresIn > 0 && expiresIn < 30 * 86_400 ? expiresIn : 3600) * 1000;

// Step 3 as an OAuthProvider (oauth.ts has the flow).
export function notionProvider(o: { mcpUrl?: () => string } = {}): OAuthProvider {
  const mcp = o.mcpUrl ?? (() => settings.notion.mcpUrl);
  return {
    id: "notion",
    name: "Notion",
    store: { kind: "notion", name: NOTION_ITEM },
    ready: () => true, // the instance registers itself the first time (ensureClient); the page's address is checked by the flows
    async authorizeUrl({ state, challenge, redirectUri, fetch: doFetch }) {
      const client = await ensureClient(redirectUri, doFetch, mcp());
      const u = new URL(client.authorization_endpoint);
      u.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "consent", resource: mcp() }).toString();
      return u.toString();
    },
    async exchange({ code, verifier, redirectUri, fetch: doFetch }) {
      const client = readClient(redirectUri, mcp());
      if (!client) throw new OAuthProblem(NOT_NOW);
      const res = await postForm(doFetch, client.token_endpoint, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: mcp() }));
      if (!res) throw new OAuthProblem("Notion could not be reached. Nothing was saved; try the same link again in a moment.");
      if (!res.ok) throw new OAuthProblem("Notion did not accept the sign-in. Nothing was saved; try the same link again.");
      const b = res.body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
      if (typeof b.access_token !== "string" || !b.access_token) throw new OAuthProblem("Notion did not hand over an access. Nothing was saved; try the same link again.");
      if (typeof b.refresh_token !== "string" || !b.refresh_token) throw new OAuthProblem("Notion did not hand over a long-lived permission. Nothing was saved; try the same link again.");
      return { data: { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() + lifetime(b.expires_in), client_id: client.client_id, token_endpoint: client.token_endpoint }, chars: b.refresh_token.length };
    },
  };
}

// ---- step 4: the access token a call needs ----

// Her connection is not usable until she connects again: never made, expired, withdrawn. The proxy tells her so in the chat.
export class NotionReconnect extends UpstreamError {}

export interface GrantStore {
  read(tenant: string): Promise<Data | undefined>;
  write(tenant: string, data: Data): Promise<void>;
}

// Her grant in her own OpenBao path with the app's token (its policy reads and writes tenants/+/notion/*: openbaoadmin.ts; the write is the rotation).
export const openbaoGrants = (): GrantStore => ({
  read: (tenant) => new TenantSecrets(appBao(), tenant).get("notion", NOTION_ITEM, { cache: false }),
  write: (tenant, data) => new TenantSecrets(appBao(), tenant).put("notion", NOTION_ITEM, data),
});

export interface TokenDeps {
  store?: GrantStore;
  fetch?: typeof fetch;
  now?: () => number;
  marginMs?: () => number;
  reconnect?: (tenant: string) => void; // what is recorded when Notion refuses her refresh token for good
}

const GONE = new Set(["invalid_grant", "invalid_token", "invalid_client", "unauthorized_client", "access_denied", "expired_token", "token_expired"]);

export class NotionTokens {
  private readonly store: GrantStore;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly margin: () => number;
  private readonly reconnect: (tenant: string) => void;
  private readonly chain = new Map<string, Promise<unknown>>(); // per person: refreshes run one after the other
  private readonly unsaved = new Map<string, NotionGrant>(); // a refreshed grant whose write failed: its refresh token is the only valid one, so it is kept until it is written
  refreshes = 0; // how many refreshes went to Notion (tests, doctor)

  constructor(o: TokenDeps = {}) {
    this.store = o.store ?? openbaoGrants();
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.margin = o.marginMs ?? (() => settings.notion.refreshMarginSeconds * 1000);
    this.reconnect = o.reconnect ?? ((tenant) => markNeedsReconnect(tenant, "notion"));
  }

  private fresh(g: NotionGrant): boolean {
    return g.expires_at - this.now() > this.margin();
  }

  private async load(tenant: string): Promise<NotionGrant | undefined> {
    const held = this.unsaved.get(tenant);
    if (held) return held;
    try {
      return parseGrant(await this.store.read(tenant));
    } catch {
      throw new UpstreamError("her Notion connection could not be read (is the secret store running?)");
    }
  }

  // The access token for her next call, renewed first when it is about to end. Throws NotionReconnect when she must connect again, an UpstreamError when it is a matter of trying again.
  async accessToken(tenant: string): Promise<string> {
    const g = await this.load(tenant);
    if (!g) throw new NotionReconnect("she has not connected Notion yet");
    if (this.fresh(g) && !this.unsaved.has(tenant)) return g.access_token;
    return this.locked(tenant, () => this.renew(tenant));
  }

  // Runs one after another per person, so two refreshes never use the same old refresh token.
  private locked<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chain.get(tenant) ?? Promise.resolve()).catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.chain.set(tenant, tail);
    void tail.then(() => this.chain.get(tenant) === tail && this.chain.delete(tenant));
    return run;
  }

  private async renew(tenant: string): Promise<string> {
    const g = await this.load(tenant); // again, under the lock: the refresh before us may have done it
    if (!g) throw new NotionReconnect("she has not connected Notion yet");
    if (this.fresh(g)) {
      if (this.unsaved.has(tenant)) await this.save(tenant, g); // (a fresh grant that was never written: write it before anything uses it)
      return g.access_token;
    }
    const res = await postForm(this.doFetch, g.token_endpoint, new URLSearchParams({ grant_type: "refresh_token", refresh_token: g.refresh_token, client_id: g.client_id, resource: settings.notion.mcpUrl }));
    this.refreshes++;
    if (!res) throw new UpstreamError("Notion could not be reached");
    if (!res.ok) {
      const error = typeof res.body.error === "string" ? res.body.error : "";
      if ((res.status === 400 || res.status === 401 || res.status === 403) && (GONE.has(error) || res.status === 401)) {
        this.unsaved.delete(tenant);
        this.reconnect(tenant);
        throw new NotionReconnect("her Notion permission expired or was withdrawn");
      }
      throw new UpstreamError("Notion did not renew the access");
    }
    const b = res.body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof b.access_token !== "string" || !b.access_token) throw new UpstreamError("Notion did not renew the access");
    // The rotated refresh token (a server that does not rotate leaves the old one valid).
    const next: NotionGrant = { ...g, access_token: b.access_token, refresh_token: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : g.refresh_token, expires_at: this.now() + lifetime(b.expires_in) };
    await this.save(tenant, next); // BEFORE the new access token is used for anything
    return next.access_token;
  }

  private async save(tenant: string, g: NotionGrant): Promise<void> {
    this.unsaved.set(tenant, g);
    try {
      await this.store.write(tenant, g);
    } catch {
      throw new UpstreamError("her renewed Notion connection could not be saved (is the secret store running?)");
    }
    this.unsaved.delete(tenant);
  }
}

let shared: NotionTokens | undefined;
export const notionTokens = (): NotionTokens => (shared ??= new NotionTokens());
