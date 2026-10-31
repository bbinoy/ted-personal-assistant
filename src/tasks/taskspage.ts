import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { OWNER_KEY } from "../core/ownerkey.ts";
import { systemZone } from "../core/timezone.ts";
import { completeItem, counts, dueClass, effectiveStatus, getItem, listItems, type Item } from "./store.ts";
import { localOf, showLocal, todayIn } from "./when.ts";
import { BUCKETS, groupOpen } from "./render.ts";

// The owner's open tasks as one web page, rendered by code straight from the store (no model). It is read-only except one action: a tick-off button per open row. It is served on 127.0.0.1 only; `tailscale serve` (never funnel) puts it on the owner's phone.
// ONLY the owner's conversation is read or changed, never a friend's or a group's list: the admin cannot read friends' data and this page is on the admin's devices (CLAUDE.md §5).

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KIND = { task: "task", i_owe: "I owe", owed_to_me: "waiting on" } as const;
const WEEK = 7; // the "done" window, in days
const DAY = 86_400_000;

function row(it: Item, now: number, zone: string, token?: string): string {
  const due = it.due ? showLocal(it.due, todayIn(now, zone)) : "";
  const late = dueClass(it, now, zone) === "overdue";
  const bits = [KIND[it.kind], it.person, it.urgent ? "urgent" : "", it.sourceKind].filter(Boolean).map((b) => esc(b!));
  const tick = token === undefined ? "" : `<form method="post" action="/tasks/${it.id}/done"><input type="hidden" name="token" value="${esc(token)}"><button title="Mark done" aria-label="Mark done: ${esc(it.title)}">&#10003;</button></form>`;
  return `<li class="${[late ? "late" : "", it.urgent ? "urgent" : ""].filter(Boolean).join(" ")}">${tick}<div class="b"><span class="t">${esc(it.title)}</span>${due ? ` <span class="d">${esc(due)}</span>` : ""}<br><span class="m">${bits.join(" · ")}</span></div></li>`;
}

const block = (title: string, items: readonly Item[], now: number, zone: string, open: boolean, token?: string): string =>
  items.length ? `<details${open ? " open" : ""}><summary>${esc(title)} (${items.length})</summary><ul>${items.map((i) => row(i, now, zone, token)).join("")}</ul></details>` : "";

