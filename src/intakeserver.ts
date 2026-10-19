import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { audit } from "./audit.ts";
import { LINK_CODE, LinkStore, PURPOSE_CAPABILITY, recordDone } from "./intakelinks.ts";
import { Invalid, purposeOf, type Field, type Purpose } from "./intakepurposes.ts";
import type { Put } from "./intakepurposes.ts";
import { people } from "./tenants.ts";

// The intake page: a separate process (scripts/intake.ts), on 127.0.0.1 only, that is the one place a tenant types a secret. A tunnel the owner sets up
// (docs/SETUP.md) puts it on the internet over https; this file knows nothing of that. Nothing secret goes through Signal, and the model never sees a
// value: it asked for a single-use link (intaketools.ts), the page stored what was typed, and the model hears "stored (N characters)".
//
//   GET  /i/<code>   the form of the link's purpose
//   POST /i/<code>   store what was typed, then burn the link
//   GET  /healthz    "ok", no data
//   anything else    404, the same answer every time; no directory, no listing
//
// Hardening: the code is 128 random bits, compared in constant time and only by its hash; a link works once (a second submit at the same moment loses
// the race); per-address and global rate limits, and a stricter one for wrong codes; a method allow-list; headers, body, content type and time are
// bounded; a per-form CSRF token; no cookies; a strict CSP, no caching, no referrer. A submitted value is never echoed, logged or audited: only names
// and lengths are.

const MAX_BODY = 16 * 1024;
const FORM_TYPE = /^application\/x-www-form-urlencoded\s*(?:;\s*charset=utf-8\s*)?$/i;
const CONTROL = /[\u0000-\u001F\u007F]/;

export interface Limits {
  perIpPerMinute: number;
  globalPerMinute: number;
  badCodesPerIp: number; // unknown or used codes from one address, per BAD_WINDOW
}
const DEFAULT_LIMITS: Limits = { perIpPerMinute: 60, globalPerMinute: 300, badCodesPerIp: 10 };
const BAD_WINDOW = 15 * 60_000;

// Hits per key in a sliding window, in memory.
class Window {
  private readonly hits = new Map<string, number[]>();
  private readonly ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
  count(key: string, now: number): number {
    const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < this.ms);
    if (fresh.length) this.hits.set(key, fresh);
    else this.hits.delete(key);
    return fresh.length;
  }
  add(key: string, now: number): void {
    if (this.hits.size > 10_000) this.hits.clear(); // a flood of addresses cannot grow it without bound (the global limit still holds)
    this.hits.set(key, [...(this.hits.get(key) ?? []), now]);
  }
}

