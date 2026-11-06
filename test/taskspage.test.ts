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
  assert.ok(!/(src|href)=/.test(html.replace(' href="/favicon.svg"', "").replace(' href="/done"', ""))); // (the page's own icon and the link to the other page are the only links)
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

test("This week is split by day in time order; Later by Monday-started week; the empty heading goes with its last task (script parses)", () => {
  const key = "subgroups-key";
  add(key, "Wed late", { due: "2026-10-28T18:00" });
  add(key, "Wed early", { due: "2026-10-28T08:00" });
  add(key, "Tue", { due: "2026-10-27" });
  add(key, "Later Mon", { due: "2026-11-02" }); // week of Mon 2 Nov
  add(key, "Later Sun", { due: "2026-11-08" }); // same week
  add(key, "Later next", { due: "2026-11-09" });
  const html = tasksPage(key, NOW, ZONE, "tok", "N");
  const at = ["Tue 27 Oct", "Wed 28 Oct", "Week of Mon 2 Nov", "Week of Mon 9 Nov"].map((h) => index(html, `<li class="sub">${h}</li>`));
  assert.ok(at.every((i) => i >= 0), html);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(index(html, "Wed early") < index(html, "Wed late") && index(html, "Wed late") < at[2]!);
  assert.ok(index(html, "Later Sun") > at[2]! && index(html, "Later Sun") < at[3]!);
  assert.ok(index(html, "Later next") > at[3]!);
  assert.ok(!html.includes('<li class="sub"></li>'));
  assert.match(html, /querySelectorAll\("li\.sub"\)/);
  assert.doesNotThrow(() => new Function(/<script nonce="N">(.*)<\/script>/s.exec(html)![1]!));
});

test("sub-headings follow the owner's local day, not UTC's", () => {
  const now = Date.parse("2026-10-30T11:00:00Z"); // Sat 31 Oct 00:00 in Auckland, still Fri 30 Oct in UTC
  add("zone-edge-key", "Edge", { due: "2026-11-07T23:30" }); // today+7 there: the last day of This week (UTC's today+7 would be 6 Nov)
  add("zone-edge-key", "Beyond", { due: "2026-11-08" }); // first day of Later, in the week of Mon 2 Nov
  const html = tasksPage("zone-edge-key", now, ZONE);
  assert.ok(html.includes('<li class="sub">Sat 7 Nov</li>'), html);
  assert.ok(html.includes('<li class="sub">Week of Mon 2 Nov</li>'), html);
});

// The date buttons: POST /tasks/<id>/move.
const { stepDate } = await import("../src/tasks/taskspage.ts");
const { systemZone } = await import("../src/core/timezone.ts");
const { addDays, localOf, wallToUtc, todayIn } = await import("../src/tasks/when.ts");
const { ledgerEntries } = await import("../src/core/messages.ts");
const { convIdOfKey, convPaths } = await import("../src/core/convpaths.ts");
const { peekConvDb } = await import("../src/core/convdb.ts");

test("the date rule: today is the minimum, a past date never jumps past today", () => {
  const rows: [string | undefined, "earlier" | "later", string, string | undefined][] = [
    [undefined, "earlier", "2026-10-22", "2026-10-22"],
    [undefined, "later", "2026-10-22", "2026-10-22"],
    ["2026-10-10", "earlier", "2026-10-22", "2026-10-22"],
    ["2026-10-10T09:00", "later", "2026-10-22", "2026-10-22"],
    ["2026-10-21", "later", "2026-10-22", "2026-10-22"],
    ["2026-10-22", "later", "2026-10-22", "2026-10-23"],
    ["2026-10-22T09:00", "earlier", "2026-10-22", undefined],
    ["2026-10-24", "later", "2026-10-22", "2026-10-25"],
    ["2026-10-24", "earlier", "2026-10-22", "2026-10-23"],
    ["2026-10-23", "earlier", "2026-10-22", "2026-10-22"], // (tomorrow back to today, never below)
    ["2026-10-31", "later", "2026-10-22", "2026-11-01"], // month end
    ["2026-11-01", "earlier", "2026-10-22", "2026-10-31"],
    ["2026-12-31", "later", "2026-10-22", "2027-01-01"], // year end
    ["2027-01-01", "earlier", "2026-10-22", "2026-12-31"],
    ["2028-02-28", "later", "2026-10-22", "2028-02-29"], // leap day
    ["2026-03-01", "later", "2026-02-28", "2026-03-02"],
    ["2026-03-01", "earlier", "2026-02-28", "2026-02-28"],
  ];
  for (const [due, dir, today, want] of rows) assert.equal(stepDate(due, dir, today), want, `${due} ${dir} on ${today}`);
});

