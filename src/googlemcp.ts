import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { credentialedProxy, SessionHub, UpstreamError, UpstreamSession, type Opened, type SessionLimits } from "./mcpproxy.ts";
import { appBao, GOOGLE_ITEM, TenantSecrets } from "./secrets.ts";
import { settings } from "./settings.ts";

// A friend's Google tools (the `google` capability): the pinned third-party MCP server (docs/SETUP.md "Google for friends", settings.google: GOOGLE_MCP_COMMAND and
// GOOGLE_MCP_ARGS, by default taylorwilsdon/google_workspace_mcp as `workspace-mcp`, stdio, single-user) run as ONE PROCESS PER FRIEND, started by THIS process.
//
// Why this process starts it and not the model's CLI: the SDK hands an MCP server's command, arguments and environment to the Claude CLI on ITS COMMAND LINE
// (--mcp-config <json>), where any local user's `ps` can read them. A friend's refresh token must never be there. So the token goes only
//   OpenBao (her own path tenants/<id>/google/oauth)  ->  this process's memory  ->  a file in a private temp folder (0700) read by her server process  ->  deleted when it stops
// and the model's run gets a small in-process MCP server (googleProxy below, type "sdk": no command line, no environment) that forwards the calls the run is allowed
// to make to her server. The token is never in a log, an audit row, a prompt, an error message or a tool result. The session lifecycle and the proxy are the ones every
// credentialed service shares (mcpproxy.ts); this file is what is Google's: the process, the credential file and her address.
//
// What the server needs (read from its code at the pinned version, see plans/google-mcp-spike.md): in stdio single-user mode it reads the credentials of the account
// in USER_GOOGLE_EMAIL from <WORKSPACE_MCP_CREDENTIALS_DIR>/<email>.json ({token, refresh_token, token_uri, client_id, client_secret, scopes, expiry}) and refreshes the
// access token itself with the OAuth client's id and secret. Its "stateless" mode needs OAuth 2.1 over HTTP and does not take a token from the environment.

export class GoogleError extends UpstreamError {}

export interface GoogleGrant {
  refreshToken: string;
  email: string;
}

export interface GoogleConfig {
  command: string;
  args: readonly string[];
  clientId: string | undefined;
  clientSecret: string | undefined;
  tokenUrl: string;
  scopes: readonly string[];
  idleMs: number;
  callMs: number;
  tmpRoot?: string; // where her private credentials folder is made (default: the system temp folder; tests use their own)
  env?: Record<string, string>; // extra, non-secret environment for the server process (tests)
}

export const googleConfig = (): GoogleConfig => ({
  command: settings.google.command,
  args: settings.google.args,
  clientId: settings.google.clientId,
  clientSecret: settings.google.clientSecret,
  tokenUrl: settings.google.tokenUrl,
  scopes: settings.google.scopes,
  idleMs: settings.google.idleMinutes * 60_000,
  callMs: settings.google.callSeconds * 1000,
  tmpRoot: tmpdir(),
});

// The prefix of the private folders made here (and the only ones the start-up sweep touches).
export const TMP_PREFIX = "ted-google-";

// A folder left behind by a process that died without closing its sessions (a crash, a kill, a power cut) holds a refresh token. At start-up, before any session of
// this process exists, those are removed: only entries of the temp root that carry our prefix, are real directories (not links), belong to this user, are 0700 (as
// they were made) and are older than `minAgeMs` (so a folder of a process that is running right now is left alone). Returns how many were removed.
export function sweepStaleCredentialDirs(root: string = tmpdir(), minAgeMs = 5 * 60_000, now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    try {
      const path = join(root, name);
      const st = lstatSync(path);
      if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0 || now - st.mtimeMs < minAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      /* gone meanwhile, or not ours to remove */
    }
  }
  return removed;
}

// Her grant, from her own OpenBao path with the app's token (its policy reads tenants/+/google/* and nothing else of hers: openbaoadmin.ts).
export async function readGrant(tenantId: string): Promise<GoogleGrant | undefined> {
  const item = await new TenantSecrets(appBao(), tenantId).get("google", GOOGLE_ITEM, { cache: false });
  const refreshToken = item?.refresh_token;
  const email = item?.email;
  return typeof refreshToken === "string" && refreshToken && typeof email === "string" && email.includes("@") ? { refreshToken, email } : undefined;
}

