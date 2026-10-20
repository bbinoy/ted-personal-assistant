import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CardStore, type CardRecord } from "../src/modules/browse/card.ts";
import { OpenBao } from "../src/openbao.ts";
import { TenantSecrets } from "../src/secrets.ts";

// An in-process stand-in for OpenBao's HTTP API (KV v2, health, token lookup, capabilities), for the unit tests. No real OpenBao and no real
// secret: tests put obviously fake values in. It enforces the same prefix rule the real policy does (a token reaches only its tenant's folder),
// so a test of "another tenant's token is refused" is a real one.

export interface FakeBao {
  url: string;
  mount: string;
  token: string; // a token limited to tenants/owner/
  tokenFor(tenant: string): string;
  intakeToken: string; // the intake page's write-only token: create and update of profile and card items of any tenant, nothing else
  store: Map<string, Record<string, unknown>>; // "tenants/owner/profile/email" -> data
  requests: { method: string; path: string; body: string; token: string | undefined }[];
  mode: { sealed: boolean; down: boolean; delayMs: number; garbage: boolean; policies: string[]; ttl: number };
  bao(o?: { cacheMs?: number; token?: string; timeoutMs?: number }): OpenBao;
  secrets(tenant?: string, o?: { cacheMs?: number }): TenantSecrets;
  close(): Promise<void>;
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });

export async function startFakeBao(mount = "ted"): Promise<FakeBao> {
  const store = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, string>(); // token -> tenant folder it may use
  const tokenFor = (tenant: string) => {
    const t = `fake-token-${tenant}`;
    tokens.set(t, tenant);
    return t;
  };
  const f: FakeBao = {
    url: "",
    mount,
    token: tokenFor("owner"),
    tokenFor,
    intakeToken: "fake-token-intake",
    store,
    requests: [],
    mode: { sealed: false, down: false, delayMs: 0, garbage: false, policies: ["default", "ted-owner"], ttl: 30 * 86_400 },
    bao: (o = {}) => new OpenBao({ addr: f.url, mount, token: async () => o.token ?? f.token, cacheMs: o.cacheMs ?? 0, timeoutMs: o.timeoutMs ?? 2000 }),
    secrets: (tenant = "owner", o = {}) => new TenantSecrets(f.bao({ token: tokenFor(tenant), ...o }), tenant),
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
  const allowed = (tenant: string | undefined, rest: string): boolean => tenant !== undefined && (rest === `tenants/${tenant}` || rest.startsWith(`tenants/${tenant}/`));
  const server: Server = createServer(async (req, res) => {
    const raw = await body(req);
    const url = new URL(req.url ?? "/", f.url);
    const token = req.headers["x-vault-token"] as string | undefined;
    f.requests.push({ method: req.method ?? "", path: url.pathname + url.search, body: raw, token });
    const send = (status: number, json?: unknown) => {
      if (f.mode.garbage) return void res.writeHead(200).end("<html>not json</html>");
      res.writeHead(status, { "content-type": "application/json" }).end(json === undefined ? "" : JSON.stringify(json));
    };
    if (f.mode.delayMs) await new Promise((r) => setTimeout(r, f.mode.delayMs));
    if (f.mode.down) return void req.socket.destroy();
    const p = url.pathname.replace(/^\/v1\//, "");
    if (p === "sys/health") return send(200, { initialized: true, sealed: f.mode.sealed, version: "2.7.1-fake" });
    if (f.mode.sealed) return send(503, { errors: ["Vault is sealed"] });
    if (token === f.intakeToken) {
      const writable = (full: string) => new RegExp(`^${mount}/data/tenants/[^/]+/(profile|card|google|notion)/[^/]+$`).test(full);
      if (p === "auth/token/lookup-self") return send(200, { data: { policies: ["default", "ted-intake"], ttl: f.mode.ttl, renewable: true } });
      if (p === "sys/capabilities-self") {
        const out: Record<string, string[]> = {};
        for (const full of JSON.parse(raw).paths as string[]) out[full] = writable(full) ? ["create", "update"] : ["deny"];
        return send(200, { ...out, data: out });
      }
      const w = new RegExp(`^${mount}/(data|metadata)/(.+)$`).exec(p);
      const ok = w?.[1] === "data" && (req.method === "POST" || req.method === "PUT") && /^tenants\/[^/]+\/(profile|card|google|notion)\/[^/]+$/.test(w[2]!);
      if (!ok) return send(403, { errors: ["permission denied"] });
      store.set(w![2]!, JSON.parse(raw).data);
      return send(200, { data: { version: 1 } });
    }
    const tenant = token ? tokens.get(token) : undefined;
    if (!tenant) return send(403, { errors: ["permission denied"] });
    if (p === "auth/token/lookup-self") return send(200, { data: { policies: f.mode.policies, ttl: f.mode.ttl, renewable: true } });
    if (p === "auth/token/renew-self") return send(200, { auth: {} });
    if (p === "sys/capabilities-self") {
      const paths: string[] = JSON.parse(raw).paths;
      const out: Record<string, string[]> = {};
      for (const full of paths) {
        const m = new RegExp(`^${mount}/(data|metadata)/(.*)$`).exec(full);
        out[full] = m && allowed(tenant, m[2]!) ? (m[1] === "data" ? ["create", "read", "update", "delete"] : ["list", "read", "delete"]) : ["deny"];
      }
      return send(200, { ...out, data: out });
    }
    const m = new RegExp(`^${mount}/(data|metadata)/(.+)$`).exec(p);
    if (!m) return send(404, { errors: [] });
    const [, kind, rest] = m as unknown as [string, "data" | "metadata", string];
    // (the app's policy also reads any friend's Google grant, openbaoadmin.ts policyHcl, and nothing else of hers)
    // (and a friend's Notion grant is read and written back, because its refresh tokens rotate: no delete, no list)
    const readsGoogle = tenant === "owner" && kind === "data" && req.method === "GET" && /^tenants\/[^/]+\/google\/[^/]+$/.test(rest);
    const usesNotion = tenant === "owner" && kind === "data" && ["GET", "POST", "PUT"].includes(req.method ?? "") && /^tenants\/[^/]+\/notion\/[^/]+$/.test(rest);
    if (!allowed(tenant, rest.replace(/\/$/, "")) && !readsGoogle && !usesNotion) return send(403, { errors: ["permission denied"] });
    if (kind === "data" && req.method === "GET") {
      const d = store.get(rest);
      return d ? send(200, { data: { data: d, metadata: { version: 1 } } }) : send(404, { errors: [] });
    }
    if (kind === "data" && (req.method === "POST" || req.method === "PUT")) {
      store.set(rest, JSON.parse(raw).data);
      return send(200, { data: { version: 1 } });
    }
    if (kind === "metadata" && req.method === "GET" && url.searchParams.get("list") === "true") {
      const pre = rest.replace(/\/$/, "") + "/";
      const keys = new Set<string>();
      for (const k of store.keys()) if (k.startsWith(pre)) keys.add(k.slice(pre.length).includes("/") ? k.slice(pre.length).split("/")[0] + "/" : k.slice(pre.length));
      return keys.size ? send(200, { data: { keys: [...keys].sort() } }) : send(404, { errors: [] });
    }
    if (kind === "metadata" && req.method === "GET") return store.has(rest) ? send(200, { data: { versions: {} } }) : send(404, { errors: [] });
    if (kind === "metadata" && req.method === "DELETE") {
      store.delete(rest);
      return send(204);
    }
    send(405, { errors: [] });
  });
  server.unref(); // a test that forgets to close it does not keep the test process alive
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return f;
}

// A card store over its own fake OpenBao (tests that only need "a store with this card in it").
export async function fakeCardStore(card?: CardRecord): Promise<CardStore & { fake: FakeBao }> {
  const fake = await startFakeBao();
  const store = Object.assign(new CardStore(fake.secrets()), { fake });
  if (card) await store.save(card);
  return store;
}
