import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { OWNER_KEY } from "../core/ownerkey.ts";
import { systemZone } from "../core/timezone.ts";
import { completeItem, counts, dueClass, editItem, effectiveStatus, getItem, listItems, type Item } from "./store.ts";
import { addDays, daysBetween, localOf, parseLocal, showLocal, todayIn, wallToUtc } from "./when.ts";
import { BUCKETS, FOCUS, groupOpen, subGroups, type Bucket } from "./render.ts";

// The owner's open tasks as one web page, rendered by code straight from the store (no model). It is read-only except two actions on each open row: a tick-off button and a pair of date buttons (earlier, later). It is served on 127.0.0.1 only; `tailscale serve` (never funnel) puts it on the owner's phone.
// ONLY the owner's conversation is read or changed, never a friend's or a group's list: the admin cannot read friends' data and this page is on the admin's devices (CLAUDE.md §5).

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KIND = { task: "task", i_owe: "I owe", owed_to_me: "waiting on" } as const;
const WEEK = 7; // the "done" window, in days
const DAY = 86_400_000;

export type Dir = "earlier" | "later";

/**
 * Where a date button takes a task due on `due` (a date, or a date with a time; undefined when none) when today is `today`, as a date; undefined when the button does nothing. Today is the minimum:
 * no date or a past date: today (either button); today: later is tomorrow, earlier does nothing; a future date: one day later or earlier.
 */
export function stepDate(due: string | undefined, dir: Dir, today: string): string | undefined {
  const date = due ? parseLocal(due)?.date : undefined;
  if (!date || date < today) return today;
  if (dir === "later") return addDays(date, 1);
  return date > today ? addDays(date, -1) : undefined;
}

/** What the page shows of a task's date and its date buttons: the words, whether it is late, and whether "earlier" does anything. The row is rendered from it, and the answer to a move carries it so the script holds no date logic. */
function dateView(it: Item, now: number, zone: string): { due: string; late: boolean; canEarlier: boolean } {
  const today = todayIn(now, zone);
  return { due: it.due ? showLocal(it.due, today) : "", late: dueClass(it, now, zone) === "overdue", canEarlier: stepDate(it.due, "earlier", today) !== undefined };
}

function row(it: Item, now: number, zone: string, token?: string): string {
  const { due, late, canEarlier } = dateView(it, now, zone);
  const bits = [KIND[it.kind], it.person, it.urgent ? "urgent" : "", it.sourceKind].filter(Boolean).map((b) => esc(b!));
  const tick = token === undefined ? "" : `<form class="tick" method="post" action="/tasks/${it.id}/done"><input type="hidden" name="token" value="${esc(token)}"><button title="Mark done" aria-label="Mark done: ${esc(it.title)}">&#10003;</button></form>`;
  const step = (dir: Dir, sign: string, off = false): string => `<button name="dir" value="${dir}" title="Move ${dir}" aria-label="Move ${dir}: ${esc(it.title)}"${off ? " disabled" : ""}>${sign}</button>`;
  const move = token === undefined ? "" : `<form class="step" method="post" action="/tasks/${it.id}/move"><input type="hidden" name="token" value="${esc(token)}">${step("earlier", "&#8249;", !canEarlier)}${step("later", "&#8250;")}</form>`;
  return `<li class="${[late ? "late" : "", it.urgent ? "urgent" : ""].filter(Boolean).join(" ")}">${tick}<div class="b"><span class="t">${esc(it.title)}</span>${due ? ` <span class="d">${esc(due)}</span>` : ""}<br>${move}<span class="m">${bits.join(" · ")}</span></div></li>`;
}

const block = (title: string, items: readonly Item[], now: number, zone: string, open: boolean, token?: string): string => {
  if (!items.length) return "";
  const rows = (xs: readonly Item[]): string => xs.map((i) => row(i, now, zone, token)).join("");
  const body = (BUCKETS as readonly string[]).includes(title) ? subGroups(title as Bucket, items, now, zone).map((g) => (g.label ? `<li class="sub">${esc(g.label)}</li>` : "") + rows(g.items)).join("") : rows(items);
  return `<details${open ? " open" : ""}${title === FOCUS ? ' class="focus"' : ""}><summary>${esc(title)} (${items.length})</summary><ul>${body}</ul></details>`;
};

