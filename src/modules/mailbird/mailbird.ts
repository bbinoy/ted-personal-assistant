import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, fetch as undiciFetch } from "undici";
import { LIMITS } from "../../core/sanitize.ts";

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

// The two things of the MCP client this file uses; a test hands the class a fake.
export interface Session {
  callTool(req: { name: string; arguments: Record<string, unknown> }, schema: undefined, opts: { timeout: number }): Promise<unknown>;
  close(): Promise<void>;
}

const CONNECT_MS = 10_000; // a Mailbird that is not answering must not stall the approval of a send, or a command, forever
const CALL_MS = 60_000;

async function openSession(): Promise<Session> {
  const { url, headerName, headerValue } = connectionDetails();
  // Mailbird's cert is self-signed. Verification is off for this one loopback connection only.
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { [headerName]: headerValue } },
    fetch: ((u: any, init: any) => undiciFetch(u, { ...init, dispatcher })) as any,
  });
  const client = new Client({ name: "agent-harness", version: "0.1.0" });
  await client.connect(transport);
  return client as unknown as Session;
}

// A request that timed out may have run on Mailbird's side (a send, an archive): it is never repeated by itself. Anything else that throws (a closed socket, a session
// Mailbird forgot after a restart) happened before or instead of the work, so the call is made once more on a fresh connection.
const timedOut = (e: unknown): boolean => /timed? ?out/i.test((e as Error)?.message ?? "") || (e as { code?: number })?.code === -32001;

export class Mailbird {
  private client: Session | undefined;

  private readonly open: () => Promise<Session>;
  private readonly connectMs: number;

  constructor(open: () => Promise<Session> = openSession, connectMs = CONNECT_MS) {
    this.open = open;
    this.connectMs = connectMs;
  }

  async connect(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const opening = this.open();
    try {
      this.client = await Promise.race([opening, new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`mailbird connect timed out after ${this.connectMs} ms`)), this.connectMs)))]);
    } catch (e) {
      opening.then((late) => late.close().catch(() => {}), () => {}); // a connection that comes up after the timeout is not left open
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Calls a tool and returns parsed JSON when the result is JSON text, else the raw text. The client built once for the process outlives Mailbird restarts: when the
  // connection itself fails it is closed and forgotten, and the call is made once more on a new one (never after a timeout, see above).
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}, retry = true): Promise<T> {
    if (!this.client) await this.connect();
    let res: any;
    try {
      // A hung call must not stall a command forever: fail after 60s, and reconnect next time.
      res = await this.client!.callTool({ name, arguments: args }, undefined, { timeout: CALL_MS });
    } catch (e) {
      void this.close().catch(() => {}); // the dead connection is forgotten at once; closing it is not waited for
      if (!retry || timedOut(e)) throw e;
      return this.call<T>(name, args, false);
    }
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
