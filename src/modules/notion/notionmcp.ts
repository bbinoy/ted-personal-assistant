import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { credentialedProxy, SessionHub, UpstreamError, UpstreamSession, type Opened, type SessionLimits } from "../../intake/mcpproxy.ts";
import { NotionReconnect, notionTokens, type NotionTokens } from "../../intake/notionoauth.ts";
import { settings } from "../../core/settings.ts";

// A friend's Notion tools (the `notion` capability): Notion's HOSTED MCP server (settings.notion.mcpUrl) called over https with HER access token. The token is held by
// this process and added to every request to the hosted server HERE (a fetch of the transport, below); the model's run gets only the in-process proxy of mcpproxy.ts
// (type "sdk"), never an http server config with a bearer header, because the SDK would hand that header to the Claude CLI on its command line, where `ps` shows it.
// The access token is renewed before it ends (notionoauth.ts NotionTokens: rotating refresh tokens, one lock per person, the new refresh token stored first), at the start
// of every run (the proxy's tool listing) and again for every request.

export interface NotionConfig {
  url: string;
  idleMs: number;
  callMs: number;
  fetch?: typeof fetch; // tests
}

export const notionConfig = (): NotionConfig => ({ url: settings.notion.mcpUrl, idleMs: 10 * 60_000, /* a friend's connection to the hosted server is closed after this long unused */ callMs: 60_000 /* one tool call */ });

export class NotionSession extends UpstreamSession {
  protected readonly label = "her Notion connection";
  private readonly cfg: () => NotionConfig;
  private readonly tokens: NotionTokens;

  constructor(tenantId: string, tokens: NotionTokens = notionTokens(), cfg: () => NotionConfig = notionConfig) {
    super(tenantId);
    this.tokens = tokens;
    this.cfg = cfg;
  }

  protected limits(): SessionLimits {
    const c = this.cfg();
    return { idleMs: c.idleMs, callMs: c.callMs };
  }

  // Renews her access token if it is about to end (and finds out whether she has to connect again) before a run starts using the server.
  override async prepare(): Promise<void> {
    await this.tokens.accessToken(this.tenantId);
  }

  protected async open(): Promise<Opened> {
    const c = this.cfg();
    const doFetch = c.fetch ?? fetch;
    const tenant = this.tenantId;
    const tokens = this.tokens;
    // The bearer is added to each request here, from the token as it is right now (a renewed one included); it exists nowhere else.
    const transport = new StreamableHTTPClientTransport(new URL(c.url), {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${await tokens.accessToken(tenant)}`);
        return doFetch(input, { ...init, headers });
      },
    });
    return { transport };
  }
}

export type NotionHub = SessionHub<NotionSession>;
export const notionHub: NotionHub = new SessionHub((id) => new NotionSession(id));

// What the model reads when her Notion cannot be used. A fixed sentence; the one thing it is told to DO is the reconnect.
export const RECONNECT_TEXT =
  "Notion is not connected for her right now: she never connected it, or her permission expired or was withdrawn. Tell her so in your reply and offer to send her a new link: call get_setup_link with purpose \"notion\" and put the link in your reply. Do not try Notion again until she has connected.";

export const notionUnavailable = (e: unknown): string => (e instanceof NotionReconnect ? RECONNECT_TEXT : e instanceof UpstreamError ? `Notion is not available for her right now: ${e.message}.` : "Notion is not available for her right now.");

// The in-process MCP server of a friend's run (see the top of this file). `tools`: the names her run may be offered at all (the module's rows): when her connection needs
// her, the run is still shown these, so that trying one tells the model what to say, instead of the tools silently missing.
export function notionProxy(tenantId: string, allowed: (name: string) => boolean, tools: readonly string[], hub: NotionHub = notionHub): McpSdkServerConfigWithInstance {
  const stand = (name: string): Tool => ({ name, description: "Notion (her connection needs her to connect again: calling this says how).", inputSchema: { type: "object", additionalProperties: true } });
  return credentialedProxy({
    name: "notion",
    session: () => hub.session(tenantId),
    allowed,
    unavailable: notionUnavailable,
    placeholders: (e) => (e instanceof NotionReconnect ? tools.map(stand) : undefined),
  });
}