export interface IntakeDeps {
  links: LinkStore;
  writer: { for(tenant: string): Put };
  now?: () => number;
  limits?: Partial<Limits>;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1c1c1c}main{max-width:30rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.35rem;margin:0 0 .5rem}p{margin:.5rem 0}label{display:block;font-weight:600;margin-top:1rem}.help{font-weight:400;color:#555;font-size:.9rem;margin:.1rem 0 .3rem}
input,select{box-sizing:border-box;width:100%;font:inherit;padding:.55rem;border:1px solid #888;border-radius:6px;background:#fff;color:inherit}
button{margin-top:1.5rem;font:inherit;font-weight:600;padding:.65rem 1.2rem;border:0;border-radius:6px;background:#1c4fd8;color:#fff}.error{background:#fde8e8;border:1px solid #c33;border-radius:6px;padding:.6rem}.note{color:#555;font-size:.85rem;margin-top:2rem}
@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}input,select{background:#222;border-color:#777}.help,.note{color:#aaa}.error{background:#3a1c1c}}`;

const cspFor = (nonce: string): string => `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
const BASE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin" };

function sendText(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Content-Type": "text/plain; charset=utf-8", ...extra }).end(body);
}
const NOT_FOUND = "Not found\n"; // the one answer for every path, code and method that is not a thing here

function sendPage(res: ServerResponse, status: number, title: string, body: string): void {
  const nonce = randomBytes(16).toString("base64");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>${body}</main></body></html>`;
  res.writeHead(status, { ...BASE_HEADERS, "Content-Security-Policy": cspFor(nonce), "Content-Type": "text/html; charset=utf-8" }).end(html);
}

const input = (f: Field): string => {
  const common = `name="${esc(f.name)}" id="f-${esc(f.name)}" maxlength="${f.max}" ${f.required ? "required" : ""}`;
  const help = f.help ? `<p class="help">${esc(f.help)}</p>` : "";
  const control = f.type === "select" ? `<select ${common}>${(f.options ?? []).map((o) => `<option value="${esc(o)}">${esc(o === "auto" ? "Detail" : o)}</option>`).join("")}</select>` : `<input type="${f.type}" ${common} autocomplete="off" autocapitalize="off" spellcheck="false">`;
  return `<label for="f-${esc(f.name)}">${esc(f.label)}</label>${help}${control}`;
};

export class IntakeServer {
  private readonly deps: IntakeDeps;
  private readonly secret = randomBytes(32); // CSRF tokens are only good for this process
  private readonly limits: Limits;
  private readonly perIp = new Window(60_000);
  private readonly all = new Window(60_000);
  private readonly bad = new Window(BAD_WINDOW);
  readonly server: Server;

  constructor(deps: IntakeDeps) {
    this.deps = deps;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.server = createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, (req, res) => {
      this.handle(req, res).catch((e) => {
        console.error(`intake: a request failed (${(e as Error).name})`); // the name only: never a message, which could quote a value
        if (!res.headersSent) sendText(res, 500, "Something went wrong\n");
        else res.destroy();
      });
    });
    this.server.maxConnections = 64;
    this.server.maxRequestsPerSocket = 20;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private csrf(code: string): string {
    return createHmac("sha256", this.secret).update(`csrf\0${code}`).digest("base64url");
  }
  private csrfOk(code: string, given: string): boolean {
    const want = Buffer.from(this.csrf(code));
    const got = Buffer.from(given);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  // Behind a tunnel every request comes from the loopback address; the last X-Forwarded-For entry is the one the tunnel itself added.
  private clientIp(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? "?";
    if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return peer;
    const xff = req.headers["x-forwarded-for"];
    return (typeof xff === "string" ? xff.split(",").pop()?.trim() : "") || peer;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = this.now();
    const ip = this.clientIp(req);
    const path = (req.url ?? "").split("?")[0]!;
    const route = path === "/healthz" ? "healthz" : /^\/i\/[^/]+$/.test(path) ? "form" : "other";
    res.on("finish", () => console.log(`intake: ${req.method} ${route} ${res.statusCode}`)); // never the path: it holds the code

    if (this.all.count("*", now) >= this.limits.globalPerMinute || this.perIp.count(ip, now) >= this.limits.perIpPerMinute || this.bad.count(ip, now) >= this.limits.badCodesPerIp) {
      return sendText(res, 429, "Too many requests\n", { "Retry-After": "60" });
    }
    this.all.add("*", now);
    this.perIp.add(ip, now);

    if (route === "other") return sendText(res, 404, NOT_FOUND);
    if (route === "healthz") return req.method === "GET" ? sendText(res, 200, "ok\n") : sendText(res, 405, "Method not allowed\n", { Allow: "GET" });
    if (req.method !== "GET" && req.method !== "POST") return sendText(res, 405, "Method not allowed\n", { Allow: "GET, POST" });

    const code = path.slice(3);
    const payload = LINK_CODE.test(code) ? this.deps.links.peek(code, now) : undefined;
    const purpose = payload && this.allowed(payload.tenant, payload.purpose);
    if (!payload || !purpose) {
      this.bad.add(ip, now);
      return sendText(res, 404, NOT_FOUND);
    }
    if (req.method === "GET") return this.form(res, code, purpose, payload.tenant);
    return this.submit(req, res, code, ip, purpose, payload);
  }

  // The purpose, when this person may still use it: she exists, is active, and holds the capability (a suspended or revoked person's open link is dead).
  private allowed(tenant: string, purposeId: string): Purpose | undefined {
    const rec = people().find((r) => r.id === tenant);
    const cap = Object.hasOwn(PURPOSE_CAPABILITY, purposeId) ? PURPOSE_CAPABILITY[purposeId] : undefined;
    return rec && rec.status === "active" && cap && rec.capabilities.includes(cap) ? purposeOf(purposeId) : undefined;
  }

  private form(res: ServerResponse, code: string, purpose: Purpose, tenant: string, problem?: string, status = 200): void {
    const fields = purpose.fields(tenant).map(input).join("");
    sendPage(res, status, purpose.title, `<h1>${esc(purpose.title)}</h1><p>${esc(purpose.intro)}</p>${problem ? `<p class="error" role="alert">${esc(problem)}</p>` : ""}<form method="post" action="/i/${code}" autocomplete="off"><input type="hidden" name="csrf" value="${this.csrf(code)}">${fields}<button type="submit">Save</button></form><p class="note">This page is private to you and the link works once. Nothing you type here goes through the chat.</p>`);
  }

  private async submit(req: IncomingMessage, res: ServerResponse, code: string, ip: string, purpose: Purpose, who: { tenant: string; purpose: string }): Promise<void> {
    if (!FORM_TYPE.test(req.headers["content-type"] ?? "")) return sendText(res, 415, "Unsupported media type\n");
    const body = await readBody(req, res);
    if (body === undefined) return;
    const params = new URLSearchParams(body);
    const names = [...params.keys()];
    const fields = purpose.fields(who.tenant);
    const known = new Set(["csrf", ...fields.map((f) => f.name)]);
    // An unknown field is refused whole, whatever it is (a friend's form has no security code, so one that arrives anyway never reaches a store).
    if (names.some((n) => !known.has(n)) || new Set(names).size !== names.length) return sendText(res, 400, "Bad request\n");
    if (!this.csrfOk(code, params.get("csrf") ?? "")) return this.form(res, code, purpose, who.tenant, "This form has expired. Please try again.", 403);
    const values: Record<string, string> = {};
    for (const f of fields) {
      const v = (params.get(f.name) ?? "").normalize("NFC");
      const problem = CONTROL.test(v) ? "contains characters that are not allowed" : [...v].length > f.max ? `is longer than ${f.max} characters` : f.required && !v.trim() ? "is missing" : f.type === "select" && v && !f.options?.includes(v) ? "is not one of the choices" : undefined;
      if (problem) return this.form(res, code, purpose, who.tenant, `"${f.label}" ${problem}.`, 400); // the label, never the value
      values[f.name] = v;
    }

    const claim = this.deps.links.claim(code, this.now());
    if (!claim) {
      this.bad.add(ip, this.now());
      return sendText(res, 404, NOT_FOUND); // used a moment ago by another request
    }
    try {
      const stored = await purpose.store(who.tenant, values, this.deps.writer.for(who.tenant));
      claim.burn();
      recordDone(who.tenant, who.purpose, stored);
      audit("intake_store", "stored", "background", { tenant: who.tenant, purpose: who.purpose, items: stored });
      sendPage(res, 200, "Saved", `<h1>Saved</h1><ul>${stored.map((s) => `<li>${esc(s.name)} (${s.chars} characters)</li>`).join("")}</ul><p>You can close this page and go back to the chat.</p>`);
    } catch (e) {
      claim.release(); // the same link works again until it expires
      if (e instanceof Invalid) return this.form(res, code, purpose, who.tenant, e.message, 400);
      console.error(`intake: storing failed (${(e as Error).name})`);
      audit("intake_store", "failed", "background", { tenant: who.tenant, purpose: who.purpose });
      sendPage(res, 503, "Not saved", `<h1>Not saved</h1><p>The secret store could not be reached. Nothing was saved. Try the same link again in a moment.</p>`);
    }
  }
}

// The body, at most MAX_BODY bytes; undefined (already answered 413) when it is bigger.
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  return new Promise((resolve) => {
    let refused = false;
    const tooBig = () => {
      if (refused) return;
      refused = true;
      chunks.length = 0;
      sendText(res, 413, "Payload too large\n", { Connection: "close" });
      res.once("finish", () => req.socket.destroy()); // the rest of the upload is not read
      resolve(undefined);
    };
    const chunks: Buffer[] = [];
    let size = 0;
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return tooBig();
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) return tooBig();
      if (!refused) chunks.push(c);
    });
    req.on("end", () => !refused && resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}
