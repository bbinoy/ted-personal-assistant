import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { connectionState, markNeedsReconnect } from "../../intake/intakelinks.ts";
import { credentialedProxy, SessionHub, UpstreamError, UpstreamSession, type Opened, type SessionLimits, type ToolResult } from "../../intake/mcpproxy.ts";
import { appBao, GOOGLE_ITEM, TenantSecrets } from "../../secrets/secrets.ts";
import { settings } from "../../core/settings.ts";

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

class GoogleError extends UpstreamError {}
// Her connection is not usable until she connects again: never made, or Google no longer accepts her permission (revoked, expired, the grant gone). The proxy tells the run so
// and offers the setup link, like Notion's NotionReconnect (intake/notionoauth.ts).
export class GoogleReconnect extends GoogleError {}

const PURPOSE = "google"; // the intake purpose she connects again with (intakepurposes.ts)

// Pure: does this tool result say that Google no longer accepts her grant? Only an error result that names the refused grant, or the server's own "authentication needed"
// message at the very START of a short result: mail she reads is someone else's text (a mail that says "ACTION REQUIRED" must not disconnect her), and it never starts that way.
// UNVERIFIED LIVE against the pinned server's wording, like the rest of this file: the first revoked grant is the check.
export function grantGone(r: { text: string; isError: boolean }): boolean {
  if (r.isError && /invalid_grant|expired or revoked|revoked|RefreshError|refresh token.{0,40}(invalid|expired)|re-?authenticat|authentication (is )?(needed|required)/i.test(r.text.slice(0, 2000))) return true;
  return r.text.length < 1500 && /^[\s*#>-]*(ACTION REQUIRED:?\s*)?Google Authentication (Needed|Required)/i.test(r.text);
}

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
  // A friend's server process is closed after this long unused (started again on demand: OpenBao read, temp folder, Python start, token refresh). It is the heartbeat interval plus a margin (at least 20),
  // so a look within the hour finds her server running; the price is one resident Python process per friend with Google while the heartbeat ticks.
  idleMs: Math.max(20, settings.heartbeatMinutes + 5) * 60_000,
  callMs: 60_000, // one tool call
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
async function readGrant(tenantId: string): Promise<GoogleGrant | undefined> {
  const item = await new TenantSecrets(appBao(), tenantId).get("google", GOOGLE_ITEM, { cache: false });
  const refreshToken = item?.refresh_token;
  const email = item?.email;
  return typeof refreshToken === "string" && refreshToken && typeof email === "string" && email.includes("@") ? { refreshToken, email } : undefined;
}

// The file name the server gives an account's credentials (python urllib.parse.quote(email, safe="@._-")).
export const credentialFile = (email: string): string => `${email.replace(/[^A-Za-z0-9@._~-]/g, (c) => [...Buffer.from(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""))}.json`;

// One friend's server process: started on first use, closed after the idle time of googleConfig() without use (or when the app stops: modules/runtime.ts), started again on demand.
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
    if (!grant) throw new GoogleReconnect("she has not connected Google yet");
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

  // Before a run starts using her server, and before every call: if Google refused her grant earlier (marked below) she is not connected until she signs in again, which
  // clears the mark (intakelinks.ts connectionState: a newer completed form). Reads one small file; no server is started for it.
  override async prepare(): Promise<void> {
    if (connectionState(this.tenantId, PURPOSE).state === "reconnect") throw new GoogleReconnect("her Google permission expired or was withdrawn");
  }

  // A call whose answer is "Google no longer accepts her grant" is not a tool failure the model can fix: it is recorded (she is told to reconnect, the admin's list and the
  // doctor show it), her server is stopped (it holds the dead token), and the run is told to ask her to connect again.
  override async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const r = await super.call(name, args);
    if (!grantGone(r)) return r;
    markNeedsReconnect(this.tenantId, PURPOSE);
    this.close();
    throw new GoogleReconnect("her Google permission expired or was withdrawn");
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

// What the model reads when her Google cannot be used. A fixed sentence; the one thing it is told to DO is the reconnect (the same as for Notion, notionmcp.ts).
export const GOOGLE_RECONNECT_TEXT =
  'Google is not connected for her right now: she never connected it, or her permission expired or was withdrawn. Tell her so in your reply and offer to send her a new link: call get_setup_link with purpose "google" and put the link in your reply. Do not try Google again until she has connected.';

const googleUnavailable = (e: unknown): string => (e instanceof GoogleReconnect ? GOOGLE_RECONNECT_TEXT : e instanceof UpstreamError ? `Google is not available for her right now: ${e.message}.` : "Google is not available for her right now.");

// find_person's Google Contacts source (modules/people): one search through HER session, with HER address put in last, so it can only ever read her own contacts. It is not a tool of
// her run (no row): the text goes to find_person, which fences it. A failure is a short plain reason (never a token: the session's errors are fixed sentences), not the model's problem.
export async function searchContacts(tenantId: string, query: string, hub: GoogleHub = googleHub): Promise<string> {
  try {
    const s = hub.session(tenantId);
    await s.prepare();
    if (!s.address) await s.tools(); // starts her server and learns her address
    if (!s.address) throw new GoogleError("her Google account is not known");
    const r = await s.call("search_contacts", { query, page_size: 10, user_google_email: s.address });
    if (r.isError) throw new GoogleError("Google would not search her contacts (she may need to connect Google again to allow contacts)");
    return r.text;
  } catch (e) {
    throw new Error(e instanceof GoogleReconnect ? "she has not connected Google, or her permission expired" : e instanceof UpstreamError ? e.message : "it did not answer");
  }
}

// ---- what the model's run gets: a proxy to her server, no command line, no environment (mcpproxy.ts) ----

// The in-process MCP server of a friend's run. `allowed`: the tools her run is offered (its capability set); anything else is refused here too. Every call is forwarded
// with `user_google_email` set to HER address, whatever the model wrote, so a call cannot reach (or start a sign-in for) another account.
export function googleProxy(tenantId: string, allowed: (name: string) => boolean, hub: GoogleHub = googleHub, tools: readonly string[] = []): McpSdkServerConfigWithInstance {
  const stand = (name: string): Tool => ({ name, description: "Google (her connection needs her to connect again: calling this says how).", inputSchema: { type: "object", additionalProperties: true } });
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
    unavailable: googleUnavailable,
    placeholders: (e) => (e instanceof GoogleReconnect ? tools.map(stand) : undefined),
  });
}
