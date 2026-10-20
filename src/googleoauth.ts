import { createHash, randomBytes } from "node:crypto";
import { settings } from "./settings.ts";

// "Connect Google" on the intake page (intakeserver.ts): the OAuth authorisation-code flow with PKCE (S256), offline access (a refresh token), and a `state` that
// is random, single-use, short-lived and BOUND TO THE ONE-TIME LINK it was started from. The page shows a link to Google's consent screen (made when the page is
// shown), Google sends her browser back to /oauth/google/callback?code=...&state=..., and the page exchanges the code at the token endpoint, with the client secret
// and the PKCE verifier, for a refresh token. The token goes straight into HER OpenBao path through the write-only intake token; the model never sees it, and nothing
// here logs or returns it: every message is a fixed sentence.
//
// The endpoints are settings (GOOGLE_OAUTH_AUTH_URL, GOOGLE_OAUTH_TOKEN_URL) so that tests run the whole flow against a fake token endpoint.

export class OAuthProblem extends Error {} // a fixed sentence for the person at the page; never holds a token, a code or the server's own words

export interface OAuthConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  baseUrl: string | undefined; // the intake page's public address: the redirect URI is <this>/oauth/google/callback
}

export const CALLBACK_PATH = "/oauth/google/callback";
export const STATE = /^[A-Za-z0-9_-]{43}$/; // 256 random bits as base64url

export const settingsConfig = (): OAuthConfig => ({ clientId: settings.google.clientId, clientSecret: settings.google.clientSecret, authUrl: settings.google.authUrl, tokenUrl: settings.google.tokenUrl, scopes: settings.google.scopes, baseUrl: settings.intake.baseUrl });

const sha = (s: string) => createHash("sha256").update(s).digest();
const b64 = (b: Buffer) => b.toString("base64url");

// Pure: a PKCE pair. The challenge is the S256 hash of the verifier.
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64(randomBytes(48)); // 64 characters, inside the 43 to 128 the spec allows
  return { verifier, challenge: b64(sha(verifier)) };
}

// Pure: the consent screen's address. offline + prompt=consent: a refresh token comes back every time she connects.
export function authorizeUrl(cfg: OAuthConfig, state: string, challenge: string): string {
  const u = new URL(cfg.authUrl);
  u.search = new URLSearchParams({
    client_id: cfg.clientId!,
    redirect_uri: `${cfg.baseUrl}${CALLBACK_PATH}`,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

// Pure: the address in an id_token (the token endpoint's own answer over TLS, so its signature is not the question here). Undefined when there is none.
export function emailOf(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown; email_verified?: unknown };
    return typeof claims.email === "string" && /^[^\s@<>"]+@[^\s@<>"]+$/.test(claims.email) && claims.email.length <= 200 ? claims.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export interface Grant {
  refreshToken: string;
  email: string;
  scope: string;
}

interface Pending {
  code: string; // the one-time link this flow started from
  tenant: string;
  verifier: string;
  expires: number;
}

export interface OAuthDeps {
  cfg?: () => OAuthConfig;
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number; // how long a flow may take from the page to the callback
}

const MAX_PENDING = 500;

// The flows in progress, in memory (the page is one process; a restart loses them and she opens her link again, which is still valid).
export class GoogleOAuth {
  private readonly cfg: () => OAuthConfig;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly byState = new Map<string, Pending>(); // sha256(state) -> flow
  private readonly byLink = new Map<string, string>(); // link code -> its current state hash: a link has one flow at a time

  constructor(o: OAuthDeps = {}) {
    this.cfg = o.cfg ?? settingsConfig;
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.ttl = o.ttlMs ?? 10 * 60_000;
  }

  // Can a flow be started at all (the client is set up and the redirect address exists)?
  ready(): boolean {
    const c = this.cfg();
    return !!c.clientId && !!c.clientSecret && !!c.baseUrl;
  }

  private sweep(): void {
    const t = this.now();
    for (const [h, p] of this.byState) if (p.expires <= t) (this.byState.delete(h), this.byLink.get(p.code) === h && this.byLink.delete(p.code));
  }

  // The consent address for this link. A link that is shown again gets a new state (the old one stops working).
  begin(code: string, tenant: string): string {
    this.sweep();
    const old = this.byLink.get(code);
    if (old) this.byState.delete(old);
    if (this.byState.size >= MAX_PENDING) throw new OAuthProblem("Too many sign-ins are in progress. Try again in a few minutes.");
    const state = b64(randomBytes(32));
    const { verifier, challenge } = pkce();
    const h = sha(state).toString("hex");
    this.byState.set(h, { code, tenant, verifier, expires: this.now() + this.ttl });
    this.byLink.set(code, h);
    return authorizeUrl(this.cfg(), state, challenge);
  }

  // The flow a callback's state belongs to, used up by this call: a replayed or forged state finds nothing.
  take(state: string): Pending | undefined {
    this.sweep();
    if (!STATE.test(state)) return undefined;
    const h = sha(state).toString("hex");
    const p = this.byState.get(h);
    if (!p) return undefined;
    this.byState.delete(h);
    if (this.byLink.get(p.code) === h) this.byLink.delete(p.code);
    return p;
  }

  // The code from Google's redirect for a refresh token. Every failure is one fixed sentence.
  async exchange(authCode: string, verifier: string): Promise<Grant> {
    const c = this.cfg();
    let res: Response;
    try {
      res = await this.doFetch(c.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: `${c.baseUrl}${CALLBACK_PATH}`, client_id: c.clientId!, client_secret: c.clientSecret!, code_verifier: verifier }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new OAuthProblem("Google could not be reached. Nothing was saved; try the same link again in a moment.");
    }
    let body: { refresh_token?: unknown; id_token?: unknown; scope?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* not JSON: handled below */
    }
    if (!res.ok) throw new OAuthProblem("Google did not accept the sign-in. Nothing was saved; try the same link again.");
    const email = emailOf(body.id_token);
    if (typeof body.refresh_token !== "string" || !body.refresh_token) {
      throw new OAuthProblem("Google did not hand over a long-lived permission. Remove this app at myaccount.google.com/permissions and try the same link again.");
    }
    if (!email) throw new OAuthProblem("Google did not say which account this is. Nothing was saved; try the same link again.");
    const scope = typeof body.scope === "string" ? body.scope : "";
    const granted = new Set(scope.split(/\s+/));
    if (granted.has("email")) granted.add("https://www.googleapis.com/auth/userinfo.email"); // (Google may name it either way)
    // The consent screen lets her untick single permissions: a grant missing one is no use for the tools, so it is not stored.
    if (c.scopes.some((s) => !granted.has(s))) throw new OAuthProblem("Not every permission was ticked on Google's page, and the assistant needs them all to read and write your mail and calendar. Nothing was saved; open the same link again and allow everything.");
    return { refreshToken: body.refresh_token, email, scope };
  }
}
