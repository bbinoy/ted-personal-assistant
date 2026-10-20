import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

// ONE credentialed MCP proxy for every service a friend connects with her own account (googlemcp.ts: a per-friend stdio process; notionmcp.ts: the hosted Notion MCP
// over https). Why a proxy at all: the Agent SDK hands an MCP server's command, arguments, environment and http headers to the Claude CLI on ITS COMMAND LINE
// (--mcp-config <json>), where any local user's `ps` can read a token. So the credential never goes into the run's mcpServers. THIS process holds it (in an
// UpstreamSession, below, which connects to the real server), and the run gets a small in-process server of type "sdk" (credentialedProxy) that has no command line, no
// environment and no headers, and forwards the calls the run is allowed to make. The token is in no log, audit row, prompt, error message or tool result: everything
// a failure says here is a fixed sentence.
//
// A service plugs in by saying how its connection is opened (`open`: the transport and what to delete when it closes) and how its failures read (`label`).

export class UpstreamError extends Error {}

export interface ToolResult {
  text: string;
  isError: boolean;
  content: unknown[];
}

export interface Opened {
  transport: Transport;
  cleanup?: () => void; // run when the connection closes (a private folder of credentials, ...)
}

export interface SessionLimits {
  idleMs: number;
  callMs: number;
}

// One friend's connection to her service: opened on first use, closed after `idleMs` without use, opened again on demand.
export abstract class UpstreamSession {
  readonly tenantId: string;
  private client: Client | undefined;
  private transport: Transport | undefined;
  private cleanup: (() => void) | undefined;
  private starting: Promise<Client> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private listed: Tool[] | undefined;
  starts = 0; // how many connections this session has opened (tests, doctor)

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  // How a failure reads to the model: "her Google server" -> "her Google server did not start".
  protected abstract readonly label: string;
  protected abstract limits(): SessionLimits;
  // Opens the connection: reads her credential and builds the transport. Throws an UpstreamError with a fixed sentence when it cannot.
  protected abstract open(): Promise<Opened>;
  // Called at the start of every run (the proxy's tool listing): the place to renew a credential that is about to expire.
  async prepare(): Promise<void> {}

  get running(): boolean {
    return !!this.client;
  }

  private async start(): Promise<Client> {
    const opened = await this.open();
    this.cleanup = opened.cleanup;
    this.transport = opened.transport;
    try {
      const client = new Client({ name: "ted-credentialed-proxy", version: "1.0.0" });
      client.onclose = () => {
        if (this.client === client) this.reset();
      };
      await client.connect(opened.transport, { timeout: Math.max(this.limits().callMs, 30_000) });
      this.client = client;
      this.starts++;
      return client;
    } catch (e) {
      this.reset();
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(`${this.label} did not start`);
    }
  }

  protected reset(): void {
    clearTimeout(this.idle);
    const client = this.client;
    const pid = (this.transport as { pid?: number | null } | undefined)?.pid;
    const cleanup = this.cleanup;
    this.client = undefined;
    this.transport = undefined;
    this.cleanup = undefined;
    // A process is stopped at once (a server with no state to keep): the SDK's own close waits for it to leave by itself and gives up quietly if it does not.
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    this.listed = undefined;
    cleanup?.();
    void client?.close().catch(() => {});
  }

  protected async ready(): Promise<Client> {
    if (!this.client) this.starting ??= this.start().finally(() => (this.starting = undefined));
    const client = this.client ?? (await this.starting!);
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.limits().idleMs);
    this.idle.unref();
    return client;
  }

  async tools(): Promise<Tool[]> {
    const client = await this.ready();
    try {
      return (this.listed ??= (await client.listTools(undefined, { timeout: this.limits().callMs })).tools);
    } catch {
      this.reset();
      throw new UpstreamError(`${this.label} did not answer`);
    }
  }

  // One tool call. A tool that fails is a result with isError (the model reads it); a connection that is gone is an UpstreamError and is opened again next time.
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.ready();
    try {
      const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: this.limits().callMs })) as { content?: unknown[]; isError?: boolean };
      const content = Array.isArray(res.content) ? res.content : [];
      const text = content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).filter(Boolean).join("\n");
      return { text, isError: res.isError === true, content };
    } catch (e) {
      if ((e as { code?: number }).code === -32001) throw new UpstreamError(`${this.label} took too long`); // a request timeout: the connection stays
      this.reset();
      throw new UpstreamError(`${this.label} did not answer`);
    }
  }

  close(): void {
    this.reset();
  }
}

// All friends' sessions of one service: one each, never shared.
export class SessionHub<S extends UpstreamSession> {
  private readonly sessions = new Map<string, S>();
  private readonly make: (tenantId: string) => S;
  constructor(make: (tenantId: string) => S) {
    this.make = make;
  }
  session(tenantId: string): S {
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

// ---- what the model's run gets ----

const MAX_DESCRIPTION = 1500; // a third party's words in the model's tool list: bounded

export interface ProxyOptions {
  name: string; // the server name the run knows it under: its tools are mcp__<name>__<tool>
  session: () => UpstreamSession; // looked up per request, so a dropped session is not kept alive
  allowed: (tool: string) => boolean; // the tools her run is offered (its capability set); anything else is refused here too
  // The arguments of a call as they are forwarded (a service that names an account in every call puts HER account in, whatever the model wrote).
  arguments?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  // What the model reads when the service cannot be used right now. Must never hold a token; the session's own errors are fixed sentences.
  unavailable: (e: unknown) => string;
  // What the run is shown when her connection is not usable and needs HER (not connected, expired): placeholder tools, so the model can still try one and be told what to do.
  placeholders?: (e: unknown) => Tool[] | undefined;
}

// The in-process MCP server of one friend's run: type "sdk", no command line, no environment, no headers.
export function credentialedProxy(o: ProxyOptions): McpSdkServerConfigWithInstance {
  const server = new Server({ name: o.name, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const s = o.session();
      await s.prepare();
      return { tools: (await s.tools()).filter((t) => o.allowed(t.name)).map((t) => ({ ...t, description: (t.description ?? "").slice(0, MAX_DESCRIPTION) })) };
    } catch (e) {
      const stand = o.placeholders?.(e);
      if (stand) return { tools: stand.filter((t) => o.allowed(t.name)) };
      throw e;
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!o.allowed(name)) return { content: [{ type: "text" as const, text: `${name} is not available.` }], isError: true };
    try {
      const s = o.session();
      await s.prepare();
      const args = { ...(req.params.arguments ?? {}) } as Record<string, unknown>;
      const r = await s.call(name, o.arguments ? await o.arguments(args) : args);
      return { content: r.content as { type: "text"; text: string }[], isError: r.isError };
    } catch (e) {
      return { content: [{ type: "text" as const, text: o.unavailable(e) }], isError: true };
    }
  });
  return { type: "sdk", name: o.name, instance: server as unknown as McpSdkServerConfigWithInstance["instance"] };
}
