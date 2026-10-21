import { test } from "node:test";
import assert from "node:assert/strict";
import { browse, Slots } from "../src/modules/browse/browse.ts";
import type { BrowseStatus } from "../src/modules/browse/browseserver.ts";
import { OWNER_KEY } from "../src/core/ownerkey.ts";

const READY: BrowseStatus = { ok: true, cli: "cli.js", exe: "chrome" };
const publicDns = async () => ["93.184.216.34"];
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("slots: up to the cap at once, one per conversation, a freed slot goes to the next waiter", async () => {
  const s = new Slots(() => 2);
  const a = (await s.acquire("a", false, 0))!;
  assert.ok(a);
  assert.equal(await s.acquire("a", false, 0), undefined, "one run per conversation");
  const b = (await s.acquire("b", false, 0))!;
  assert.ok(b);
  assert.equal(await s.acquire("c", false, 0), undefined, "the pool is full");
  const waiting = s.acquire("c", false, 5000);
  a();
  const c = (await waiting)!;
  assert.ok(c, "c got a's slot");
  assert.equal(s.size, 2);
  a(); // a second release of the same slot is harmless
  assert.equal(s.size, 2);
  b();
  c();
  assert.equal(s.size, 0);
});

test("slots: a wait that runs out is refused; the owner's chat goes ahead of those already waiting", async () => {
  const s = new Slots(() => 1);
  const first = (await s.acquire("x", false, 0))!;
  assert.equal(await s.acquire("y", false, 20), undefined, "timed out");
  const order: string[] = [];
  const friend = s.acquire("friend", false, 5000).then((r) => (order.push("friend"), r));
  const owner = s.acquire(OWNER_KEY, true, 5000).then((r) => (order.push("owner"), r));
  first();
  const o = (await owner)!;
  assert.deepEqual(order, ["owner"]);
  o();
  (await friend)!();
  assert.deepEqual(order, ["owner", "friend"]);
});

test("slots: a waiter whose conversation is still running does not block a later one that fits", async () => {
  const s = new Slots(() => 2);
  const a = (await s.acquire("a", false, 0))!;
  const b = (await s.acquire("b", false, 0))!;
  const a2 = s.acquire("a", false, 5000); // same conversation as a: must wait for a itself
  const c = s.acquire("c", false, 5000);
  b(); // a slot is free, but a2 cannot take it (a is running); c can
  assert.ok(await c);
  a();
  assert.ok(await a2);
});

test("browse: two conversations browse at once, a third waits for a slot and then runs; the same conversation twice is refused after its short wait", async () => {
  const slots = new Slots(() => 2);
  let gate!: () => void;
  const open = new Promise<void>((r) => (gate = r));
  let running = 0;
  let peak = 0;
  const mk = (key: string) => ({ mode: "group" as const, groupId: key, key, run: async () => (running++, (peak = Math.max(peak, running)), await open, running--, { text: "", structured: { status: "done", answer: `ok-${key}`, sources: [] } }) });
  const o = { status: READY, resolver: publicDns, slots, proxy: null };
  const r1 = browse(mk("g1"), "look up opening hours", o);
  const r2 = browse(mk("g2"), "look up opening hours", o);
  const r3 = browse(mk("g3"), "look up opening hours", { ...o, waitMs: 5000 });
  assert.match(await browse(mk("g1"), "look up opening hours", { ...o, waitMs: 20 }), /Another browser run is in progress/);
  await nap(30);
  assert.equal(peak, 2, "the cap holds; the third has not started");
  gate();
  assert.match(await r1, /ok-g1/);
  assert.match(await r2, /ok-g2/);
  assert.match(await r3, /ok-g3/);
  assert.equal(slots.size, 0, "every slot is given back");
});

test("browse: a failing run gives its slot back, and its proxy is closed with it", async () => {
  const slots = new Slots(() => 1);
  const closed: number[] = [];
  const proxy = () => ({ port: 40000, close: async () => void closed.push(1) });
  const run = async () => Promise.reject(new Error("boom"));
  assert.match(await browse({ mode: "group", groupId: "g", key: "g", run }, "look up opening hours", { status: READY, slots, proxy: proxy() }), /boom/);
  assert.equal(slots.size, 0);
  assert.deepEqual(closed, [1]);
  assert.match(await browse({ mode: "group", groupId: "g", key: "g", run: async () => ({ text: "", structured: { status: "done", answer: "fine", sources: [] } }) }, "look up opening hours", { status: READY, slots, proxy: proxy() }), /fine/);
});
