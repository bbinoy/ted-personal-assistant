import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPublicAddress, BLOCKED_ORIGINS, isPrivateAddress, resolvesPublic } from "../src/modules/browse/browserules.ts";
import { parseTarget, publicAddresses, startEgressProxy } from "../src/modules/browse/browseproxy.ts";
import { browserServer } from "../src/modules/browse/browseserver.ts";
import { BrowseGuard } from "../src/modules/browse/browseguard.ts";

// ---- isPublicAddress: the one rule of the network layer ----

test("isPublicAddress: public v4 and v6 pass; every private, shared, reserved, mapped, translated and tunnelled range is refused", () => {
  const yes = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "169.253.1.1", "11.0.0.1", "192.0.3.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888", "2002:5db8:d822::1", "::ffff:8.8.8.8", "64:ff9b::808:808"];
  const no = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.0.9", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.10", "192.0.0.1", "192.0.2.5",
    "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "100.64.0.1", "100.100.100.100", "100.127.255.255", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::2", "::ffff:127.0.0.1", "::ffff:192.168.1.10", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:010a", "0:0:0:0:0:ffff:a00:1",
    "fc00::1", "fd12:3456:789a::1", "fdff:ffff::1", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "ff02::1", "100::1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::192.168.1.10", "64:ff9b:1::1",
    "2002:7f00:1::", "2002:c0a8:010a::1", "2002:0a00:0001::", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "2001:1::1", "3fff::1", "5f00::1", "4000::1", "[::1]", "::127.0.0.1", "::1.2.3.4",
    "999.1.1.1", "1.2.3", "example.com", "", "1.2.3.4.5", "0x7f.0.0.1", "127.1",
  ];
  for (const ip of yes) assert.equal(isPublicAddress(ip), true, `${ip} is public`);
  for (const ip of no) assert.equal(isPublicAddress(ip), false, `${ip} is not public`);
  assert.equal(isPrivateAddress("192.168.1.10"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("resolvesPublic: any private answer vetoes the name; a failed lookup is left to the browser (and to the proxy)", async () => {
  assert.equal(await resolvesPublic("a.test", async () => ["93.184.216.34", "172.16.5.5"]), false);
  assert.equal(await resolvesPublic("a.test", async () => ["fd00::1"]), false);
  assert.equal(await resolvesPublic("a.test", async () => ["100.64.1.1"]), false);
  assert.equal(await resolvesPublic("a.test", async () => ["2606:4700::1"]), true);
  assert.equal(await resolvesPublic("a.test", async () => Promise.reject(new Error("nx"))), true);
});

test("BLOCKED_ORIGINS names the private ranges the old list missed (best effort by name; the proxy is the veto)", () => {
  for (const o of ["http://172.16.*", "https://172.31.*", "http://100.64.*", "https://100.127.*", "http://169.254.*", "http://127.*", "http://[fd*", "http://[fe80*", "http://[::ffff:*", "http://10.*", "https://192.168.*", "file://*"]) assert.ok(BLOCKED_ORIGINS.includes(o), o);
  assert.ok(!BLOCKED_ORIGINS.includes("http://172.15.*") && !BLOCKED_ORIGINS.includes("http://100.63.*"));
});

test("parseTarget: host and port of a CONNECT line, v6 in brackets", () => {
  assert.deepEqual(parseTarget("Example.com:443"), { host: "example.com", port: 443 });
  assert.deepEqual(parseTarget("[2001:db8::1]:8443"), { host: "2001:db8::1", port: 8443 });
  assert.equal(parseTarget("example.com"), undefined);
  assert.equal(parseTarget("a b:443"), undefined);
});

// ---- the proxy ----

const DNS: Record<string, string[]> = {
  "public.test": ["93.184.216.34"],
  "nas.attacker.test": ["192.168.1.10"],
  "tailnet.attacker.test": ["100.64.0.7"],
  "ula.attacker.test": ["fd00::10"],
  "mixed.test": ["93.184.216.34", "10.0.0.5"],
  "gone.test": [],
};

async function rig(resolve?: (host: string) => Promise<string[]>) {
  const upstream = createServer((s) => s.on("data", (d) => s.write(`echo:${d}`)));
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const web = httpServer((req, res) => res.end(`plain:${req.headers.host}${req.url}`));
  await new Promise<void>((ok) => web.listen(0, "127.0.0.1", ok));
  const dialled: string[] = [];
  let lookups = 0;
  const proxy = await startEgressProxy({
    resolve: resolve ?? (async (h) => (lookups++, DNS[h] ?? Promise.reject(new Error("nx")))),
    connect: (ip, port) => (dialled.push(`${ip}:${port}`), connect({ host: "127.0.0.1", port: port === 80 ? (web.address() as AddressInfo).port : (upstream.address() as AddressInfo).port })),
  });
  const via = (lines: string) =>
    new Promise<{ head: string; body: string }>((ok, fail) => {
      const c: Socket = connect(proxy.port, "127.0.0.1");
      let buf = "";
      c.on("data", (d) => {
        buf += d;
        if (lines.startsWith("CONNECT") && buf.includes("200 Connection Established") && !buf.includes("echo:")) c.write("ping");
        if (buf.includes("echo:") || buf.includes("plain:")) c.end();
      });
      c.on("error", fail);
      c.on("close", () => ok({ head: buf.split("\r\n")[0] ?? "", body: buf }));
      c.write(lines);
      setTimeout(() => c.destroy(), 1500);
    });
  return { proxy, dialled, lookups: () => lookups, via, close: async () => (await proxy.close(), upstream.close(), web.close()) };
}

test("proxy: a public target is tunnelled to the IP that was checked; a redirect target that resolves to a private address is refused and never dialled", async () => {
  const r = await rig();
  try {
    const ok = await r.via("CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n");
    assert.match(ok.head, /200 Connection Established/);
    assert.match(ok.body, /echo:ping/);
    assert.deepEqual(r.dialled, ["93.184.216.34:443"], "connected to the address that was checked, not to a name");
    for (const host of ["nas.attacker.test", "tailnet.attacker.test", "ula.attacker.test", "mixed.test"]) {
      const bad = await r.via(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
      assert.match(bad.head, /403 Forbidden/, host);
    }
    assert.deepEqual(r.dialled, ["93.184.216.34:443"], "no private address was ever dialled");
    assert.ok(r.proxy.refused.some((x) => x.host === "nas.attacker.test" && /private/.test(x.why)));
  } finally {
    await r.close();
  }
});

test("proxy: IP literals, loopback, ports outside the allowed list and names that do not resolve are refused; plain http goes the same way", async () => {
  const r = await rig();
  try {
    for (const t of ["127.0.0.1:443", "192.168.1.10:443", "[::1]:443", "[fd00::1]:443", "169.254.169.254:80", "public.test:22", "public.test:25", "public.test:3306"]) {
      const bad = await r.via(`CONNECT ${t} HTTP/1.1\r\n\r\n`);
      assert.match(bad.head, /403 Forbidden/, t);
    }
    assert.match((await r.via("CONNECT gone.test:443 HTTP/1.1\r\n\r\n")).head, /502/);
    assert.match((await r.via("CONNECT nx.test:443 HTTP/1.1\r\n\r\n")).head, /502/);
    assert.match((await r.via("CONNECT bad HTTP/1.1\r\n\r\n")).head, /400/);
    assert.deepEqual(r.dialled, []);
    // plain http: public is forwarded with its Host, private is refused
    const ok = await r.via("GET http://public.test/a?b=1 HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n");
    assert.match(ok.body, /plain:public\.test\/a\?b=1/);
    assert.deepEqual(r.dialled, ["93.184.216.34:80"]);
    assert.match((await r.via("GET http://nas.attacker.test/ HTTP/1.1\r\nHost: nas.attacker.test\r\n\r\n")).head, /403/);
    assert.match((await r.via("GET http://public.test:22/ HTTP/1.1\r\nHost: public.test:22\r\n\r\n")).head, /403/);
    assert.match((await r.via("GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")).head, /403/);
  } finally {
    await r.close();
  }
});

test("proxy: DNS rebinding cannot swap the address: the name is looked up once per connection and the connection goes to that answer", async () => {
  let n = 0;
  const r = await rig(async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"])); // first answer public, every later one private
  try {
    assert.match((await r.via("CONNECT rebind.test:443 HTTP/1.1\r\n\r\n")).head, /200/);
    assert.deepEqual(r.dialled, ["93.184.216.34:443"]);
    assert.equal(n, 1, "one lookup, no second resolution by the connect");
    assert.match((await r.via("CONNECT rebind.test:443 HTTP/1.1\r\n\r\n")).head, /403/, "the next connection is judged on its own lookup");
  } finally {
    await r.close();
  }
});

test("publicAddresses: literals are judged as they are, names by every answer", async () => {
  assert.deepEqual(await publicAddresses("8.8.8.8", async () => []), ["8.8.8.8"]);
  assert.deepEqual(await publicAddresses("10.1.1.1", async () => ["8.8.8.8"]), { problem: "not a public address" });
  assert.deepEqual(await publicAddresses("x.test", async () => ["8.8.8.8", "fe80::1"]), { problem: "the name points to a private address" });
});

test("the proxy closes with the run: its port stops answering", async () => {
  const p = await startEgressProxy({ resolve: async () => [] });
  await p.close();
  await assert.rejects(new Promise((ok, fail) => connect(p.port, "127.0.0.1").on("connect", ok).on("error", fail)));
});

test("the browser is started through the proxy with loopback NOT bypassed and no non-proxied UDP", () => {
  const st = { ok: true as const, cli: "/x/cli.js", exe: "/x/chrome" };
  const dir = mkdtempSync(join(tmpdir(), "bproxy-"));
  const withProxy = browserServer(st, dir, "ua", { proxyPort: 4321, cdpPort: 9222 });
  assert.equal(withProxy.type, "stdio");
  const cfg = JSON.parse(readFileSync(join(dir, "browser-config.json"), "utf8"));
  assert.deepEqual(cfg.browser.launchOptions.args, ["--proxy-server=http://127.0.0.1:4321", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic", "--remote-debugging-port=9222"]);
  browserServer(st, dir, "ua", { cdpPort: 9222, unproxiedForTest: true });
  assert.equal(JSON.parse(readFileSync(join(dir, "browser-config.json"), "utf8")).browser.launchOptions.args.includes("--proxy-server=http://127.0.0.1:4321"), false);
});

// ---- defense in depth in the guard ----

const B = "mcp__browser__browser_";
const view = (url: string, body = '- link "Open the NAS" [ref=e2]:\n    - /url: https://nas.attacker.test/admin') => `### Page\n- Page URL: ${url}\n### Snapshot\n\`\`\`yaml\n- generic [ref=e1]:\n  ${body}\n\`\`\``;
const guard = () => new BrowseGuard({ mode: "owner", task: "look something up", outDir: join(tmpdir(), "nope"), resolver: async (h) => DNS[h] ?? ["93.184.216.34"] });

test("guard: a link whose name resolves to a private address is refused when clicked (the text check alone passed it)", async () => {
  const g = guard();
  await g.decide(`${B}navigate`, { url: "https://public.test/" });
  g.shape(`${B}navigate`, { url: "https://public.test/" }, view("https://public.test/"));
  const d = await g.decide(`${B}click`, { target: "e2" });
  assert.equal(d.kind, "deny");
  assert.match(d.reason!, /points to a private address/);
});

test("guard: a page that loaded on a name resolving inside is withheld on the next call; navigating away is still possible", async () => {
  const g = guard();
  await g.decide(`${B}navigate`, { url: "https://public.test/" });
  g.shape(`${B}navigate`, { url: "https://public.test/" }, view("https://nas.attacker.test/", '- button "Hi" [ref=e2]')); // the redirect landed on a name that points inside
  await new Promise((r) => setTimeout(r, 10)); // (the model's next step comes later than the lookup)
  const d = await g.decide(`${B}click`, { target: "e2" });
  assert.equal(d.kind, "deny");
  assert.match(d.reason!, /private address; its content is withheld/);
  assert.equal(g.url, "");
  const nav = await g.decide(`${B}navigate`, { url: "https://public.test/other" });
  assert.notEqual(nav.kind, "deny");
});

test("fail closed: the browser's launch is refused without a proxy port", () => {
  const st = { ok: true as const, cli: "/x/cli.js", exe: "/x/chrome" };
  const dir = mkdtempSync(join(tmpdir(), "bproxy-"));
  assert.throws(() => browserServer(st, dir, "ua", { cdpPort: 9222 }), /egress proxy is missing/);
});

test("proxy: a keep-alive client that sends two plain http requests one after the other gets both answered (the second on a fresh connection, the first was closed)", async () => {
  const r = await rig();
  try {
    const one = (c: Socket, path: string) =>
      new Promise<string>((ok) => {
        let buf = "";
        const on = (d: Buffer) => ((buf += d), buf.includes(`plain:public.test${path}`) && (c.off("data", on), ok(buf)));
        c.on("data", on);
        c.on("close", () => ok(buf));
        c.write(`GET http://public.test${path} HTTP/1.1\r\nHost: public.test\r\nProxy-Connection: keep-alive\r\n\r\n`);
      });
    let c = connect(r.proxy.port, "127.0.0.1");
    assert.match(await one(c, "/1"), /plain:public\.test\/1/);
    await new Promise((ok) => setTimeout(ok, 50));
    if (c.destroyed || !c.writable) c = connect(r.proxy.port, "127.0.0.1"); // closed by the proxy: the browser reconnects
    assert.match(await one(c, "/2"), /plain:public\.test\/2/);
    c.destroy();
    // headers over the cap are refused, not forwarded
    const big = await r.via(`GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\nX-Big: ${"a".repeat(8000)}\r\nX-Big2: ${"b".repeat(8000)}\r\n\r\n`);
    assert.match(big.head, /431|400/);
  } finally {
    await r.close();
  }
});