/**
 * The one inline script (allowed by the response's CSP nonce, nothing else may run): a tick-off posts in the background and the row fades out; a date button posts in the background and the row's date text and buttons take the server's answer (without script the forms post and the server redirects back),
 * and the page reloads itself every minute (not while a post is in flight or just after a date button, so a reshuffle does not jump) keeping which sections are open and where it was scrolled (sessionStorage; if that is unavailable it simply reloads).
 */
const SCRIPT = String.raw`(()=>{
const S=sessionStorage,K="tasks-page",k=(d)=>d.querySelector("summary").textContent.replace(/ \(\d+\)$/,"");
try{const v=JSON.parse(S.getItem(K)||"null");S.removeItem(K);if(v){document.querySelectorAll("details").forEach((d)=>{if(k(d) in v.o)d.open=v.o[k(d)]});scrollTo(0,v.y)}}catch(e){}
let q=0;
setInterval(()=>{if(document.querySelector("form.busy")||Date.now()-q<20000)return;try{const o={};document.querySelectorAll("details").forEach((d)=>{o[k(d)]=d.open});S.setItem(K,JSON.stringify({o,y:scrollY}))}catch(e){}location.reload()},60000);
document.addEventListener("submit",async(e)=>{
const f=e.target;if(!f.classList||!(f.classList.contains("tick")||f.classList.contains("step")))return;
e.preventDefault();const li=f.closest("li"),bs=[...f.querySelectorAll("button")],was=bs.map((b)=>b.disabled),step=f.classList.contains("step"),p=new URLSearchParams(new FormData(f));
if(step){p.set("dir",e.submitter.value);q=Date.now()}
li.querySelectorAll(".err").forEach((x)=>x.remove());f.classList.add("busy");bs.forEach((b)=>b.disabled=true);
try{const r=await fetch(f.action,{method:"POST",headers:{accept:"application/json"},body:p,redirect:"manual"});
if(!r.ok&&r.type!=="opaqueredirect")throw 0;
if(step){const v=await r.json();let d=li.querySelector(".d");if(!d){d=document.createElement("span");d.className="d";li.querySelector(".t").after(" ",d)}
d.textContent=v.due;li.classList.toggle("late",v.late);bs[0].disabled=!v.canEarlier;bs[1].disabled=false;f.classList.remove("busy");q=Date.now();return}
const d=li.closest("details"),ul=li.parentNode;li.classList.add("gone");
setTimeout(()=>{li.remove();ul.querySelectorAll("li.sub").forEach((h)=>{const x=h.nextElementSibling;if(!x||x.classList.contains("sub"))h.remove()});const n=ul.querySelectorAll("li:not(.sub)").length;if(!n)d.remove();else{const s=d.querySelector("summary");s.textContent=s.textContent.replace(/\(\d+\)$/,"("+n+")")}},300);
}catch(x){f.classList.remove("busy");bs.forEach((b,i)=>b.disabled=was[i]);const m=document.createElement("span");m.className="err";m.textContent=step?"Could not move that, try again.":"Could not tick that off, try again.";li.querySelector(".b").append(m)}
});
})();`;

/** The look both pages share (the task page and the page of what Ted did): colours that follow light and dark, one column that fits a phone, the header line and the link between the pages. */
export const BASE_CSS = String.raw`:root{color-scheme:light dark;--red:#c62828;--amber:#b26a00}@media(prefers-color-scheme:dark){:root{--red:#ff6b6b;--amber:#ffb74d}}
body{font:16px/1.4 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:1rem}h1{font-size:1.2rem;margin:.2rem 0}.nav{float:right;font-size:.9rem}.nav a{color:inherit}`;
/** The link in each page's header to the other one. */
export const navLink = (to: "/tasks" | "/done"): string => `<a class="nav" href="${to}">${to === "/done" ? "What was done" : "Tasks"}</a>`;

