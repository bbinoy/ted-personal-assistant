import { OAuthProblem, postForm, type OAuthProvider } from "./oauth.ts";
import { googleReady, settings } from "../core/settings.ts";

// Google as an OAuthProvider (oauth.ts has the flow): the consent screen asks for offline access (a refresh token comes back every time she connects) with the
// scopes the tools need, the token endpoint is asked with the client secret and the PKCE verifier, and the answer must name the account (an id_token) and carry every
// scope. The grant stored is her refresh token, her address and the scopes: tenants/<id>/google/oauth, read by the process that starts her Google server (googlemcp.ts).
//
// The endpoints are settings (GOOGLE_OAUTH_AUTH_URL, GOOGLE_OAUTH_TOKEN_URL) so that tests run the whole flow against a fake token endpoint.

export interface GoogleOAuthConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
}

export const settingsConfig = (): GoogleOAuthConfig => ({ clientId: settings.google.clientId, clientSecret: settings.google.clientSecret, authUrl: settings.google.authUrl, tokenUrl: settings.google.tokenUrl, scopes: settings.google.scopes });

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

export function googleProvider(cfg: () => GoogleOAuthConfig = settingsConfig): OAuthProvider {
  return {
    id: "google",
    name: "Google",
    store: { kind: "google", name: "oauth" },
    ready: () => googleReady(cfg()),
    // Pure in effect: the consent screen's address. offline + prompt=consent: a refresh token comes back every time she connects.
    async authorizeUrl({ state, challenge, redirectUri }) {
      const c = cfg();
      const u = new URL(c.authUrl);
      u.search = new URLSearchParams({ client_id: c.clientId!, redirect_uri: redirectUri, response_type: "code", scope: c.scopes.join(" "), access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
      return u.toString();
    },
    async exchange({ code, verifier, redirectUri, fetch: doFetch }) {
      const c = cfg();
      const res = await postForm(doFetch, c.tokenUrl, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: c.clientId!, client_secret: c.clientSecret!, code_verifier: verifier }));
      if (!res) throw new OAuthProblem("Google could not be reached. Nothing was saved; try the same link again in a moment.");
      if (!res.ok) throw new OAuthProblem("Google did not accept the sign-in. Nothing was saved; try the same link again.");
      const body = res.body as { refresh_token?: unknown; id_token?: unknown; scope?: unknown };
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
      return { data: { refresh_token: body.refresh_token, email, scope }, chars: email.length, account: email };
    },
  };
}
