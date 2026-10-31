import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

// The owner's task page (src/tasks/taskspage.ts): the due buckets in the owner's clock, escaping, the routes and methods, and that only the owner's list is ever read.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "taskspage-test-"));

const S = await import("../src/tasks/store.ts");
const { tasksPage, tasksPageServer } = await import("../src/tasks/taskspage.ts");
const { OWNER_KEY } = await import("../src/core/ownerkey.ts");

const ZONE = "Pacific/Auckland"; // NZDT (UTC+13) in October 2026
const NOW = Date.parse("2026-10-22T11:00:00Z"); // Fri 23 Oct 00:00 in Auckland, Thu 22 Oct in UTC
const scope = (key: string): import("../src/tasks/store.ts").Scope => ({ key, zone: ZONE, by: "owner", origin: "owner", source: "chat", now: NOW });
const add = (key: string, title: string, o: Partial<import("../src/tasks/store.ts").NewItem> = {}) => S.addItem(scope(key), { kind: "task", title, ...o });

add(OWNER_KEY, "Pay rent", { due: "2026-10-22" }); // yesterday there
add(OWNER_KEY, "Call Sam", { due: "2026-10-23T09:00", kind: "owed_to_me", person: "Sam" });
add(OWNER_KEY, "Book flights", { due: "2026-10-27" });
add(OWNER_KEY, "Renew passport", { due: "2026-12-01" });
add(OWNER_KEY, "Tidy <script>alert(1)</script>");
add("a-friends-or-group-key", "Secret friend task");

const index = (html: string, s: string) => html.indexOf(s);

test("tasks fall into the owner's day buckets, in the owner's zone", () => {
  const html = tasksPage(OWNER_KEY, NOW, ZONE);
  const at = ["Today (2)", "This week (1)", "Later (1)", "No date (1)"].map((h) => index(html, h));
  assert.ok(at.every((i) => i >= 0), html);
  assert.ok(!html.includes("Overdue ("));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(index(html, "Pay rent") > at[0]! && index(html, "Pay rent") < index(html, "Call Sam") && index(html, "Call Sam") < at[1]!); // overdue first
  assert.match(html, /5 open, 1 overdue · updated 00:00/);
  assert.match(html, /waiting on · Sam/);
});

test("only Today is open; the other sections are collapsed", () => {
  const html = tasksPage(OWNER_KEY, NOW, ZONE);
  const before = (h: string) => html.slice(index(html, h) - 30,index(html, h));
  assert.ok(before("Today (2)").includes("<details open>"));
  for (const h of ["This week (1)", "Later (1)", "No date (1)"]) assert.ok(before(h).includes("<details>"), h);
});

test("overdue and urgent rows carry their classes", () => {
  const id = add(OWNER_KEY, "Fix boiler", { due: "2026-10-23", urgent: true }).item.id;
  const html = tasksPage(OWNER_KEY, NOW, ZONE);
  assert.match(html, /<li class="late">(?:(?!<\/li>).)*Pay rent/s);
  assert.match(html, /<li class="urgent">(?:(?!<\/li>).)*Fix boiler/s);
  assert.ok(!/<li class="late">(?:(?!<\/li>).)*Call Sam/s.test(html));
  S.dropItem(scope(OWNER_KEY), id);
});

test("a title is escaped and nothing is loaded from outside", () => {
  const html = tasksPage(OWNER_KEY, NOW, ZONE);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&#60;script&#62;"));
  assert.ok(!/(src|href)=/.test(html.replace(' href="/favicon.svg"', ""))); // (the page's own icon is the one link)
  assert.ok(html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">'));
  assert.ok(!html.includes('name="token"')); // (no token, no buttons)
});

test("only the owner's list is read", () => {
  assert.ok(!tasksPage(OWNER_KEY, NOW, ZONE).includes("Secret friend task"));
});

test("only loopback and tailnet host names are served (DNS rebinding)", async () => {
  const server = tasksPageServer(() => "<p>page</p>");
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const status = (host: string) =>
    new Promise<number>((ok, bad) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/tasks", headers: { host } }, (res) => (res.resume(), ok(res.statusCode!)));
      req.on("error", bad).end();
    });
  try {
    assert.equal(await status("evil.example"), 421);
    assert.equal(await status(`evil.example:${port}`), 421);
    assert.equal(await status("127.0.0.1:1"), 421);
    assert.equal(await status(`127.0.0.1:${port}`), 200);
    assert.equal(await status(`localhost:${port}`), 200);
    assert.equal(await status("localhost"), 200);
    assert.equal(await status("x.y.ts.net"), 200);
    assert.equal(await status("x.y.ts.net:9443"), 200);
    assert.equal(await status("ts.net.evil.example"), 421);
    const icon = await new Promise<number>((ok, bad) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/favicon.svg", headers: { host: "evil.example" } }, (res) => (res.resume(), ok(res.statusCode!)));
      req.on("error", bad).end();
    });
    assert.equal(icon, 421); // (the icon is behind the same Host check)
  } finally {
    server.close();
  }
});

