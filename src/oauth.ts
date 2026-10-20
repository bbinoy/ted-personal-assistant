import { createHash, randomBytes } from "node:crypto";
import { settings } from "./settings.ts";

// "Connect <service>" on the intake page (intakeserver.ts) for EVERY service a friend signs in to (Google: googleoauth.ts, Notion: notionoauth.ts): the OAuth
// authorisation-code flow with PKCE (S256) and a `state` that is random, single-use, short-lived and BOUND TO THE ONE-TIME LINK it was started from. The page shows
// a link to the service's consent screen (made when the page is shown), the service sends her browser back to /oauth/<service>/callback?code=...&state=..., and the
// page exchanges the code at the token endpoint with the PKCE verifier for a grant. The grant goes straight into HER OpenBao path through the write-only intake
// token; the model never sees it, and nothing here logs or returns it: every message is a fixed sentence.
//
// Everything that is the same for every service is here (the flows in progress, the state, the PKCE pair, the token request). What differs is an OAuthProvider:
// its consent address, how its token endpoint is asked and what it hands back, and where the grant is stored. The endpoints are settings or discovered, so tests
// run the whole flow against fake servers.

export class OAuthProblem extends Error {} // a fixed sentence for the person at the page; never holds a token, a code or the server's own words

export const STATE = /^[A-Za-z0-9_-]{43}$/; // 256 random bits as base64url
export const callbackPath = (provider: string): string => `/oauth/${provider}/callback`;
export const CALLBACK = /^\/oauth\/([a-z][a-z0-9-]{0,19})\/callback$/;

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
  store: { kind: "google" | "notion"; name: string };
  ready(): boolean; // can a flow be started at all (the client is set up)?
  // The consent screen's address. May register the instance's client the first time (Notion); fails with an OAuthProblem in a fixed sentence.
  authorizeUrl(a: { state: string; challenge: string; redirectUri: string; fetch: typeof fetch }): Promise<string>;
  // The code from the redirect for a grant: the item to store (fields of the item, never logged), and what the status line says about it (a count, no value).
  exchange(a: { code: string; verifier: string; redirectUri: string; fetch: typeof fetch }): Promise<{ data: Record<string, unknown>; chars: number }>;
}

export interface Pending {
  provider: string;
  code: string; // the one-time link this flow started from
  tenant: string;
  verifier: string;
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
  redirectUri(id: string): string {
    return `${this.baseUrl()}${callbackPath(id)}`;
  }

  private sweep(): void {
    const t = this.now();
    for (const [h, p] of this.byState) if (p.expires <= t) (this.byState.delete(h), this.byLink.get(p.code) === h && this.byLink.delete(p.code));
  }

  // The consent address for this link. A link that is shown again gets a new state (the old one stops working).
  async begin(id: string, code: string, tenant: string): Promise<string> {
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
    this.byState.set(h, { provider: id, code, tenant, verifier, expires: this.now() + this.ttl });
    this.byLink.set(code, h);
    return url;
  }

  // The flow a callback's state belongs to, used up by this call: a replayed or forged state, or one of another service, finds nothing.
  take(id: string, state: string): Pending | undefined {
    this.sweep();
    if (!STATE.test(state)) return undefined;
    const h = sha(state).toString("hex");
    const p = this.byState.get(h);
    if (!p || p.provider !== id) return undefined;
    this.byState.delete(h);
    if (this.byLink.get(p.code) === h) this.byLink.delete(p.code);
    return p;
  }

  // The code from the redirect for a grant. Every failure is one fixed sentence.
  async exchange(id: string, authCode: string, verifier: string): Promise<{ data: Record<string, unknown>; chars: number }> {
    return this.providers.get(id)!.exchange({ code: authCode, verifier, redirectUri: this.redirectUri(id), fetch: this.doFetch });
  }
}
