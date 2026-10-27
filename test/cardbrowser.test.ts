import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { standing } from "./util.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { BrowseGuard, resultText } from "../src/modules/browse/browseguard.ts";
import { cdpFrames, freePort } from "../src/modules/browse/browsecdp.ts";
import { browserServer } from "../src/modules/browse/browseserver.ts";
import { KillSwitch, openCardAccess } from "../src/modules/browse/card.ts";
import { Ledger } from "../src/modules/browse/payments.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { fakeCardStore } from "./fakebao.ts";
import { scratch, scratchDb } from "./scratch.ts";
import { BROWSE_RUN } from "./runkinds.ts";

// The card flow against a REAL headless Chromium and the real @playwright/mcp server, on local fake checkouts (test/fixtures/checkout): a shop, a hosted
// payment page of a "known payment provider" (checkout.stripe.com), and the payment provider's card fields in a cross-origin iframe (js.stripe.com).
// The names are mapped to 127.0.0.1 inside the browser and the certificate is self-signed and ignored, so nothing here leaves this machine and no
// real merchant, card or money is involved. Skipped when there is no Chromium (BROWSE_BROWSER_PATH, or <data root>/state/browse/browsers), no openssl,
// or port 8443 is taken (the guard allows only the usual ports).

const PAN = "4242424242424242";
const CVC = "0731";
const EXPIRY = "12/99";
const B = "mcp__browser__browser_";
const PORT = 8443;
const FIXTURES = join(import.meta.dirname, "fixtures", "checkout");
const publicDns = async () => ["93.184.216.34"];

function findChromium(): string | undefined {
  const given = process.env.BROWSE_BROWSER_PATH;
  if (given) return existsSync(given) ? given : undefined;
  for (let dir = resolve(import.meta.dirname, ".."); dirname(dir) !== dir; dir = dirname(dir)) {
    const root = join(dir, "state", "browse", "browsers");
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse())
      for (const sub of readdirSync(join(root, d))) if (existsSync(join(root, d, sub, "chrome-headless-shell"))) return join(root, d, sub, "chrome-headless-shell");
  }
  return undefined;
}

interface Env {
  call: (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string; text: string }>;
  g: BrowseGuard;
  asked: string[];
  received: string[];
  ledger: Ledger;
  ref: (name: string, frame?: boolean) => string;
  close: () => Promise<void>;
}

