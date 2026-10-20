import { Agent, fetch as undiciFetch } from "undici";

// A small client for OpenBao's HTTP API (KV version 2), over fetch: no SDK. The secrets of the app live in OpenBao, not on disk.
// - Fails closed: any error (not reachable, sealed, refused, a timeout, an answer we do not understand) is a BaoError with a plain
//   message, never a guess and never a fall back to something else. The message never holds a value, a token or the server's text.
// - Talks to a loopback address only (OpenBao listens on 127.0.0.1), over TLS that trusts exactly the pinned certificate it was given.
// - Caches in memory only, briefly, and only when asked; never on disk. Any write or delete empties the cache.

export class BaoError extends Error {
  readonly status?: number;
  readonly detail?: string; // the server's own words for a refusal, for the setup tool's terminal only; never in `message`, never logged by the app
  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; text: () => Promise<string> }>;

export interface BaoOptions {
  addr: string; // https://127.0.0.1:8200 (http only for a throwaway test server on loopback)
  mount: string; // the KV v2 mount, like "ted"
  token: () => Promise<string>; // the tenant token; asked for at each call, the caller may memoize
  caPem?: string; // the pinned certificate (PEM). With it, the connection trusts this certificate and nothing else
  timeoutMs?: number;
  cacheMs?: number; // how long a read may be served from memory (0: never). Per call, `cache: false` always bypasses
  fetcher?: Fetcher; // for tests
}

export type Data = Record<string, unknown>;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const checkPath = (path: string): string[] => {
  const parts = path.split("/").filter((p) => p !== "");
  if (!parts.length || parts.length > 6 || !parts.every((p) => SEGMENT.test(p))) throw new BaoError("not a valid secret path");
  return parts;
};