// The file name the server gives an account's credentials (python urllib.parse.quote(email, safe="@._-")).
export const credentialFile = (email: string): string => `${email.replace(/[^A-Za-z0-9@._~-]/g, (c) => [...Buffer.from(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""))}.json`;

// One friend's server process: started on first use, closed after GOOGLE_MCP_IDLE_MINUTES without use (or when the app stops: modules/runtime.ts), started again on demand.
export class GoogleSession extends UpstreamSession {
  protected readonly label = "her Google server";
  private readonly cfg: () => GoogleConfig;
  private readonly grant: (tenantId: string) => Promise<GoogleGrant | undefined>;
  private email: string | undefined;

  constructor(tenantId: string, cfg: () => GoogleConfig = googleConfig, grant: (tenantId: string) => Promise<GoogleGrant | undefined> = readGrant) {
    super(tenantId);
    this.cfg = cfg;
    this.grant = grant;
  }

  protected limits(): SessionLimits {
    const c = this.cfg();
    return { idleMs: c.idleMs, callMs: c.callMs };
  }
  // Her address (known once her server has started): what the proxy puts into every call, so a call can never name another account.
  get address(): string | undefined {
    return this.email;
  }

  protected async open(): Promise<Opened> {
    const cfg = this.cfg();
    if (!cfg.clientId || !cfg.clientSecret) throw new GoogleError("Google is not set up on this instance (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET)");
    let grant: GoogleGrant | undefined;
    try {
      grant = await this.grant(this.tenantId);
    } catch {
      throw new GoogleError("her Google connection could not be read (is the secret store running?)");
    }
    if (!grant) throw new GoogleError("she has not connected Google yet");
    const dir = mkdtempSync(join(cfg.tmpRoot ?? tmpdir(), TMP_PREFIX)); // 0700
    try {
      chmodSync(dir, 0o700);
      writeFileSync(join(dir, credentialFile(grant.email)), JSON.stringify({ token: null, refresh_token: grant.refreshToken, token_uri: cfg.tokenUrl, client_id: cfg.clientId, client_secret: cfg.clientSecret, scopes: [...cfg.scopes], expiry: null }), { mode: 0o600 });
    } catch {
      rmSync(dir, { recursive: true, force: true });
      throw new GoogleError("her Google server did not start");
    }
    this.email = grant.email;
    // The child gets no part of this process's environment but what its transport adds (HOME, PATH, ...): not the owner's login, not the instance key.
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: [...cfg.args],
      env: { ...cfg.env, WORKSPACE_MCP_CREDENTIALS_DIR: dir, USER_GOOGLE_EMAIL: grant.email, MCP_SINGLE_USER_MODE: "1", GOOGLE_OAUTH_CLIENT_ID: cfg.clientId, GOOGLE_OAUTH_CLIENT_SECRET: cfg.clientSecret },
      stderr: "ignore", // its log lines name accounts and mail: not kept
    });
    return { transport, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  // Her address, once her server is up (starts it if it is not).
  async account(): Promise<string> {
    await this.ready();
    return this.email!;
  }
}

// All friends' sessions: one process each, never shared.
export type GoogleHub = SessionHub<GoogleSession>;
export const googleHub: GoogleHub = new SessionHub((id) => new GoogleSession(id));

// ---- what the model's run gets: a proxy to her server, no command line, no environment (mcpproxy.ts) ----

// The in-process MCP server of a friend's run. `allowed`: the tools her run is offered (its capability set); anything else is refused here too. Every call is forwarded
// with `user_google_email` set to HER address, whatever the model wrote, so a call cannot reach (or start a sign-in for) another account.
export function googleProxy(tenantId: string, allowed: (name: string) => boolean, hub: GoogleHub = googleHub): McpSdkServerConfigWithInstance {
  return credentialedProxy({
    name: "google",
    session: () => hub.session(tenantId),
    allowed,
    arguments: async (args) => {
      const session = hub.session(tenantId);
      if (!session.address) await session.tools(); // starts her server and learns her address
      // Fail closed: without her address the call is not forwarded at all (it would name whatever account the model wrote, or start a sign-in).
      if (!session.address) throw new GoogleError("her Google account is not known");
      return { ...args, user_google_email: session.address }; // last, so nothing the model wrote can replace it
    },
    unavailable: (e) => (e instanceof UpstreamError ? `Google is not available for her right now: ${e.message}.` : "Google is not available for her right now."),
  });
}
