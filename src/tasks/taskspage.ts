import { createServer, type Server } from "node:http";
import { OWNER_KEY } from "../core/ownerkey.ts";
import { systemZone } from "../core/timezone.ts";
import { counts, dueClass, listItems, type Item } from "./store.ts";
import { addDays, localOf, parseLocal, showLocal, todayIn } from "./when.ts";

// The owner's open tasks as one read-only web page, rendered by code straight from the store (no model). It is served on 127.0.0.1 only; `tailscale serve` (never funnel) puts it on the owner's phone.
// ONLY the owner's conversation is read, never a friend's or a group's list: the admin cannot read friends' data and this page is on the admin's devices (CLAUDE.md §5).

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KIND = { task: "task", i_owe: "I owe", owed_to_me: "waiting on" } as const;
const WEEK = 7; // "this week" = up to 7 days after today
const DAY = 86_400_000;

type Bucket = "Overdue" | "Today" | "This week" | "Later" | "No date";
const BUCKETS: readonly Bucket[] = ["Overdue", "Today", "This week", "Later", "No date"];

function bucketOf(it: Item, now: number, zone: string): Bucket {
  const c = dueClass(it, now, zone);
  if (c === "overdue") return "Overdue";
  if (c === "today") return "Today";
  if (c === "none") return "No date";
  return parseLocal(it.due)!.date <= addDays(todayIn(now, zone), WEEK) ? "This week" : "Later";
}

function row(it: Item, now: number, zone: string): string {
  const due = it.due ? showLocal(it.due, todayIn(now, zone)) : "";
  const bits = [KIND[it.kind], it.person, it.urgent ? "urgent" : "", it.sourceKind].filter(Boolean).map((b) => esc(b!));
  return `<li><span class="t">${esc(it.title)}</span>${due ? ` <span class="d">${esc(due)}</span>` : ""}<br><span class="m">${bits.join(" · ")}</span></li>`;
}

const block = (title: string, items: readonly Item[], now: number, zone: string, open = true): string =>
  items.length ? `<details${open ? " open" : ""}><summary>${esc(title)} (${items.length})</summary><ul>${items.map((i) => row(i, now, zone)).join("")}</ul></details>` : "";

/** The whole page for one conversation's list at `now` in `zone`. */
export function tasksPage(key: string, now: number, zone: string): string {
  const open = listItems(key, { limit: 200 }, now, zone);
  const done = listItems(key, { status: "done", limit: 200 }, now, zone).filter((i) => (i.doneAt ?? 0) >= now - WEEK * DAY);
  const c = counts(key, now, zone);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60"><title>Tasks</title><style>
:root{color-scheme:light dark}body{font:16px/1.4 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:1rem}h1{font-size:1.2rem;margin:.2rem 0}
.h{color:#777;margin-bottom:1rem}summary{font-weight:600;margin:.8rem 0 .3rem}ul{list-style:none;padding:0;margin:0}li{padding:.45rem 0;border-top:1px solid #8884}
.d{float:right;margin-left:.5rem;white-space:nowrap}.m{color:#777;font-size:.85rem}
</style></head><body><h1>Tasks</h1><div class="h">${open.length} open${c.overdue ? `, ${c.overdue} overdue` : ""} · updated ${esc(localOf(now, zone).time)}</div>
${BUCKETS.map((b) => block(b, open.filter((i) => bucketOf(i, now, zone) === b), now, zone)).join("")}${open.length ? "" : "<p>Nothing open.</p>"}
${block("Done in the last 7 days", done, now, zone, false)}</body></html>`;
}

const HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** GET /tasks (the page) and GET /healthz, HEAD likewise; any other path is 404, any other method 405. `read` is the page's one data source (the owner's list). */
export function tasksPageServer(read: () => string = () => tasksPage(OWNER_KEY, Date.now(), systemZone())): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { ...HEADERS, "content-type": `${type}; charset=utf-8`, ...extra });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "method not allowed", { allow: "GET, HEAD" });
    if (path === "/healthz") return send(200, "text/plain", "ok");
    if (path !== "/tasks") return send(404, "text/plain", "not found");
    try {
      send(200, "text/html", read());
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
