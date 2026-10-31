import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const at = ["Overdue (1)", "Today (1)", "This week (1)", "Later (1)", "No date (1)"].map((h) => index(html, h));
  assert.ok(at.every((i) => i >= 0), html);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(index(html, "Pay rent") < at[1]! && index(html, "Call Sam") > at[1]! && index(html, "Call Sam") < at[2]!);
  assert.match(html, /5 open, 1 overdue · updated 00:00/);
  assert.match(html, /waiting on · Sam/);
});

test("a title is escaped and nothing is loaded from outside", () => {
  const html = tasksPage(OWNER_KEY, NOW, ZONE);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&#60;script&#62;"));
  assert.ok(!/(src|href)=/.test(html));
});

test("only the owner's list is read", () => {
  assert.ok(!tasksPage(OWNER_KEY, NOW, ZONE).includes("Secret friend task"));
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
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("content-security-policy")!, /^default-src 'none'/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/tasks/1`)).status, 404);
    assert.equal((await fetch(`${base}/tasks`, { method: "POST", body: "x" })).status, 405);
    assert.equal((await fetch(`${base}/tasks`, { method: "HEAD" })).status, 200);
  } finally {
    server.close();
  }
});