test("routes, methods and headers", async () => {
  const server = tasksPageServer(() => "<p>page</p>");
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/tasks`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<p>page</p>");
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("content-security-policy")!, /^default-src 'none'/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/tasks/1`)).status, 404);
    assert.equal((await fetch(`${base}/tasks`, { method: "POST", body: "x" })).status, 405);
    assert.equal((await fetch(`${base}/tasks`, { method: "HEAD" })).status, 200);
    assert.match(page.headers.get("content-security-policy")!, /form-action 'self'/);
    assert.match(page.headers.get("content-security-policy")!, /img-src 'self'/);
    for (const p of ["/favicon.svg", "/favicon.ico"]) {
      const icon = await fetch(`${base}${p}`);
      assert.equal(icon.status, 200);
      assert.match(icon.headers.get("content-type")!, /^image\/svg\+xml/);
      assert.match(icon.headers.get("cache-control")!, /max-age/);
      assert.match(await icon.text(), /^<svg /);
    }
  } finally {
    server.close();
  }
});

// The tick-off: POST /tasks/<id>/done.
const post = (port: number, path: string, o: { host?: string; origin?: string | null; token?: string | null; type?: string; body?: string } = {}) =>
  new Promise<{ status: number; location?: string; body: string }>((ok, bad) => {
    const host = o.host ?? `127.0.0.1:${port}`;
    const body = o.body ?? (o.token === null ? "" : `token=${o.token}`);
    const headers: Record<string, string> = { host, "content-type": o.type ?? "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) };
    if (o.origin !== null) headers.origin = o.origin ?? `http://${host}`;
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c)).on("end", () => ok({ status: res.statusCode!, location: res.headers.location, body: b }));
    });
    req.on("error", bad).end(body);
  });

async function withServer(fn: (port: number, token: string) => Promise<void>): Promise<void> {
  const server = tasksPageServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/tasks`)).text();
    await fn(port, /name="token" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "");
  } finally {
    server.close();
  }
}
const statusOf = (key: string, id: number) => S.getItem(key, id)?.status;

test("a tick with the token and the page's own origin completes the task and goes back to the page", async () => {
  const id = add(OWNER_KEY, "Water plants", { due: "2026-10-22" }).item.id;
  await withServer(async (port, token) => {
    assert.ok(token.length >= 32);
    const r = await post(port, `/tasks/${id}/done`, { token });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/tasks");
    assert.equal(statusOf(OWNER_KEY, id), "done");
    assert.equal((await post(port, `/tasks/${id}/done`, { token, host: `localhost:${port}` })).status, 404); // (already done: not open any more)
    const t = add(OWNER_KEY, "Sort mail").item.id;
    assert.equal((await post(port, `/tasks/${t}/done`, { token, host: "x.y.ts.net:9443", origin: "https://x.y.ts.net:9443" })).status, 303);
    assert.equal(statusOf(OWNER_KEY, t), "done");
  });
});

test("a tick without the right token or origin is refused, the same way, and changes nothing", async () => {
  const id = add(OWNER_KEY, "Feed cat").item.id;
  await withServer(async (port, token) => {
    const bad = [
      await post(port, `/tasks/${id}/done`, { token: null }),
      await post(port, `/tasks/${id}/done`, { token: "0".repeat(token.length) }),
      await post(port, `/tasks/${id}/done`, { token: token.slice(1) }),
      await post(port, `/tasks/${id}/done`, { token, origin: null }),
      await post(port, `/tasks/${id}/done`, { token, origin: "null" }), // (what a browser sends under no-referrer)
      await post(port, `/tasks/${id}/done`, { token, origin: "http://evil.example" }),
      await post(port, `/tasks/${id}/done`, { token, origin: `http://127.0.0.1:${port + 1}` }),
      await post(port, `/tasks/${id}/done`, { token, origin: `https://127.0.0.1:${port}` }),
      await post(port, `/tasks/${id}/done`, { token, host: "x.y.ts.net", origin: "https://other.y.ts.net" }),
    ];
    for (const r of bad) assert.deepEqual([r.status, r.body], [403, "forbidden"]);
    assert.equal(statusOf(OWNER_KEY, id), "open");
    assert.equal((await post(port, `/tasks/${id}/done`, { token, type: "text/plain" })).status, 415);
    assert.equal((await post(port, `/tasks/${id}/done`, { token, body: `token=${token}&x=${"a".repeat(2000)}` })).status, 413);
    assert.equal(statusOf(OWNER_KEY, id), "open");
  });
});

