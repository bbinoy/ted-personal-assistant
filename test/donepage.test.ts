import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

// The page of what the assistant did (src/conversation/donepage.ts, served by tasks/taskspage.ts): days in the owner's zone, the owner's journal only, undo where code can do it, the same CSRF checks as the task page.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "donepage-test-"));

const S = await import("../src/tasks/store.ts");
const { donePage, ownerDonePage } = await import("../src/conversation/donepage.ts");
const { tasksPageServer } = await import("../src/tasks/taskspage.ts");
const { journalText } = await import("../src/core/sinks/journalsink.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { convPaths, OWNER_CONV } = await import("../src/core/convpaths.ts");
const { OWNER_KEY } = await import("../src/core/ownerkey.ts");

const ZONE = "Pacific/Auckland"; // NZDT (UTC+13) in October 2026
const NOW = Date.parse("2026-10-23T03:00:00Z"); // 16:00 on the 23rd there
const file = convPaths(OWNER_CONV).messages;
const friendFile = convPaths("friend-bob").messages;
let n = 0;
const line = (f: string, at: string | number, cat: string, p: Parameters<typeof journalText>[0]) => {
  const ms = typeof at === "number" ? at : Date.parse(at) + n++;
  recordMessage("journal", ms, journalText(p), new Date(ms), f, { cat });
};
const why = { text: "a periodic look at your accounts" };
const scope = (): import("../src/tasks/store.ts").Scope => ({ key: OWNER_KEY, zone: ZONE, by: "owner", origin: "owner", source: "chat" });

line(file, "2026-10-22T11:30:00Z", "mail", { what: "Sent a mail to Pat about <b>lunch</b>", why, undo: "ask me to write to Pat again" }); // 00:30 on the 23rd there, still the 22nd in UTC
line(file, "2026-10-22T09:00:00Z", "calendar", { what: "Added the event Dentist", why, undo: "delete that event (event id e1)" }); // 22:00 on the 22nd there
line(file, "2026-10-20T02:00:00Z", "memory", { what: "Wrote the note garden.md", why });
line(file, "2026-10-22T10:00:00Z", "triage", { what: "Kept a mail from Sam", why });
line(friendFile, "2026-10-22T11:30:00Z", "mail", { what: "FRIEND SECRET", why }); // (another conversation's log is never read)

test("entries are grouped by day in the owner's zone, newest first, older days collapsed", () => {
  const html = donePage(file, NOW, ZONE, true);
  const at = ["Today", "Yesterday", "Tue, 20 Oct 2026"].map((h) => html.indexOf(`<summary>${h}`));
  assert.ok(at.every((i) => i >= 0), html);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(html.indexOf("Sent a mail") > at[0]! && html.indexOf("Sent a mail") < at[1]!); // (00:30 there is today, though still yesterday in UTC)
  assert.ok(html.indexOf("Dentist") > at[1]! && html.indexOf("Dentist") < at[2]!);
  assert.match(html, /data-k="2026-10-23" open>/);
  assert.match(html, /data-k="2026-10-22" open>/);
  assert.match(html, /data-k="2026-10-20">/);
  assert.match(html, /<span class="tm">00:30<\/span>/);
  assert.match(html, /1 mail<\/span><\/summary>/); // (the day header counts)
  assert.ok(!html.includes("Kept a mail from Sam")); // (the per-mail triage log is not an action)
  assert.ok(!html.includes("FRIEND SECRET"));
  assert.ok(html.includes("&#60;b&#62;lunch")); // (escaped)
  assert.ok(html.includes('<a class="nav" href="/tasks">'));
});

test("an entry with an undo the code cannot do says to ask, with no button", () => {
  const html = donePage(file, NOW, ZONE, true, "tok");
  assert.ok(html.includes("ask me to undo"));
  assert.ok(!html.includes('class="undo"'));
});

test("no token and no nonce: no buttons and no script; a script gets the nonce", () => {
  assert.ok(!donePage(file, NOW, ZONE, true).includes("<script"));
  assert.match(donePage(file, NOW, ZONE, true, "tok", "N0NCE"), /<script nonce="N0NCE">/);
});

// ---- undo ----

const post = (port: number, path: string, o: { host?: string; origin?: string | null; token?: string | null } = {}) =>
  new Promise<number>((ok, bad) => {
    const host = o.host ?? `127.0.0.1:${port}`;
    const body = o.token === null ? "" : `token=${o.token}`;
    const headers: Record<string, string> = { host, "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) };
    if (o.origin !== null) headers.origin = o.origin ?? `http://${host}`;
    httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => (res.resume(), ok(res.statusCode!))).on("error", bad).end(body);
  });

async function withServer(restore: ((id: string) => Promise<number>) | undefined, fn: (port: number, token: string) => Promise<void>): Promise<void> {
  const server = tasksPageServer(undefined, undefined, ownerDonePage(restore));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/done`)).text();
    await fn(port, /name="token" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "");
  } finally {
    server.close();
  }
}
const page = async (port: number) => (await fetch(`http://127.0.0.1:${port}/done`)).text();
const journal = () => donePage(file, Date.now(), ZONE, true);
const recent = (): number => Date.now() - 60_000 + n++;

test("an archived mail is put back through the restore function, journaled, and then has no button", async () => {
  const ts = recent();
  line(file, ts, "archive", { what: "Archived “Newsletter” from Shop", why, undo: "npm run restore abc123, or say 'restore that'" });
  const calls: string[] = [];
  await withServer(async (id) => (calls.push(id), 0), async (port, token) => {
    assert.ok((await page(port)).includes(`action="/done/${ts}/undo"`));
    assert.equal(await post(port, `/done/${ts}/undo`, { token }), 303);
    assert.deepEqual(calls, ["abc123"]);
    assert.ok(!(await page(port)).includes(`action="/done/${ts}/undo"`));
    assert.equal(await post(port, `/done/${ts}/undo`, { token }), 404); // (already put back)
  });
  assert.ok(journal().includes("Restored mail to the inbox (id abc123)"));
  assert.ok(journal().includes("undone on the page"));
});

test("a failed restore changes nothing and is not journaled; with mail off there is no button", async () => {
  const ts = recent();
  line(file, ts, "archive", { what: "Archived “Invoice”", why, undo: "npm run restore zzz9, or say 'restore that'" });
  await withServer(async () => 1, async (port, token) => {
    assert.equal(await post(port, `/done/${ts}/undo`, { token }), 500);
    assert.ok(!journal().includes("id zzz9"));
  });
  await withServer(undefined, async (port, token) => {
    assert.ok(!(await page(port)).includes(`action="/done/${ts}/undo"`));
  });
});

test("a completed task is reopened, a task it added is dropped; both are journaled", async () => {
  const a = S.addItem(scope(), { kind: "task", title: "Pay rent" }).item.id;
  S.completeItem(scope(), a);
  const b = S.addItem(scope(), { kind: "task", title: "Call Sam" }).item.id;
  const t1 = recent();
  const t2 = recent();
  line(file, t1, "task", { what: `Completed task #${a} 'Pay rent'`, why, undo: `say 'reopen task #${a}'` });
  line(file, t2, "task", { what: `Added task #${b} 'Call Sam'`, why, undo: `say 'drop task #${b}'` });
  await withServer(undefined, async (port, token) => {
    const html = await page(port);
    assert.ok(html.includes(`/done/${t1}/undo`) && html.includes(`/done/${t2}/undo`));
    assert.equal(await post(port, `/done/${t1}/undo`, { token }), 303);
    assert.equal(S.getItem(OWNER_KEY, a)?.status, "open");
    assert.equal(await post(port, `/done/${t2}/undo`, { token }), 303);
    assert.equal(S.getItem(OWNER_KEY, b)?.status, "dropped");
    const after = await page(port);
    assert.ok(!after.includes(`/done/${t1}/undo`) && !after.includes(`/done/${t2}/undo`)); // (the state no longer allows either)
    assert.equal(await post(port, `/done/${t1}/undo`, { token }), 404);
  });
  assert.ok((journal().match(/undone on the page/g) ?? []).length >= 2);
});

test("an undo needs the token, the page's own origin and Host; an unknown or code-less entry is 404", async () => {
  const id = S.addItem(scope(), { kind: "task", title: "Water plants" }).item.id;
  const ts = recent();
  line(file, ts, "task", { what: `Added task #${id} 'Water plants'`, why, undo: `say 'drop task #${id}'` });
  const mail = recent();
  line(file, mail, "mail", { what: "Sent a mail to Pat", why, undo: "ask me" });
  await withServer(undefined, async (port, token) => {
    const bad = [
      await post(port, `/done/${ts}/undo`, { token: null }),
      await post(port, `/done/${ts}/undo`, { token: "0".repeat(token.length) }),
      await post(port, `/done/${ts}/undo`, { token, origin: null }),
      await post(port, `/done/${ts}/undo`, { token, origin: "http://evil.example" }),
      await post(port, `/done/${ts}/undo`, { token, origin: `https://127.0.0.1:${port}` }),
    ];
    assert.deepEqual(bad, [403, 403, 403, 403, 403]);
    assert.equal(await post(port, `/done/${ts}/undo`, { token, host: "evil.example", origin: "http://evil.example" }), 421);
    assert.equal(S.getItem(OWNER_KEY, id)?.status, "open");
    assert.equal(await post(port, `/done/${mail}/undo`, { token }), 404); // (a sent mail: no code undo)
    assert.equal(await post(port, `/done/1/undo`, { token }), 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/done`, { method: "POST", body: "x" })).status, 405);
    const r = await fetch(`http://127.0.0.1:${port}/done`);
    assert.match(r.headers.get("content-security-policy")!, /script-src 'nonce-/);
  });
});

test("without the second page /done is not served", async () => {
  const server = tasksPageServer(() => "<p>page</p>");
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/done`)).status, 404);
  } finally {
    server.close();
  }
});
