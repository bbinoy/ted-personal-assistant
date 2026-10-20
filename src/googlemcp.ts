import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { appBao, GOOGLE_ITEM, TenantSecrets } from "./secrets.ts";
import { settings } from "./settings.ts";

// A friend's Google tools (the `google` capability): the pinned third-party MCP server (docs/SETUP.md "Google for friends", settings.google: GOOGLE_MCP_COMMAND and
// GOOGLE_MCP_ARGS, by default taylorwilsdon/google_workspace_mcp as `workspace-mcp`, stdio, single-user) run as ONE PROCESS PER FRIEND, started by THIS process.
//
// Why this process starts it and not the model's CLI: the SDK hands an MCP server's command, arguments and environment to the Claude CLI on ITS COMMAND LINE
// (--mcp-config <json>), where any local user's `ps` can read them. A friend's refresh token must never be there. So the token goes only
//   OpenBao (her own path tenants/<id>/google/oauth)  ->  this process's memory  ->  a file in a private temp folder (0700) read by her server process  ->  deleted when it stops
// and the model's run gets a small in-process MCP server (googleProxy below, type "sdk": no command line, no environment) that forwards the calls the run is allowed
// to make to her server. The token is never in a log, an audit row, a prompt, an error message or a tool result.
//
// What the server needs (read from its code at the pinned version, see plans/google-mcp-spike.md): in stdio single-user mode it reads the credentials of the account
// in USER_GOOGLE_EMAIL from <WORKSPACE_MCP_CREDENTIALS_DIR>/<email>.json ({token, refresh_token, token_uri, client_id, client_secret, scopes, expiry}) and refreshes the
// access token itself with the OAuth client's id and secret. Its "stateless" mode needs OAuth 2.1 over HTTP and does not take a token from the environment.

export class GoogleError extends Error {}

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
});

// Her grant, from her own OpenBao path with the app's token (its policy reads tenants/+/google/* and nothing else of hers: openbaoadmin.ts).
export async function readGrant(tenantId: string): Promise<GoogleGrant | undefined> {
  const item = await new TenantSecrets(appBao(), tenantId).get("google", GOOGLE_ITEM, { cache: false });
  const refreshToken = item?.refresh_token;
  const email = item?.email;
  return typeof refreshToken === "string" && refreshToken && typeof email === "string" && email.includes("@") ? { refreshToken, email } : undefined;
}

// The file name the server gives an account's credentials (python urllib.parse.quote(email, safe="@._-")).
export const credentialFile = (email: string): string => `${email.replace(/[^A-Za-z0-9@._~-]/g, (c) => [...Buffer.from(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""))}.json`;

export interface ToolResult {
  text: string;
  isError: boolean;
  content: unknown[];
}

// One friend's server process: started on first use, closed after GOOGLE_MCP_IDLE_MINUTES without use, started again on demand.
export class GoogleSession {
  readonly tenantId: string;
  private readonly cfg: () => GoogleConfig;
  private readonly grant: (tenantId: string) => Promise<GoogleGrant | undefined>;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private starting: Promise<Client> | undefined;
  private dir: string | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private listed: Tool[] | undefined;
  private email: string | undefined;
  starts = 0; // how many processes this session has started (tests, doctor)

  constructor(tenantId: string, cfg: () => GoogleConfig = googleConfig, grant: (tenantId: string) => Promise<GoogleGrant | undefined> = readGrant) {
    this.tenantId = tenantId;
    this.cfg = cfg;
    this.grant = grant;
  }

  get running(): boolean {
    return !!this.client;
  }
  // Her address (known once her server has started): what the proxy puts into every call, so a call can never name another account.
  get address(): string | undefined {
    return this.email;
  }

