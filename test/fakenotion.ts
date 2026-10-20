import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A stand-in for Notion's hosted MCP server and its OAuth server, in one process on loopback: discovery documents, dynamic client registration, the token endpoint
// (authorization code with PKCE, and refresh with ROTATION: a refresh token works once, the one before it is dead), and an MCP endpoint at /mcp that answers only a
// request whose bearer is a live access token. Every token is an obviously fake string; each sign-in (a code exchange) is a separate "chain" of tokens, like a
// separate person's grant. Nothing here talks to Notion.

export interface Chain {
  access: string;
  refresh: string;
  accessDead: boolean;
}

export interface FakeNotion {
  url: string; // the origin
  mcpUrl: string;
  registrations: { client_name: unknown; redirect_uris: unknown; grant_types: unknown; token_endpoint_auth_method: unknown }[];
  tokenCalls: { grant_type: string; client_id: string; refresh_token?: string; code?: string; resource?: string }[];
  mcpCalls: { bearer: string | undefined; method: string; tool?: string; args?: unknown }[];
  mode: { refresh: "ok" | "revoked" | "down"; delayMs: number; expiresIn: number; discovery: "ok" | "broken" };
  chains: Chain[]; // every sign-in, with its current pair
  expect(code: string, challenge: string): void; // the browser leg: this code was issued for a request with this PKCE challenge
  chainOf(access: string): Chain | undefined;
  expireAccess(access: string): void; // this access token stops working (a call with it gets 401)
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });

export async function startFakeNotion(): Promise<FakeNotion> {
  const codes = new Map<string, string>(); // code -> challenge
  let n = 0;
  const f: FakeNotion = {
    url: "",
    mcpUrl: "",
    registrations: [],
    tokenCalls: [],
    mcpCalls: [],
    mode: { refresh: "ok", delayMs: 0, expiresIn: 28_800, discovery: "ok" },
    chains: [],
    expect: (code, challenge) => void codes.set(code, challenge),
    chainOf: (access) => f.chains.find((c) => c.access === access),
    expireAccess: (access) => void (f.chainOf(access)!.accessDead = true),
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
  const issue = (chain?: Chain) => {
    n++;
    const c = chain ?? { access: "", refresh: "", accessDead: false };
    Object.assign(c, { access: `fake-notion-access-${n}-not-real`, refresh: `fake-notion-refresh-${n}-not-real`, accessDead: false });
    if (!chain) f.chains.push(c);
    return { access_token: c.access, refresh_token: c.refresh, expires_in: f.mode.expiresIn, token_type: "bearer" };
  };
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  const mcp = async (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const body = raw ? JSON.parse(raw) : undefined;
    f.mcpCalls.push({ bearer, method: body?.method ?? req.method ?? "", tool: body?.params?.name, args: body?.params?.arguments });
    const chain = bearer ? f.chainOf(bearer) : undefined;
    if (!chain || chain.accessDead) return void res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    const server = new Server({ name: "fake-notion", version: "1.0.0" }, { capabilities: { tools: {} } });
    const tool = (name: string) => ({ name, description: `Fake ${name}`, inputSchema: { type: "object" as const, properties: { query: { type: "string" } }, additionalProperties: true } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page", "notion-create-comment", "notion-move-pages", "notion-get-users", "notion-create-database"].map(tool) }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text" as const, text: `fake ${r.params.name} in the workspace of chain ${f.chains.indexOf(chain)}: ${JSON.stringify(r.params.arguments ?? {})}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const path = (req.url ?? "").split("?")[0]!;
    if (path === "/mcp") return void mcp(req, res, raw).catch(() => res.headersSent || res.writeHead(500).end());
    if (f.mode.discovery === "broken" && path.startsWith("/.well-known/")) return void res.writeHead(404).end();
    if (path === "/.well-known/oauth-protected-resource") return json(res, 200, { resource: f.mcpUrl, authorization_servers: [f.url] });
    if (path === "/.well-known/oauth-authorization-server") return json(res, 200, { issuer: f.url, authorization_endpoint: `${f.url}/authorize`, token_endpoint: `${f.url}/token`, registration_endpoint: `${f.url}/register`, code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"] });
    if (path === "/register" && req.method === "POST") {
      const b = JSON.parse(raw);
      f.registrations.push({ client_name: b.client_name, redirect_uris: b.redirect_uris, grant_types: b.grant_types, token_endpoint_auth_method: b.token_endpoint_auth_method });
      return json(res, 201, { client_id: `fake-notion-client-${f.registrations.length}`, redirect_uris: b.redirect_uris, token_endpoint_auth_method: "none" });
    }
    if (path === "/token" && req.method === "POST") {
      const p = new URLSearchParams(raw);
      f.tokenCalls.push({ grant_type: p.get("grant_type") ?? "", client_id: p.get("client_id") ?? "", refresh_token: p.get("refresh_token") ?? undefined, code: p.get("code") ?? undefined, resource: p.get("resource") ?? undefined });
      if (f.mode.delayMs) await new Promise((r) => setTimeout(r, f.mode.delayMs));
      if (p.get("grant_type") === "authorization_code") {
        const challenge = codes.get(p.get("code") ?? "");
        codes.delete(p.get("code") ?? "");
        if (!challenge || createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== challenge || !p.get("client_id")?.startsWith("fake-notion-client-")) return json(res, 400, { error: "invalid_grant" });
        return json(res, 200, issue());
      }
      if (p.get("grant_type") === "refresh_token") {
        if (f.mode.refresh === "down") return json(res, 503, { error: "temporarily_unavailable" });
        if (f.mode.refresh === "revoked") return json(res, 400, { error: "invalid_grant" });
        const chain = f.chains.find((c) => c.refresh === p.get("refresh_token")); // rotation: only a chain's newest refresh token works
        if (!p.get("client_id")?.startsWith("fake-notion-client-") || !chain) return json(res, 400, { error: "invalid_grant" });
        return json(res, 200, issue(chain));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    res.writeHead(404).end();
  });
  server.unref();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.mcpUrl = `${f.url}/mcp`;
  return f;
}
