import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The intake page's rate limits count a visitor by the address the TUNNEL reports (INTAKE_CLIENT_IP_HEADER), and the counting table sheds its oldest keys, never all of them.

const { clientIpOf, IntakeServer, Window } = await import("../src/intake/intakeserver.ts");
const { LinkStore } = await import("../src/intake/intakelinks.ts");
const { settings } = await import("../src/core/settings.ts");

test("the visitor's address: the last X-Forwarded-For entry by default, the named header when set, the peer when direct or when the header is missing", () => {
  assert.equal(settings.intake.clientIpHeader, "x-forwarded-for");
  assert.equal(clientIpOf("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, "x-forwarded-for"), "203.0.113.9", "the entries before the last are forgeable");
  assert.equal(clientIpOf("::ffff:127.0.0.1", { "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "1.1.1.1" }, "cf-connecting-ip"), "198.51.100.4");
  assert.equal(clientIpOf("127.0.0.1", { "x-forwarded-for": "1.1.1.1" }, "CF-Connecting-IP"), "127.0.0.1", "a tunnel that does not set the named header: the shared loopback bucket, never a forgeable other header");
  assert.equal(clientIpOf("127.0.0.1", {}, "x-forwarded-for"), "127.0.0.1");
  assert.equal(clientIpOf("192.0.2.7", { "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "1.1.1.1" }, "cf-connecting-ip"), "192.0.2.7", "a direct peer is itself: a header it sends means nothing");
});

test("rate limits are per visitor behind a tunnel: one visitor's flood does not lock out another, with either header", async () => {
  for (const header of ["x-forwarded-for", "cf-connecting-ip"]) {
    const page = new IntakeServer({ links: new LinkStore(mkdtempSync(join(tmpdir(), "intake-ip-"))), writer: { for: () => async () => {} }, clientIpHeader: header, limits: { perIpPerMinute: 2, globalPerMinute: 1000, badCodesPerIp: 1000 } });
    await new Promise<void>((r) => page.server.listen(0, "127.0.0.1", r));
    const port = (page.server.address() as { port: number }).port;
    const hit = (ip: string) =>
      new Promise<number>((resolve, reject) => {
        const rq = request({ port, host: "127.0.0.1", path: "/healthz", headers: { [header]: ip, connection: "close" } }, (res) => (res.resume(), resolve(res.statusCode!)));
        rq.on("error", reject).end();
      });
    assert.deepEqual([await hit("198.51.100.1"), await hit("198.51.100.1"), await hit("198.51.100.1")], [200, 200, 429]);
    assert.equal(await hit("198.51.100.2"), 200, "another visitor has her own bucket");
    page.server.closeAllConnections();
    page.server.close();
  }
});

test("a full table sheds its least recently hit keys; it never forgets the rest, so a flood cannot reset a blocked address", () => {
  const w = new Window(60_000, 3);
  const t = 1_000;
  w.add("blocked", t);
  w.add("blocked", t);
  w.add("a", t);
  w.add("b", t);
  w.add("blocked", t); // (hit again: now the most recent)
  w.add("c", t); // over the limit: the oldest-hit key (a) goes
  assert.equal(w.size, 3);
  assert.equal(w.count("blocked", t), 3, "the busy key keeps its whole history");
  assert.equal(w.count("a", t), 0);
  assert.equal(w.count("c", t), 1);
  for (let i = 0; i < 50; i++) w.add(`flood${i}`, t);
  assert.equal(w.size, 3, "bounded");
  assert.equal(w.count("blocked", t + 61_000), 0, "and the window still slides");
});