  private async start(): Promise<Client> {
    const cfg = this.cfg();
    if (!cfg.clientId || !cfg.clientSecret) throw new GoogleError("Google is not set up on this instance (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET)");
    let grant: GoogleGrant | undefined;
    try {
      grant = await this.grant(this.tenantId);
    } catch {
      throw new GoogleError("her Google connection could not be read (is the secret store running?)");
    }
    if (!grant) throw new GoogleError("she has not connected Google yet");
    const dir = mkdtempSync(join(tmpdir(), "ted-google-")); // 0700
    this.dir = dir;
    try {
      chmodSync(dir, 0o700);
      writeFileSync(join(dir, credentialFile(grant.email)), JSON.stringify({ token: null, refresh_token: grant.refreshToken, token_uri: cfg.tokenUrl, client_id: cfg.clientId, client_secret: cfg.clientSecret, scopes: [...cfg.scopes], expiry: null }), { mode: 0o600 });
      // The child gets no part of this process's environment but what its transport adds (HOME, PATH, ...): not the owner's login, not the instance key.
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: [...cfg.args],
        env: { ...cfg.env, WORKSPACE_MCP_CREDENTIALS_DIR: dir, USER_GOOGLE_EMAIL: grant.email, MCP_SINGLE_USER_MODE: "1", GOOGLE_OAUTH_CLIENT_ID: cfg.clientId, GOOGLE_OAUTH_CLIENT_SECRET: cfg.clientSecret },
        stderr: "ignore", // its log lines name accounts and mail: not kept
      });
      const client = new Client({ name: "ted-google", version: "1.0.0" });
      client.onclose = () => {
        if (this.client === client) this.reset();
      };
      await client.connect(transport, { timeout: Math.max(cfg.callMs, 30_000) });
      this.client = client;
      this.transport = transport;
      this.email = grant.email;
      this.starts++;
      return client;
    } catch (e) {
      this.reset();
      if (e instanceof GoogleError) throw e;
      throw new GoogleError("her Google server did not start");
    }
  }

  private reset(): void {
    clearTimeout(this.idle);
    const client = this.client;
    const pid = this.transport?.pid;
    this.client = undefined;
    this.transport = undefined;
    // Stopped at once (a server with no state to keep): the SDK's own close waits for it to leave by itself and gives up quietly if it does not.
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    this.listed = undefined;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
    void client?.close().catch(() => {});
  }

  private async ready(): Promise<Client> {
    if (!this.client) this.starting ??= this.start().finally(() => (this.starting = undefined));
    const client = this.client ?? (await this.starting!);
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.cfg().idleMs);
    this.idle.unref();
    return client;
  }

  // Her address, once her server is up (starts it if it is not).
  async account(): Promise<string> {
    await this.ready();
    return this.email!;
  }

  async tools(): Promise<Tool[]> {
    const client = await this.ready();
    try {
      return (this.listed ??= (await client.listTools(undefined, { timeout: this.cfg().callMs })).tools);
    } catch {
      this.reset();
      throw new GoogleError("her Google server did not answer");
    }
  }

  // One tool call. A tool that fails is a result with isError (the model reads it); a server that is gone is a GoogleError and is started again next time.
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.ready();
    try {
      const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: this.cfg().callMs })) as { content?: unknown[]; isError?: boolean };
      const content = Array.isArray(res.content) ? res.content : [];
      const text = content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).filter(Boolean).join("\n");
      return { text, isError: res.isError === true, content };
    } catch (e) {
      if ((e as { code?: number }).code === -32001) throw new GoogleError("her Google server took too long"); // a request timeout: the process stays
      this.reset();
      throw new GoogleError("her Google server did not answer");
    }
  }

  close(): void {
    this.reset();
  }
}

// All friends' sessions: one process each, never shared.
export class GoogleHub {
  private readonly sessions = new Map<string, GoogleSession>();
  private readonly make: (tenantId: string) => GoogleSession;
  constructor(make: (tenantId: string) => GoogleSession = (id) => new GoogleSession(id)) {
    this.make = make;
  }
  session(tenantId: string): GoogleSession {
    let s = this.sessions.get(tenantId);
    if (!s) this.sessions.set(tenantId, (s = this.make(tenantId)));
    return s;
  }
  drop(tenantId: string): void {
    this.sessions.get(tenantId)?.close();
    this.sessions.delete(tenantId);
  }
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.drop(id);
  }
  get open(): string[] {
    return [...this.sessions.entries()].filter(([, s]) => s.running).map(([id]) => id);
  }
}

export const googleHub = new GoogleHub();

// ---- what the model's run gets: a proxy to her server, no command line, no environment ----

const MAX_DESCRIPTION = 1500; // a third party's words in the model's tool list: bounded

// The in-process MCP server of a friend's run. `allowed`: the tools her run is offered (its capability set); anything else is refused here too. Every call is forwarded
// with `user_google_email` set to HER address, whatever the model wrote, so a call cannot reach (or start a sign-in for) another account.
export function googleProxy(tenantId: string, allowed: (name: string) => boolean, hub: GoogleHub = googleHub): McpSdkServerConfigWithInstance {
  const server = new Server({ name: "google", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await hub.session(tenantId).tools()).filter((t) => allowed(t.name)).map((t) => ({ ...t, description: (t.description ?? "").slice(0, MAX_DESCRIPTION) })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!allowed(name)) return { content: [{ type: "text" as const, text: `${name} is not available.` }], isError: true };
    const session = hub.session(tenantId);
    try {
      const args = { ...(req.params.arguments ?? {}) } as Record<string, unknown>;
      if (!session.address) await session.tools(); // starts her server and learns her address
      if (session.address) args.user_google_email = session.address;
      const r = await session.call(name, args);
      return { content: r.content as { type: "text"; text: string }[], isError: r.isError };
    } catch (e) {
      return { content: [{ type: "text" as const, text: e instanceof GoogleError ? `Google is not available for her right now: ${e.message}.` : "Google is not available for her right now." }], isError: true };
    }
  });
  return { type: "sdk", name: "google", instance: server as unknown as McpSdkServerConfigWithInstance["instance"] };
}