/** The whole page for one conversation's list at `now` in `zone`. `token` is the tick-off forms' CSRF token; without it a row has no button. */
export function tasksPage(key: string, now: number, zone: string, token?: string): string {
  const open = listItems(key, { limit: 200 }, now, zone);
  const done = listItems(key, { status: "done", limit: 200 }, now, zone).filter((i) => (i.doneAt ?? 0) >= now - WEEK * DAY);
  const c = counts(key, now, zone);
  const g = groupOpen(open, now, zone);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60"><title>Tasks</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
:root{color-scheme:light dark;--red:#c62828;--amber:#b26a00}@media(prefers-color-scheme:dark){:root{--red:#ff6b6b;--amber:#ffb74d}}
body{font:16px/1.4 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:1rem}h1{font-size:1.2rem;margin:.2rem 0}
.h{color:#777;margin-bottom:1rem}summary{font-weight:600;margin:.8rem 0 .3rem}ul{list-style:none;padding:0;margin:0}
li{display:flex;gap:.6rem;align-items:center;padding:.45rem 0 .45rem .5rem;border-top:1px solid #8884;border-left:4px solid transparent}
li.urgent{border-left-color:var(--amber)}li.late{border-left-color:var(--red)}li.late .d{color:var(--red);font-weight:600}li.urgent .m{color:var(--amber);font-weight:600}
.b{flex:1;min-width:0}form{margin:0}button{font:inherit;min-width:2.6rem;min-height:2.6rem;border:1px solid #8886;border-radius:50%;background:transparent;color:inherit}
.d{float:right;margin-left:.5rem;white-space:nowrap}.m{color:#777;font-size:.85rem}
</style></head><body><h1>Tasks</h1><div class="h">${open.length} open${c.overdue ? `, ${c.overdue} overdue` : ""} · updated ${esc(localOf(now, zone).time)}</div>
${BUCKETS.map((b) => block(b, g[b], now, zone, b === "Today", token)).join("")}${open.length ? "" : "<p>Nothing open.</p>"}
${block("Done in the last 7 days", done, now, zone, false)}</body></html>`;
}

/** The tab icon: a tick in a rounded square, mid-tone colours that read on light and dark tabs. Served by the page itself; nothing is loaded from outside. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2e7d6b"/><path d="M8 17l5.5 5.5L24 10.5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const HEADERS = {
  "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** Host: 127.0.0.1 or localhost (bare or on the page's own port), or a tailnet name (what `tailscale serve` forwards, any port). */
function hostAllowed(host: string | undefined, port: number | undefined): boolean {
  const m = /^([a-z0-9.-]+)(?::(\d+))?$/i.exec(host ?? "");
  if (!m) return false;
  const name = m[1]!.toLowerCase();
  if (name === "127.0.0.1" || name === "localhost") return m[2] === undefined || Number(m[2]) === port;
  return name.endsWith(".ts.net");
}

/** The Origin a browser sends from this page: http on the loopback names, https on a tailnet name, always the Host the request came to. */
const ownOrigin = (host: string): string => `${/^(127\.0\.0\.1|localhost)(:|$)/i.test(host) ? "http" : "https"}://${host.toLowerCase()}`;

const BODY_MAX = 1024;
const sameToken = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** The tick-off: completed by the store function the complete_task tool uses (repeats, events, the journal line), in the owner's conversation only. False when the id is not one of the owner's open tasks. */
function tickOff(id: number): boolean {
  const now = Date.now();
  const it = getItem(OWNER_KEY, id);
  if (!it || effectiveStatus(it, now) !== "open") return false;
  completeItem({ key: OWNER_KEY, zone: systemZone(), by: "owner", origin: "owner", source: "chat", now, why: { text: "ticked off on the task page" } }, id);
  return true;
}

/**
 * GET /tasks (the page), GET /healthz, HEAD likewise, and POST /tasks/<id>/done (the one action); any other path is 404, any other method 405.
 * `read` renders the page for this process's CSRF token; `tick` completes one of the owner's open tasks and says whether it did.
 * A POST needs the right Host, an Origin equal to the page's own, a form content type, a tiny body and the token; every CSRF failure gets the same 403.
 */
export function tasksPageServer(read: (token: string) => string = (t) => tasksPage(OWNER_KEY, Date.now(), systemZone(), t), tick: (id: number) => boolean = tickOff): Server {
  const token = randomBytes(32).toString("hex"); // per process: a page from before a restart posts nothing
  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { ...HEADERS, "content-type": `${type}; charset=utf-8`, ...extra });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const host = req.headers.host;
    if (!hostAllowed(host, req.socket.localPort)) return send(421, "text/plain", "misdirected request"); // (DNS rebinding: a web page may point its own name at 127.0.0.1)
    if (req.method === "POST") {
      const m = /^\/tasks\/(\d{1,9})\/done$/.exec(path);
      if (!m) return send(405, "text/plain", "method not allowed", { allow: "GET, HEAD" });
      const forbidden = (): void => send(403, "text/plain", "forbidden");
      if (req.headers.origin?.toLowerCase() !== ownOrigin(host!)) return forbidden(); // (another website's POST carries its own Origin; none at all is refused too)
      if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers["content-type"] ?? "")) return send(415, "text/plain", "unsupported media type");
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > BODY_MAX) over = true;
        else chunks.push(c);
      });
      req.on("end", () => {
        if (over) return send(413, "text/plain", "too large", { connection: "close" });
        if (!sameToken(new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("token") ?? "", token)) return forbidden();
        try {
          if (!tick(Number(m[1]))) return send(404, "text/plain", "not found");
        } catch (e) {
          console.error(`tasks page: ${(e as Error).message}`);
          return send(500, "text/plain", "that cannot be done right now");
        }
        send(303, "text/plain", "done", { location: "/tasks" });
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "method not allowed", { allow: "GET, HEAD, POST" });
    if (path === "/favicon.svg" || path === "/favicon.ico") return send(200, "image/svg+xml", FAVICON, { "cache-control": "public, max-age=86400" }); // (browsers ask for the .ico unasked)
    if (path === "/healthz") return send(200, "text/plain", "ok");
    if (path !== "/tasks") return send(404, "text/plain", "not found");
    try {
      send(200, "text/html", read(token));
    } catch (e) {
      console.error(`tasks page: ${(e as Error).message}`);
      send(500, "text/plain", "the list cannot be read right now");
    }
  });
}

/** Start it on 127.0.0.1 and nowhere else; a port in use is logged and the agent carries on. */
export function startTasksPage(port: number): Server {
  const s = tasksPageServer();
  s.on("error", (e) => console.error(`tasks page: ${e.message}`));
  s.listen(port, "127.0.0.1");
  return s;
}
