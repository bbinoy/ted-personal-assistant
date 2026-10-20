import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, fetch as undiciFetch } from "undici";
import { LIMITS } from "./sanitize.ts";

// Direct MCP client for Mailbird's local server: no model call, no mcp-remote.
// Connection details come from the same entry Claude Code uses, read here so the
// bearer token never passes through a model.
// The host must BE the loopback address: "https://127.0.0.1.example.com" starts with the same characters but is another machine, and
// this connection skips certificate checks and sends a bearer token.
const isLoopbackUrl = (a: unknown): a is string => {
  try {
    const u = new URL(String(a));
    return (u.protocol === "https:" || u.protocol === "http:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
};

// Pure: the connection details from the "mailbird" entry of ~/.claude.json.
export function connectionFrom(cfg: { args?: unknown } | undefined): { url: string; headerName: string; headerValue: string } {
  const args: string[] = Array.isArray(cfg?.args) ? cfg.args.map(String) : [];
  const url = args.find(isLoopbackUrl);
  const header = args[args.indexOf("--header") + 1];
  if (!url || !header) throw new Error("mailbird MCP entry not found in ~/.claude.json");
  const [headerName, ...rest] = header.split(": ");
  return { url, headerName: headerName!, headerValue: rest.join(": ") };
}

const connectionDetails = () => connectionFrom(JSON.parse(readFileSync(`${process.env.HOME}/.claude.json`, "utf8")).mcpServers?.mailbird);

export class Mailbird {
  private client: Client | undefined;

  async connect(): Promise<void> {
    const { url, headerName, headerValue } = connectionDetails();
    // Mailbird's cert is self-signed. Verification is off for this one loopback connection only.
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { [headerName]: headerValue } },
      fetch: ((u: any, init: any) => undiciFetch(u, { ...init, dispatcher })) as any,
    });
    const client = new Client({ name: "agent-harness", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  // Calls a tool and returns parsed JSON when the result is JSON text, else the raw text.
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) await this.connect();
    // A hung call must not stall a command forever: fail after 60s, reconnect next time.
    const res: any = await this.client!.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    const text: string = res.content?.find((c: any) => c.type === "text")?.text ?? "";
    if (res.isError) throw new Error(`mailbird ${name} failed: ${text.slice(0, LIMITS.preview)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    await client?.close();
  }
}