test("a tick from a foreign Host is misdirected", async () => {
  const id = add(OWNER_KEY, "Post letter").item.id;
  await withServer(async (port, token) => {
    assert.equal((await post(port, `/tasks/${id}/done`, { token, host: "evil.example", origin: "http://evil.example" })).status, 421);
    assert.equal(statusOf(OWNER_KEY, id), "open");
  });
});

test("another conversation's task is refused, and a GET changes nothing", async () => {
  let other = 0;
  for (let i = 0; i < 60; i++) other = add("a-friends-or-group-key", `Friend errand ${i}`).item.id; // (ids count per conversation: this one is past every owner id)
  const mine = add(OWNER_KEY, "Own errand").item.id;
  assert.ok(other > mine);
  await withServer(async (port, token) => {
    assert.equal((await post(port, `/tasks/${other}/done`, { token })).status, 404);
    assert.equal(statusOf("a-friends-or-group-key", other), "open");
    assert.equal((await post(port, "/tasks/abc/done", { token })).status, 405);
    assert.equal((await post(port, "/tasks", { token })).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${port}/tasks/${mine}/done`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/tasks`, { method: "DELETE" })).status, 405);
    assert.equal(statusOf(OWNER_KEY, mine), "open");
  });
});

test("a repeating task moves to its next due, like the tool", async () => {
  const id = add(OWNER_KEY, "Stretch", { due: "2026-10-22", repeat: "every day" }).item.id;
  await withServer(async (port, token) => {
    assert.equal((await post(port, `/tasks/${id}/done`, { token })).status, 303);
    const it = S.getItem(OWNER_KEY, id)!;
    assert.equal(it.status, "open");
    assert.ok(it.due! > "2026-10-22" && it.doneAt !== undefined);
  });
});

test("the page's one script runs only with the response's nonce, and the CSP has no unsafe-inline for scripts", async () => {
  const get = async (port: number) => {
    const r = await fetch(`http://127.0.0.1:${port}/tasks`);
    return { csp: r.headers.get("content-security-policy")!, html: await r.text() };
  };
  const server = tasksPageServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const port = (server.address() as AddressInfo).port;
    const [a, b] = [await get(port), await get(port)];
    const nonce = (x: { csp: string }) => /script-src 'nonce-([A-Za-z0-9+/=]{16,})'(;|$)/.exec(x.csp)?.[1];
    assert.ok(nonce(a) && nonce(b) && nonce(a) !== nonce(b)); // (new for every response)
    for (const x of [a, b]) {
      const script = /script-src ([^;]*)/.exec(x.csp)![1]!;
      assert.ok(!script.includes("unsafe-inline") && !script.includes("http") && !script.includes("*"));
      assert.match(x.csp, /^default-src 'none'; /);
      assert.ok(x.html.includes(`<script nonce="${nonce(x)}">`));
      assert.equal(x.html.match(/<script/g)!.length, 1); // (one script, not an external one)
      assert.ok(!/<script[^>]* src=/.test(x.html));
      assert.ok(x.html.includes('<noscript><meta http-equiv="refresh" content="60"></noscript>'));
      assert.ok(!/<meta http-equiv="refresh"/.test(x.html.replace(/<noscript>.*?<\/noscript>/s, "")));
    }
  } finally {
    server.close();
  }
});

test("the script posts the tick from the page (same token, same origin) and keeps the open sections over a refresh", () => {
  const html = tasksPage(OWNER_KEY, NOW, ZONE, "tok", "N0NCE");
  assert.ok(html.includes('<script nonce="N0NCE">'));
  assert.ok(html.includes('class="tick" method="post"')); // (without script the form posts as before)
  assert.match(html, /fetch\(f\.action,\{method:"POST"/);
  assert.match(html, /sessionStorage/);
  assert.doesNotThrow(() => new Function(/<script nonce="N0NCE">(.*)<\/script>/s.exec(html)![1]!)); // (it at least parses)
  assert.match(html, /d\.open=v\.o\[k\(d\)\]/);
});
