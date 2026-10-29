import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { settings } from "../core/settings.ts";
import type { ItemKind } from "../secrets/secrets.ts";

// "Connect <service>" on the intake page (intakeserver.ts) for EVERY service a friend signs in to (Google: googleoauth.ts, Notion: notionoauth.ts): the OAuth
// authorisation-code flow with PKCE (S256) and a `state` that is random, single-use, short-lived and BOUND TO THE ONE-TIME LINK it was started from. The page shows
// a link to the service's consent screen (made when the page is shown), the service sends her browser back to /oauth/<service>/callback?code=...&state=..., and the
// page exchanges the code at the token endpoint with the PKCE verifier for a grant. The grant goes straight into HER OpenBao path through the write-only intake
// token; the model never sees it, and nothing here logs or returns it: every message is a fixed sentence.
//
// The state is bound to the BROWSER too: the page that shows the consent link sets an HttpOnly cookie holding a random binding (scoped to the callback path), the
// flow keeps only its hash, and the callback needs the same cookie. Without it, a consent address copied from one person's page and opened by another person
// would store the second person's grant under the first one's path (a login-CSRF); with it, that callback finds nothing.
//
// Everything that is the same for every service is here (the flows in progress, the state, the PKCE pair, the token request). What differs is an OAuthProvider:
// its consent address, how its token endpoint is asked and what it hands back, and where the grant is stored. The endpoints are settings or discovered, so tests
// run the whole flow against fake servers.

export class OAuthProblem extends Error {} // a fixed sentence for the person at the page; never holds a token, a code or the server's own words

const STATE = /^[A-Za-z0-9_-]{43}$/; // 256 random bits as base64url
const callbackPath = (provider: string): string => `/oauth/${provider}/callback`;
export const CALLBACK = /^\/oauth\/([a-z][a-z0-9-]{0,19})\/callback$/;