async function start(t: TestContext, o: { ads?: boolean } = {}): Promise<Env | undefined> {
  const exe = findChromium();
  if (!exe) return void t.skip("no Chromium (set BROWSE_BROWSER_PATH)");
  const dir = mkdtempSync(join(tmpdir(), "cardbrowser-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=fake.test"], { stdio: "ignore" });
  } catch {
    return void t.skip("no openssl");
  }
  const received: string[] = [];
  const page = (file: string) => readFileSync(join(FIXTURES, file), "utf8").replace("<!--ADS-->", o.ads ? '<iframe src="https://ads.test:8443/pixel" style="display:none"></iframe>' : "");
  const routes: Record<string, string> = {
    "shop.test/checkout": "shop.html",
    "shop.test/framed": "framed.html",
    "checkout.stripe.com/pay": "hosted.html",
    "js.stripe.com/card": "card-frame.html",
    "ads.test/pixel": "pixel.html",
  };
  const server: Server = createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
    const url = new URL(req.url ?? "/", "https://x");
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (url.pathname === "/done" || url.pathname === "/frame-received") {
      received.push(url.search);
      res.setHeader("content-type", "text/html");
      return void res.end(`<!doctype html><title>Done</title><h1>Thank you for your order</h1>`);
    }
    const file = routes[`${host}${url.pathname}`];
    if (!file) return void res.writeHead(404).end("not found");
    res.setHeader("content-type", "text/html");
    res.end(page(file));
  });
  const listening = await new Promise<boolean>((res) => (server.once("error", () => res(false)), server.listen(PORT, "127.0.0.1", () => res(true))));
  if (!listening) return void t.skip(`port ${PORT} is taken`);

  // The production browser server config (with the debugging port a card run gets), plus what the fake sites need.
  const cdpPort = await freePort();
  const outDir = join(dir, "out");
  execFileSync("mkdir", ["-p", outDir]);
  const st = { ok: true as const, cli: join(dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js"), exe };
  const cfg = browserServer(st, outDir, undefined, { mode: "off", cdpPort, unproxiedForTest: true });
  assert.ok(cfg.type === "stdio" || cfg.type === undefined);
  const stdio = cfg as { command: string; args: string[]; env: Record<string, string> };
  const configFile = stdio.args[stdio.args.indexOf("--config") + 1]!;
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  assert.ok(config.browser.launchOptions.args.includes(`--remote-debugging-port=${cdpPort}`), "a card run starts the browser with its debugging port");
  config.browser.launchOptions.args.push("--host-resolver-rules=MAP shop.test 127.0.0.1, MAP checkout.stripe.com 127.0.0.1, MAP js.stripe.com 127.0.0.1, MAP ads.test 127.0.0.1", "--ignore-certificate-errors");
  writeFileSync(configFile, JSON.stringify(config));
  const client = new Client({ name: "cardbrowser-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: stdio.command, args: [...stdio.args, "--ignore-https-errors"], env: stdio.env }));

  // the card in an in-process fake of OpenBao
  const cards = await fakeCardStore({ pan: PAN, expMonth: 12, expYear: 2099, cvc: CVC, label: "Wise", last4: "4242", currency: "CHF" });
  const ledger = new Ledger(scratchDb(`payments-test-browser-${process.pid}-${Date.now()}`));
  const access = (await openCardAccess({ store: cards, kill: new KillSwitch(scratch(`card-test-browser-${process.pid}.disabled`)), ledger, caps: { purchaseMinor: 5000, dayMinor: 10000 } }))!;
  const g = new BrowseGuard({ mode: "owner", task: "buy the ticket", outDir, resolver: publicDns, card: access, frames: cdpFrames(cdpPort) });
  const asked: string[] = [];
  const judge = async (): Promise<Verdict> => ({ decision: "auto", reason: "test" });
  const canUse = makeCanUseTool(async (description) => (asked.push(description), { approved: true }), BROWSE_RUN, undefined, judge, g, undefined, false, { provenance: standing("buy the ticket") });
  const opts = { signal: new AbortController().signal } as never;

  const call: Env["call"] = async (name, input) => {
    const res = (await canUse(B + name, input, opts)) as { behavior: string; message?: string; updatedInput?: Record<string, unknown> };
    if (res.behavior !== "allow") return { behavior: res.behavior, message: res.message, text: "" };
    const ran = res.updatedInput ?? input;
    const out = await client.callTool({ name: `browser_${name}`, arguments: ran });
    const raw = resultText(out);
    const shown = g.shape(B + name, ran, raw) ?? raw;
    if (process.env.CARD_DEBUG) console.log(`--- ${name} ${JSON.stringify(input)}\n${raw.slice(0, 1500)}`);
    return { behavior: "allow", text: shown };
  };
  const ref = (name: string, frame = false) => {
    const n = [...g.nodes.values()].find((x) => x.name.startsWith(name) && !!x.inFrame === frame);
    assert.ok(n, `no element “${name}” in the last page view`);
    return n.ref;
  };
  return {
    call, g, asked, received, ledger, ref,
    close: async () => {
      await client.close().catch(() => {});
      await new Promise((r) => server.close(r));
    },
  };
}

test("browser: a hosted payment page, end to end: the card goes into the page's fields by code, the server receives it, the model's view never has it", async (t) => {
  const e = await start(t);
  if (!e) return;
  try {
    const views: string[] = [];
    const go = async (name: string, input: Record<string, unknown>) => {
      const r = await e.call(name, input);
      assert.equal(r.behavior, "allow", `${name}: ${r.message}`);
      views.push(r.text);
      return r;
    };
    await go("navigate", { url: `https://shop.test:${PORT}/checkout` });
    await go("click", { target: e.ref("Pay by card") });
    assert.match(e.g.url, /checkout\.stripe\.com/);
    await go("snapshot", {});
    await go("type", { target: e.ref("Card number"), text: "{{card:number}}" });
    assert.equal(e.asked.length, 1);
    assert.match(e.asked[0]!, /Merchant: shop\.test/);
    assert.match(e.asked[0]!, /Card typed on: stripe\.com/);
    assert.match(e.asked[0]!, /Total \(read from the page by code, not checked by the shop\): CHF 45\.00/);
    await go("type", { target: e.ref("Expiration date"), text: "{{card:expiry}}" });
    await go("type", { target: e.ref("Security code"), text: "{{card:cvc}}" });
    const snap = await go("snapshot", {});
    assert.match(snap.text, /Card number.*\[filled\]/, "the page view shows the fields as filled, not with values");
    await go("click", { target: e.ref("Pay CHF 45.00") });
    await new Promise((r) => setTimeout(r, 300));
    const after = await go("snapshot", {});
    assert.match(after.text, /Thank you for your order/);
    // the fake server received the real values the browser was given
    assert.equal(e.received.length, 1);
    const q = new URLSearchParams(e.received[0]!);
    assert.deepEqual([q.get("number"), q.get("exp"), q.get("cvc")], [PAN, EXPIRY, CVC]);
    // none of what the model read holds a card detail
    for (const v of views) for (const secret of [PAN, "4242 4242", EXPIRY, CVC]) assert.ok(!v.includes(secret), `a view holds ${secret}`);
    assert.equal(e.ledger.rows()[0]!.status, "confirmed");
    // a second click, a retype: locked
    assert.match((await e.call("click", { target: "f1e13" })).message!, /already attempted/);
  } finally {
    await e.close();
  }
});

test("browser: a card in a cross-origin payment iframe is typed only because the browser's own frame list shows nothing but the shop and the payment provider", async (t) => {
  const e = await start(t);
  if (!e) return;
  try {
    const go = async (name: string, input: Record<string, unknown>) => {
      const r = await e.call(name, input);
      assert.equal(r.behavior, "allow", `${name}: ${r.message}`);
      return r;
    };
    await go("navigate", { url: `https://shop.test:${PORT}/framed` });
    const snap = await go("snapshot", {});
    assert.match(snap.text, /\[ref=f1e\d+\]/, "the frame's fields are f-refs in the page view");
    await go("type", { target: e.ref("Card number", true), text: "{{card:number}}" });
    assert.match(e.asked[0]!, /Card typed on: stripe\.com/);
    assert.match(e.asked[0]!, /Merchant: shop\.test/);
    await go("type", { target: e.ref("Expiration date", true), text: "{{card:expiry}}" });
    const last = await go("type", { target: e.ref("Security code", true), text: "{{card:cvc}}" });
    assert.ok(![PAN, EXPIRY, CVC].some((s) => last.text.includes(s)));
    await go("snapshot", {});
    await go("click", { target: e.ref("Pay CHF 45.00") });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(e.received.length, 1, "the payment frame received what code typed");
    const q = new URLSearchParams(e.received[0]!);
    assert.deepEqual([q.get("number"), q.get("exp"), q.get("cvc")], [PAN, EXPIRY, CVC]);
  } finally {
    await e.close();
  }
});

test("browser: a third-party frame on the payment page, even a hidden one that is not in the page view, stops the payment: no question, nothing typed, hand over", async (t) => {
  const e = await start(t, { ads: true });
  if (!e) return;
  try {
    await e.call("navigate", { url: `https://shop.test:${PORT}/framed` });
    await e.call("snapshot", {});
    const r = await e.call("type", { target: e.ref("Card number", true), text: "{{card:number}}" });
    assert.equal(r.behavior, "deny");
    assert.match(r.message!, /frame from ads\.test/);
    assert.match(r.message!, /needs_owner/);
    assert.equal(e.asked.length, 0);
    assert.equal(e.received.length, 0);
  } finally {
    await e.close();
  }
});