const serverWords = (text: string): string | undefined => {
  try {
    const e = (JSON.parse(text) as { errors?: unknown }).errors;
    return Array.isArray(e) ? e.filter((x) => typeof x === "string").join("; ").slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
};

export class OpenBao {
  private readonly o: Required<Pick<BaoOptions, "addr" | "mount" | "timeoutMs" | "cacheMs">> & BaoOptions;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly fetcher: Fetcher;

  constructor(o: BaoOptions) {
    let u: URL;
    try {
      u = new URL(o.addr);
    } catch {
      throw new BaoError("OPENBAO_ADDR is not an address");
    }
    if (!LOOPBACK.has(u.hostname)) throw new BaoError("OPENBAO_ADDR must be a loopback address (127.0.0.1): the store never leaves this machine");
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new BaoError("OPENBAO_ADDR must be an https:// address");
    if (!SEGMENT.test(o.mount)) throw new BaoError("OPENBAO_MOUNT is not a mount name");
    this.o = { ...o, addr: u.origin, timeoutMs: o.timeoutMs ?? 5000, cacheMs: o.cacheMs ?? 0 };
    if (o.fetcher) this.fetcher = o.fetcher;
    else {
      const dispatcher = new Agent({ connect: o.caPem ? { ca: o.caPem } : {} });
      this.fetcher = (url, init) => undiciFetch(url, { ...init, dispatcher }) as unknown as ReturnType<Fetcher>;
    }
  }

  // One call. `auth: false` for the few calls that need no token (health). Returns the parsed JSON, or undefined for an empty answer.
  private async call(method: string, path: string, body?: unknown, o: { auth?: boolean; notFound?: boolean } = {}): Promise<{ json: any } | undefined> {
    const headers: Record<string, string> = { Accept: "application/json", "X-Vault-Request": "true" };
    if (o.auth !== false) {
      let token: string;
      try {
        token = await this.o.token();
      } catch {
        throw new BaoError("there is no OpenBao token for the app (run npm run openbao -- setup)");
      }
      headers["X-Vault-Token"] = token;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Awaited<ReturnType<Fetcher>>;
    let text: string;
    try {
      res = await this.fetcher(`${this.o.addr}/v1/${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.o.timeoutMs) });
      text = await res.text();
    } catch {
      throw new BaoError("OpenBao is not reachable (is the service running? npm run openbao -- status)");
    }
    if (res.status === 404 && o.notFound) return undefined;
    if (res.status === 503) throw new BaoError("OpenBao is sealed or not ready (npm run openbao -- unseal)", 503);
    if (res.status === 403) throw new BaoError("OpenBao refused the request (the token is wrong, expired, or its policy does not allow this)", 403);
    if (res.status < 200 || res.status >= 300) throw new BaoError(`OpenBao answered with an error (status ${res.status})`, res.status, serverWords(text));
    if (!text) return { json: undefined };
    try {
      return { json: JSON.parse(text) };
    } catch {
      throw new BaoError("OpenBao gave an answer that is not JSON");
    }
  }

  private cached<T>(key: string, fresh: boolean): T | undefined {
    if (!fresh || this.o.cacheMs <= 0) return undefined;
    const hit = this.cache.get(key);
    if (!hit || Date.now() - hit.at > this.o.cacheMs) return void this.cache.delete(key);
    return structuredClone(hit.value) as T;
  }
  private remember(key: string, value: unknown, fresh: boolean): void {
    if (fresh && this.o.cacheMs > 0) this.cache.set(key, { at: Date.now(), value: structuredClone(value) });
  }
  forget(): void {
    this.cache.clear();
  }

  // ---- KV v2 ----

  // The data of the latest version, or undefined when there is none (never written, or deleted).
  async read(path: string, o: { cache?: boolean } = {}): Promise<Data | undefined> {
    const p = checkPath(path).join("/");
    const key = `r:${p}`;
    const hit = this.cached<Data>(key, o.cache !== false);
    if (hit) return hit;
    const r = await this.call("GET", `${this.o.mount}/data/${p}`, undefined, { notFound: true });
    if (!r) return undefined;
    const data = r.json?.data?.data;
    if (data === null || data === undefined) return undefined; // a deleted version answers with metadata only
    if (typeof data !== "object" || Array.isArray(data)) throw new BaoError("OpenBao gave an item that is not a record");
    this.remember(key, data, o.cache !== false);
    return data as Data;
  }

  async write(path: string, data: Data): Promise<void> {
    const p = checkPath(path).join("/");
    this.forget();
    await this.call("POST", `${this.o.mount}/data/${p}`, { data });
  }

  // Removes the item with all its versions (the metadata delete), not just the latest version. True when there was one.
  async delete(path: string): Promise<boolean> {
    const p = checkPath(path).join("/");
    this.forget();
    if (!(await this.call("GET", `${this.o.mount}/metadata/${p}`, undefined, { notFound: true }))) return false; // (a delete of nothing answers 204 too)
    await this.call("DELETE", `${this.o.mount}/metadata/${p}`);
    return true;
  }

  // The names directly under a folder; a name ending in "/" is a folder of its own.
  async list(path: string, o: { cache?: boolean } = {}): Promise<string[]> {
    const p = checkPath(path).join("/");
    const key = `l:${p}`;
    const hit = this.cached<string[]>(key, o.cache !== false);
    if (hit) return hit;
    const r = await this.call("GET", `${this.o.mount}/metadata/${p}?list=true`, undefined, { notFound: true });
    const keys = r?.json?.data?.keys;
    if (r && !Array.isArray(keys)) throw new BaoError("OpenBao gave a list we do not understand");
    const out = ((keys as unknown[] | undefined) ?? []).filter((k): k is string => typeof k === "string");
    this.remember(key, out, o.cache !== false);
    return out;
  }

  // ---- the setup tool's calls (any API path under /v1/; `auth: false` for the few that need no token, like sys/init) ----

  async raw(method: string, path: string, body?: unknown, o: { auth?: boolean; notFound?: boolean } = {}): Promise<any> {
    return (await this.call(method, path, body, o))?.json;
  }

  // ---- state, for the doctor and the setup ----

  // No token needed. Never throws on a sealed or uninitialised server: it says so.
  async health(): Promise<{ initialized: boolean; sealed: boolean; version?: string }> {
    const r = await this.call("GET", "sys/health?sealedcode=200&uninitcode=200&standbyok=true", undefined, { auth: false });
    const j = r?.json;
    if (typeof j?.initialized !== "boolean" || typeof j?.sealed !== "boolean") throw new BaoError("OpenBao gave a health answer we do not understand");
    return { initialized: j.initialized, sealed: j.sealed, ...(typeof j.version === "string" ? { version: j.version } : {}) };
  }

  // What this token may do on each KV path (full API path under the mount, like "data/tenants/owner/x").
  async capabilities(paths: string[]): Promise<Record<string, string[]>> {
    const full = paths.map((p) => `${this.o.mount}/${p}`);
    const r = await this.call("POST", "sys/capabilities-self", { paths: full });
    const out: Record<string, string[]> = {};
    for (const [i, p] of paths.entries()) {
      const caps = r?.json?.[full[i]!] ?? r?.json?.data?.[full[i]!];
      out[p] = Array.isArray(caps) ? caps.filter((c: unknown): c is string => typeof c === "string") : [];
    }
    return out;
  }

  async lookupSelf(): Promise<{ policies: string[]; ttlSeconds: number; renewable: boolean }> {
    const d = (await this.call("GET", "auth/token/lookup-self"))?.json?.data;
    if (!d || !Array.isArray(d.policies)) throw new BaoError("OpenBao gave a token answer we do not understand");
    return { policies: d.policies.filter((p: unknown): p is string => typeof p === "string"), ttlSeconds: Number(d.ttl) || 0, renewable: d.renewable === true };
  }

  async renewSelf(): Promise<void> {
    await this.call("POST", "auth/token/renew-self", {});
  }
}