/** The whole page for one conversation's list at `now` in `zone`. `token` is the tick-off forms' CSRF token; without it a row has no button. `nonce` (the response's CSP nonce) switches the script on; without it only <noscript>'s meta refresh remains. */
export function tasksPage(key: string, now: number, zone: string, token?: string, nonce?: string): string {
  const open = listItems(key, { limit: 200 }, now, zone);
  const done = listItems(key, { status: "done", limit: 200 }, now, zone).filter((i) => (i.doneAt ?? 0) >= now - WEEK * DAY);
  const c = counts(key, now, zone);
  const g = groupOpen(open, now, zone);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><noscript><meta http-equiv="refresh" content="60"></noscript><title>Tasks</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
${BASE_CSS}
.h{color:#777;margin-bottom:1rem}summary{font-weight:600;margin:.8rem 0 .3rem}ul{list-style:none;padding:0;margin:0}
li{display:flex;gap:.6rem;align-items:center;padding:.45rem 0 .45rem .5rem;border-top:1px solid #8884;border-left:4px solid transparent}
li.urgent{border-left-color:var(--amber)}li.late{border-left-color:var(--red)}li.late .d{color:var(--red);font-weight:600}li.urgent .m{color:var(--amber);font-weight:600}
.b{flex:1;min-width:0;display:flow-root}form{margin:0}button{font:inherit;min-width:2.6rem;min-height:2.6rem;border:1px solid #8886;border-radius:50%;background:transparent;color:inherit;cursor:pointer;transition:background-color .15s,border-color .15s}
button:hover,button:focus-visible{background:#2e7d6b26;border-color:#2e7d6b}button:active{background:#2e7d6b4d}button:focus-visible{outline:2px solid #2e7d6b;outline-offset:2px}
details.focus{background:#2e7d6b1f;border-left:4px solid #2e7d6b;border-radius:6px;padding:0 .6rem .3rem .6rem;margin-bottom:.5rem}details.focus li:first-child{border-top-color:transparent}
li.sub{display:block;border-left-color:transparent;padding:.5rem 0 .1rem .5rem;font-size:.75rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#777}li.sub:not(:first-child){margin-top:.3rem}
.gone{opacity:0;transition:opacity .3s}.err{display:block;color:var(--red);font-size:.85rem}.d{float:right;margin-left:.5rem;white-space:nowrap}.m{color:#777;font-size:.85rem}
form.step{float:right;clear:right;display:flex;gap:.3rem;margin:.15rem 0 0 .5rem}.step button{min-width:2.4rem;min-height:2.2rem;border-radius:.6rem;font-size:1.2rem;line-height:1;padding:0;border-color:#8884;color:#777}.step button:disabled{opacity:.3;cursor:default;background:transparent;border-color:#8884}
</style></head><body><h1>Tasks</h1>${navLink("/done")}<div class="h">${open.length} open${c.overdue ? `, ${c.overdue} overdue` : ""} · updated ${esc(localOf(now, zone).time)}</div>
${BUCKETS.map((b) => block(b, g[b], now, zone, b === "Today" || b === FOCUS, token)).join("")}${open.length ? "" : "<p>Nothing open.</p>"}
${block("Done in the last 7 days", done, now, zone, false)}${nonce ? `<script nonce="${nonce}">${SCRIPT}</script>` : ""}</body></html>`;
}

/** The tab icon: a tick in a rounded square, mid-tone colours that read on light and dark tabs. Served by the page itself; nothing is loaded from outside. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2e7d6b"/><path d="M8 17l5.5 5.5L24 10.5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** default-src 'none' stays. The one script runs only with this response's nonce (no 'unsafe-inline' for scripts, nothing external) and may fetch only from the page's own origin; a response without a nonce runs no script. */
const csp = (nonce?: string): string => `default-src 'none'; ${nonce ? `script-src 'nonce-${nonce}'; connect-src 'self'; ` : ""}img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

const HEADERS = {
  "content-security-policy": csp(),
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
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

/** Moves one of the owner's open tasks by `stepDate`'s rule, through the store function the update_task tool uses. Its time stays, its reminder moves by the same days, and a date after today drops the focus mark. Undefined when the id is not one of the owner's open tasks. */
function moveTask(id: number, dir: Dir): ReturnType<typeof dateView> | undefined {
  const now = Date.now();
  const zone = systemZone();
  const it = getItem(OWNER_KEY, id);
  if (!it || effectiveStatus(it, now) !== "open") return undefined;
  const today = todayIn(now, zone);
  const date = stepDate(it.due, dir, today);
  if (!date) return dateView(it, now, zone);
  const old = it.due ? parseLocal(it.due) : undefined;
  const at = it.remindAt !== undefined && old ? localOf(it.remindAt, zone) : undefined; // (a dateless task's reminder has no due to move with)
  const { item } = editItem(
    { key: OWNER_KEY, zone, by: "owner", origin: "owner", source: "chat", now, why: { text: "moved on the task page" } },
    id,
    { due: old?.time ? `${date}T${old.time}` : date, ...(at ? { remindAt: wallToUtc(zone, addDays(at.date, daysBetween(old!.date, date)), at.time) } : {}), ...(date > today ? { focus: false } : {}) },
  );
  return dateView(item, now, zone);
}

/** The second page, what was done on its own (conversation/donepage.ts): `read` renders it for the CSRF token and nonce; `undo` reverses the journal line made at that time, true when it did. */
export interface DonePage {
  read: (token: string, nonce: string) => string;
  undo: (at: number) => Promise<boolean>;
}

/**
 * GET /tasks (the page), GET /done (what was done, when `done` is given), GET /healthz, HEAD likewise, and the actions POST /tasks/<id>/done, POST /tasks/<id>/move (dir=earlier|later; a JSON answer when asked for, else a redirect) and POST /done/<at>/undo; any other path is 404, any other method 405.
 * `read` renders the page for this process's CSRF token; `tick` completes one of the owner's open tasks and says whether it did; `move` moves one's date and answers with the date to show (undefined: not an open task of the owner's).
 * A POST needs the right Host, an Origin equal to the page's own, a form content type, a tiny body and the token; every CSRF failure gets the same 403.
 */
export function tasksPageServer(read: (token: string, nonce: string) => string = (t, n) => tasksPage(OWNER_KEY, Date.now(), systemZone(), t, n), tick: (id: number) => boolean = tickOff, done?: DonePage, move: (id: number, dir: Dir) => ReturnType<typeof dateView> | undefined = moveTask): Server {
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
      const m = /^\/tasks\/(\d{1,9})\/(done|move)$/.exec(path);
      const u = done ? /^\/done\/(\d{1,16})\/undo$/.exec(path) : null;
      if (!m && !u) return send(405, "text/plain", "method not allowed", { allow: "GET, HEAD" });
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
      req.on("end", async () => {
        if (over) return send(413, "text/plain", "too large", { connection: "close" });
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (!sameToken(form.get("token") ?? "", token)) return forbidden();
        try {
          if (m?.[2] === "move") {
            const dir = form.get("dir");
            if (dir !== "earlier" && dir !== "later") return send(400, "text/plain", "bad request");
            const v = move(Number(m[1]), dir);
            if (!v) return send(404, "text/plain", "not found");
            if (req.headers.accept?.includes("application/json")) return send(200, "application/json", JSON.stringify(v));
          } else if (!(m ? tick(Number(m[1])) : await done!.undo(Number(u![1])))) return send(404, "text/plain", "not found");
        } catch (e) {
          console.error(`tasks page: ${(e as Error).message}`);
          return send(500, "text/plain", "that cannot be done right now");
        }
        send(303, "text/plain", "done", { location: m ? "/tasks" : "/done" });
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "method not allowed", { allow: "GET, HEAD, POST" });
    if (path === "/favicon.svg" || path === "/favicon.ico") return send(200, "image/svg+xml", FAVICON, { "cache-control": "public, max-age=86400" }); // (browsers ask for the .ico unasked)
    if (path === "/healthz") return send(200, "text/plain", "ok");
    if (path !== "/tasks" && !(done && path === "/done")) return send(404, "text/plain", "not found");
    try {
      const nonce = randomBytes(16).toString("base64"); // per response
      send(200, "text/html", (path === "/done" ? done!.read : read)(token, nonce), { "content-security-policy": csp(nonce) });
    } catch (e) {
      console.error(`tasks page: ${(e as Error).message}`);
      send(500, "text/plain", "the list cannot be read right now");
    }
  });
}

/** Start it on 127.0.0.1 and nowhere else; a port in use is logged and the agent carries on. */
export function startTasksPage(port: number, done?: DonePage): Server {
  const s = tasksPageServer(undefined, undefined, done);
  s.on("error", (e) => console.error(`tasks page: ${e.message}`));
  s.listen(port, "127.0.0.1");
  return s;
}