// The cookie that binds a flow to the browser that was shown its link: HttpOnly, SameSite=Lax (sent on the service's redirect back, a top-level GET), only for the
// callback path, Secure when the page is on https, gone when the flow would expire.
const COOKIE_PREFIX = "ted_oauth_";
export const bindingCookie = (provider: string, binding: string, secure: boolean, maxAgeSec: number): string =>
  `${COOKIE_PREFIX}${provider}=${binding}; Path=${callbackPath(provider)}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
export function bindingFrom(cookieHeader: string | undefined, provider: string): string {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === `${COOKIE_PREFIX}${provider}`) return v.join("=");
  }
  return "";
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const b64 = (b: Buffer) => b.toString("base64url");

// Pure: a PKCE pair. The challenge is the S256 hash of the verifier.
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64(randomBytes(48)); // 64 characters, inside the 43 to 128 the spec allows
  return { verifier, challenge: b64(sha(verifier)) };
}

// A form POST to a token (or registration-like) endpoint: redirects are errors, bounded in time, the answer parsed as JSON when it is. Undefined: not reachable.
export async function postForm(doFetch: typeof fetch, url: string, params: URLSearchParams, timeoutMs = 15_000): Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | undefined> {
  let res: Response;
  try {
    res = await doFetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: params.toString(), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return undefined;
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    /* not JSON: the caller looks at ok and status */
  }
  return { ok: res.ok, status: res.status, body };
}

// What differs per service.
export interface OAuthProvider {
  id: string; // the purpose of the setup link and the callback's path segment
  name: string; // for the person at the page ("Google")
  // Where the grant is stored: her folder <kind>, item <name> (intakestore.ts).
  store: { kind: ItemKind; name: string };
  ready(): boolean; // can a flow be started at all (the client is set up)?
  // The consent screen's address. May register the instance's client the first time (Notion); fails with an OAuthProblem in a fixed sentence.
  authorizeUrl(a: { state: string; challenge: string; redirectUri: string; fetch: typeof fetch }): Promise<string>;
  // The code from the redirect for a grant: the item to store (fields of the item, never logged), and what the status line says about it (a count, no value).
  // `account`: whom the grant is for, when the service says (shown on the "connected" page so that a mismatch is visible; not logged).
  exchange(a: { code: string; verifier: string; redirectUri: string; fetch: typeof fetch }): Promise<{ data: Record<string, unknown>; chars: number; account?: string }>;
}

export interface Pending {
  provider: string;
  code: string; // the one-time link this flow started from
  tenant: string;
  verifier: string;
  binding: string; // sha256 (hex) of the cookie value that was set on the browser shown the link
  expires: number;
}

export interface FlowDeps {
  providers: readonly OAuthProvider[];
  baseUrl?: () => string | undefined; // the intake page's public address: the redirect URI is <this>/oauth/<provider>/callback
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number; // how long a flow may take from the page to the callback
}

const MAX_PENDING = 500;

// The flows in progress, in memory (the page is one process; a restart loses them and she opens her link again, which is still valid).
export class OAuthFlows {
  private readonly providers: ReadonlyMap<string, OAuthProvider>;
  private readonly baseUrl: () => string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly byState = new Map<string, Pending>(); // sha256(state) -> flow
  private readonly byLink = new Map<string, string>(); // link code -> its current state hash: a link has one flow at a time

  constructor(o: FlowDeps) {
    this.providers = new Map(o.providers.map((p) => [p.id, p]));
    this.baseUrl = o.baseUrl ?? (() => settings.intake.baseUrl);
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.ttl = o.ttlMs ?? 10 * 60_000;
  }

  provider(id: string): OAuthProvider | undefined {
    return this.providers.get(id);
  }
  // Can a flow be started for this service (its client is set up and the redirect address exists)?
  ready(id: string): boolean {
    return !!this.providers.get(id)?.ready() && !!this.baseUrl();
  }
  get ttlSeconds(): number {
    return Math.ceil(this.ttl / 1000);
  }
  // Is the page on https (then the binding cookie is Secure)?
  secure(): boolean {
    return /^https:/i.test(this.baseUrl() ?? "");
  }
  redirectUri(id: string): string {
    return `${this.baseUrl()}${callbackPath(id)}`;
  }

  private sweep(): void {
    const t = this.now();
    for (const [h, p] of this.byState) if (p.expires <= t) (this.byState.delete(h), this.byLink.get(p.code) === h && this.byLink.delete(p.code));
  }

  // The consent address for this link and the binding the page must set as a cookie on this browser. A link that is shown again gets a new state and binding
  // (the old ones stop working).
  async begin(id: string, code: string, tenant: string): Promise<{ url: string; binding: string }> {
    const provider = this.providers.get(id);
    if (!provider) throw new OAuthProblem("This sign-in is not available.");
    this.sweep();
    const old = this.byLink.get(code);
    if (old) this.byState.delete(old);
    if (this.byState.size >= MAX_PENDING) throw new OAuthProblem("Too many sign-ins are in progress. Try again in a few minutes.");
    const state = b64(randomBytes(32));
    const { verifier, challenge } = pkce();
    const url = await provider.authorizeUrl({ state, challenge, redirectUri: this.redirectUri(id), fetch: this.doFetch });
    const h = sha(state).toString("hex");
    const binding = b64(randomBytes(32));
    this.byState.set(h, { provider: id, code, tenant, verifier, binding: sha(binding).toString("hex"), expires: this.now() + this.ttl });
    this.byLink.set(code, h);
    return { url, binding };
  }

  // The flow a callback's state belongs to, used up by this call: a replayed or forged state, one of another service, or one that arrives without the binding
  // cookie of the browser that was shown the link (compared in constant time) finds nothing.
  take(id: string, state: string, binding: string): Pending | undefined {
    this.sweep();
    if (!STATE.test(state)) return undefined;
    const h = sha(state).toString("hex");
    const p = this.byState.get(h);
    if (!p || p.provider !== id) return undefined;
    this.byState.delete(h);
    if (this.byLink.get(p.code) === h) this.byLink.delete(p.code);
    const want = Buffer.from(p.binding);
    const got = Buffer.from(sha(binding).toString("hex"));
    return want.length === got.length && timingSafeEqual(want, got) ? p : undefined;
  }

  // The code from the redirect for a grant. Every failure is one fixed sentence.
  async exchange(id: string, authCode: string, verifier: string): Promise<{ data: Record<string, unknown>; chars: number; account?: string }> {
    return this.providers.get(id)!.exchange({ code: authCode, verifier, redirectUri: this.redirectUri(id), fetch: this.doFetch });
  }
}