const today = () => todayIn(Date.now(), systemZone());
const sc = (now = Date.now()) => ({ key: OWNER_KEY, zone: systemZone(), by: "owner", origin: "owner" as const, source: "chat" as const, now });
const addNow = (title: string, o: Partial<import("../src/tasks/store.ts").NewItem> = {}) => S.addItem(sc(), { kind: "task", title, ...o }).item.id;
const dueOf = (id: number) => S.getItem(OWNER_KEY, id)!.due;
const moveBody = async (port: number, id: number, token: string, dir: string, json = false) => {
  const r = await fetch(`http://127.0.0.1:${port}/tasks/${id}/move`, { method: "POST", redirect: "manual", headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded", ...(json ? { accept: "application/json" } : {}) }, body: `token=${token}&dir=${dir}` });
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
};

test("a move changes only the date, keeps the time, and answers with what to show", async () => {
  const t = today();
  const timed = addNow("Dentist", { due: `${addDays(t, 3)}T14:30` });
  const dateless = addNow("Sort drawer");
  const late = addNow("Old bill", { due: addDays(t, -9) });
  const todayId = addNow("Standup", { due: t });
  await withServer(async (port, token) => {
    let r = await moveBody(port, timed, token, "later");
    assert.deepEqual([r.status, r.location], [303, "/tasks"]);
    assert.equal(dueOf(timed), `${addDays(t, 4)}T14:30`);
    assert.equal(S.getItem(OWNER_KEY, timed)!.dueZone, systemZone());
    r = await moveBody(port, timed, token, "earlier", true);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { due: JSON.parse(r.text).due, late: false, canEarlier: true });
    assert.equal(dueOf(timed), `${addDays(t, 3)}T14:30`);

    r = await moveBody(port, dateless, token, "later", true);
    assert.equal(dueOf(dateless), t); // (no date: today, with no time)
    assert.equal(JSON.parse(r.text).canEarlier, false);
    r = await moveBody(port, late, token, "later", true);
    assert.equal(dueOf(late), t);
    assert.deepEqual([JSON.parse(r.text).late, JSON.parse(r.text).canEarlier], [false, false]);
    r = await moveBody(port, todayId, token, "earlier", true); // (does nothing)
    assert.equal(dueOf(todayId), t);
    for (let i = 1; i <= 3; i++) await moveBody(port, todayId, token, "later");
    assert.equal(dueOf(todayId), addDays(t, 3)); // (three taps, three days)
    assert.equal((await moveBody(port, todayId, token, "sideways")).status, 400);
  });
});

test("a move needs the token and the page's origin, and only touches the owner's open tasks", async () => {
  const id = addNow("Hold", { due: addDays(today(), 2) });
  const done = addNow("Finished", { due: addDays(today(), 2) });
  S.completeItem(sc(), done);
  let other = 0;
  for (let i = 0; i < 60; i++) other = add("another-key", `Other errand ${i}`, { due: addDays(today(), 2) }).item.id;
  await withServer(async (port, token) => {
    const url = `/tasks/${id}/move`;
    const zeros = "0".repeat(token.length);
    for (const r of [await post(port, url, { token: null, body: "dir=later" }), await post(port, url, { body: `token=${zeros}&dir=later` }), await post(port, url, { origin: "http://evil.example", body: `token=${token}&dir=later` }), await post(port, url, { origin: null, body: `token=${token}&dir=later` })])
      assert.deepEqual([r.status, r.body], [403, "forbidden"]);
    assert.equal(dueOf(id), addDays(today(), 2));
    assert.equal((await moveBody(port, 999_999, token, "later")).status, 404);
    assert.equal((await moveBody(port, done, token, "later")).status, 404);
    assert.equal(dueOf(done), addDays(today(), 2));
    assert.equal((await moveBody(port, other, token, "later")).status, 404);
    assert.equal(S.getItem("another-key", other)!.due, addDays(today(), 2));
  });
});

test("a move shifts the reminder by the same days, drops today's focus mark when it leaves today, and is in the history and journal", async () => {
  const t = today();
  const zone = systemZone();
  const id = addNow("Ring plumber", { due: addDays(t, 5), remindAt: wallToUtc(zone, addDays(t, 5), "08:15") });
  S.editItem(sc(), id, { focus: true });
  const overdue = addNow("Late thing", { due: addDays(t, -4), remindAt: wallToUtc(zone, addDays(t, 1), "09:00") });
  const soon = addNow("Soon thing", { due: addDays(t, 2), remindAt: wallToUtc(zone, t, "00:01") });
  const dateless = addNow("Loose end", { remindAt: wallToUtc(zone, addDays(t, 2), "10:00") });
  await withServer(async (port, token) => {
    await moveBody(port, id, token, "later");
    const it = S.getItem(OWNER_KEY, id)!;
    assert.equal(it.due, addDays(t, 6));
    assert.deepEqual(localOf(it.remindAt!, zone), { date: addDays(t, 6), time: "08:15" });
    assert.equal(it.focusOn, undefined); // (the new date is after today)
    await moveBody(port, overdue, token, "earlier"); // (4 days late to today: the reminder moves 4 days with it)
    assert.deepEqual(localOf(S.getItem(OWNER_KEY, overdue)!.remindAt!, zone), { date: addDays(t, 5), time: "09:00" });
    await moveBody(port, soon, token, "earlier"); // (a day back would put the reminder in the past, where it would fire at once: it stays)
    assert.equal(dueOf(soon), addDays(t, 1));
    assert.deepEqual(localOf(S.getItem(OWNER_KEY, soon)!.remindAt!, zone), { date: t, time: "00:01" });
    await moveBody(port, dateless, token, "later");
    assert.equal(dueOf(dateless), t);
    assert.deepEqual(localOf(S.getItem(OWNER_KEY, dateless)!.remindAt!, zone), { date: addDays(t, 2), time: "10:00" }); // (nothing to shift)
  });
  const ev = peekConvDb(convIdOfKey(OWNER_KEY))!.all<{ item_id: number; by: string; action: string; after: string }>("SELECT * FROM task_events WHERE item_id = ? ORDER BY id", id).at(-1)!;
  assert.deepEqual([ev.by, ev.action], ["owner", "edited"]);
  assert.ok(Object.keys(JSON.parse(ev.after)).includes("due"));
  const lines = ledgerEntries(convPaths(convIdOfKey(OWNER_KEY)).messages).filter((m) => m.kind === "journal").map((m) => m.text);
  assert.ok(lines.some((l) => l.startsWith(`Edited task #${id} 'Ring plumber' (changed due, reminder, focus)`) && l.includes("moved on the task page")), lines.join("\n"));
});

test("a focus mark stays when the task moves to today", async () => {
  const id = addNow("Keep focus", { due: addDays(today(), -2) });
  S.editItem(sc(), id, { focus: true });
  await withServer(async (port, token) => {
    await moveBody(port, id, token, "later");
    assert.equal(S.getItem(OWNER_KEY, id)!.focusOn, today());
  });
});

test("a repeating task moves only this occurrence: the rule stays and the next one follows from the new date", async () => {
  const t = today();
  const id = addNow("Water plants", { due: addDays(t, 2), repeat: "every day" });
  await withServer(async (port, token) => {
    await moveBody(port, id, token, "later");
    const it = S.getItem(OWNER_KEY, id)!;
    assert.deepEqual([it.due, it.repeat, it.status], [addDays(t, 3), "every day", "open"]);
    S.completeItem(sc(), id);
    assert.equal(dueOf(id), addDays(t, 4)); // (the day after the moved one, one live item)
    assert.equal(S.getItem(OWNER_KEY, id)!.repeat, "every day");
  });
});

test("the buttons are on open rows with the title in their label, off done rows, and earlier is disabled for a task due today", () => {
  const key = "stepper-key";
  const t = todayIn(NOW, ZONE);
  S.addItem(scope(key), { kind: "task", title: "Due today", due: t });
  S.addItem(scope(key), { kind: "task", title: "Due soon", due: addDays(t, 2) });
  const closed = S.addItem(scope(key), { kind: "task", title: "Closed one", due: addDays(t, 2) }).item.id;
  S.completeItem(scope(key), closed);
  const html = tasksPage(key, NOW, ZONE, "tok", "N");
  const li = (title: string) => new RegExp(`<li[^>]*>(?:(?!</li>).)*${title}(?:(?!</li>).)*</li>`, "s").exec(html)![0];
  assert.equal((li("Due today").match(/class="step"/g) ?? []).length, 1);
  assert.match(li("Due today"), /<button name="dir" value="earlier"[^>]* aria-label="Move earlier: Due today" disabled>/);
  assert.ok(!/value="later"[^>]* disabled/.test(li("Due today")));
  assert.ok(!/value="earlier"[^>]* disabled/.test(li("Due soon")));
  assert.match(li("Due soon"), /aria-label="Move later: Due soon"/);
  assert.ok(!li("Closed one").includes('class="step"'));
  assert.ok(!tasksPage(key, NOW, ZONE).includes('class="step"')); // (no token, no buttons)
  assert.doesNotThrow(() => new Function(/<script nonce="N">(.*)<\/script>/s.exec(html)![1]!));
});
