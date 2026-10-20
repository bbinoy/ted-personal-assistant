import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { readAudit } from "../src/core/audit.ts";
import { BrowseGuard, FAST_NAVIGATIONS } from "../src/modules/browse/browseguard.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { settings } from "../src/core/settings.ts";
import { standing } from "./util.ts";

// The navigate fast path: a navigate skips the judge only for a site this run was already cleared for (judged auto, or approved by the owner), when the address is
// plain (https, no port, no login, no fragment, a query of at most 120 characters) and the run has used fewer than FAST_NAVIGATIONS of them. The address floor and the
// DNS check run first, always. Everything else is judged (or asked) as before.

const B = "mcp__browser__browser_";
const opts = { signal: new AbortController().signal } as never;
const publicDns = async () => ["93.184.216.34"];
const setAuto = (mode: "auto" | "off") => void ((settings as { autoApprove: string }).autoApprove = mode);

function rig(o: { tenant?: boolean; judge?: Verdict["decision"]; owner?: boolean; resolver?: (h: string) => Promise<string[]> } = {}) {
  setAuto("auto");
  const g = new BrowseGuard({ mode: "owner", task: "find the opening times", outDir: join(tmpdir(), "nope"), resolver: o.resolver ?? publicDns, tenant: o.tenant });
  const judged: string[] = [];
  const asked: string[] = [];
  const can = makeCanUseTool(
    async (d) => (asked.push(d), { approved: o.owner ?? false }),
    "browse",
    undefined,
    (async (i: { description: string }): Promise<Verdict> => (judged.push(i.description), { decision: o.judge ?? "auto", reason: "fits the task" })) as never,
    g,
    undefined,
    !!o.tenant,
    { provenance: standing("find the opening times"), conversation: `fast-${Math.random()}` },
  );
  const go = async (url: string, tool = "navigate") => ((await can(`${B}${tool}`, { url }, opts)) as { behavior: string }).behavior;
  return { g, judged, asked, go, can };
}
const skipped = (host?: string) => readAudit((e) => e.decision === "judge-skipped" && (host === undefined || (e.meta as { host?: string } | undefined)?.host === host));

test("a new site is judged; the same site again skips the judge, with an audit row that says why", async () => {
  const r = rig();
  assert.equal(await r.go("https://shop-a.example.net/menu"), "allow");
  assert.equal(r.judged.length, 1, "the first navigate to a site is judged");
  assert.equal(await r.go("https://shop-a.example.net/opening-times?day=mon"), "allow");
  assert.equal(await r.go("https://shop-a.example.net/contact"), "allow");
  assert.equal(r.judged.length, 1, "the site was cleared: no more judge calls");
  assert.equal(r.asked.length, 0);
  const rows = skipped("shop-a.example.net");
  assert.equal(rows.length, 2);
  assert.equal((rows[0]!.meta as { reason: string }).reason, "same-host");
  assert.equal(rows[0]!.tool, `${B}navigate`);
  // another site is a new decision, and the one after it is free again
  assert.equal(await r.go("https://shop-b.example.net/"), "allow");
  assert.equal(r.judged.length, 2);
  assert.equal(await r.go("https://shop-b.example.net/x"), "allow");
  assert.equal(r.judged.length, 2);
  // a subdomain is another host
  assert.equal(await r.go("https://www.shop-a.example.net/"), "allow");
  assert.equal(r.judged.length, 3);
});

test("a long query, a fragment, http and a port are not fast-pathed: they are judged as they were", async () => {
  const r = rig();
  await r.go("https://shop-c.example.net/");
  assert.equal(r.judged.length, 1);
  for (const url of [`https://shop-c.example.net/search?q=${"x".repeat(130)}`, "https://shop-c.example.net/page#section", "http://shop-c.example.net/plain", "https://shop-c.example.net:8443/p"]) {
    const before: number = (r.judged as string[]).length;
    await r.go(url);
    assert.equal(r.judged.length, before + 1, `${url.slice(0, 60)} is judged as ever`);
  }
  assert.equal(skipped("shop-c.example.net").length, 0);
  // exactly 120 characters of query is still plain
  assert.equal(await r.go(`https://shop-c.example.net/s?${"q=".padEnd(119, "x")}`), "allow");
  assert.equal(skipped("shop-c.example.net").length, 1);
});

test("the address floor and the DNS check run first, also for a site the run was cleared for", async () => {
  let private_ = false;
  const r = rig({ resolver: async () => (private_ ? ["10.0.0.7"] : ["93.184.216.34"]) });
  await r.go("https://shop-d.example.net/");
  private_ = true;
  assert.equal(await r.go("https://shop-d.example.net/again"), "deny", "the name now points inside");
  private_ = false;
  for (const url of ["http://127.0.0.1/", "https://user:pw@shop-d.example.net/", "file:///etc/hosts", "https://10.1.2.3/"]) assert.equal(await r.go(url), "deny", url);
  assert.equal(skipped("shop-d.example.net").length, 0);
});

test("only FAST_NAVIGATIONS skips per run; then the judge decides again (an identical call the judge already passed stays free)", async () => {
  const r = rig();
  await r.go("https://shop-e.example.net/start");
  for (let i = 0; i < FAST_NAVIGATIONS; i++) await r.go(`https://shop-e.example.net/p${i}`);
  assert.equal(r.judged.length, 1);
  assert.equal(skipped("shop-e.example.net").length, FAST_NAVIGATIONS);
  await r.go("https://shop-e.example.net/one-more");
  assert.equal(r.judged.length, 2, "the cap is reached: judged");
  // the same call the judge already passed is not judged again, whatever the cap
  await r.go("https://shop-e.example.net/one-more");
  assert.equal(r.judged.length, 2);
  const again = skipped("shop-e.example.net").at(-1)!;
  assert.equal((again.meta as { reason: string }).reason, "same-call");
});

test("a redirect clears nothing: only the address the worker asked for counts, so the next navigate to the landing site is judged", async () => {
  const r = rig();
  await r.go("https://short.example.net/go");
  r.g.shape(`${B}navigate`, { url: "https://short.example.net/go" }, "### Page\n- Page URL: https://landing.example.org/offer\n### Snapshot\n```yaml\n- link \"Home\" [ref=e1]\n```");
  assert.equal(r.g.url, "https://landing.example.org/offer", "the page ended up elsewhere");
  await r.go("https://landing.example.org/offer/details");
  assert.equal(r.judged.length, 2, "judged: the redirect target was never cleared");
});

test("a site the owner approved is cleared; a site the owner declined or the judge sent to the owner is not", async () => {
  const yes = rig({ judge: "ask", owner: true });
  assert.equal(await yes.go("https://shop-f.example.net/"), "allow");
  assert.equal(yes.judged.length, 1);
  assert.equal(yes.asked.length, 1);
  assert.equal(await yes.go("https://shop-f.example.net/two"), "allow");
  assert.equal(yes.judged.length, 1, "the owner said yes to this site");
  assert.equal(yes.asked.length, 1);
  const no = rig({ judge: "ask", owner: false });
  assert.equal(await no.go("https://shop-g.example.net/"), "deny");
  assert.equal(await no.go("https://shop-g.example.net/two"), "deny");
  assert.equal(no.judged.length, 2, "nothing was cleared: judged again");
});

test("typing, forms and choices are never fast-pathed, and AUTO_APPROVE=off turns the fast path off", async () => {
  const r = rig();
  await r.go("https://shop-h.example.net/");
  r.g.shape(`${B}snapshot`, {}, '### Page\n- Page URL: https://shop-h.example.net/\n### Snapshot\n```yaml\n- textbox "Search" [ref=e5]\n```');
  const before = r.judged.length;
  await r.can(`${B}type`, { target: "e5", text: "pizza" }, opts);
  await r.can(`${B}type`, { target: "e5", text: "pizza" }, opts);
  assert.equal(r.judged.length, before + 2, "every typed value is judged");
  const off = rig();
  await off.go("https://shop-i.example.net/");
  setAuto("off");
  const asked = off.asked.length;
  await off.go("https://shop-i.example.net/two");
  assert.equal(off.asked.length, asked + 1, "off: everything that is not a plain read asks");
  setAuto("auto");
});

test("a tenant's judge-skipped row is wordless: lengths, no host", async () => {
  const r = rig({ tenant: true });
  await r.go("https://anna-private-site.example.net/");
  await r.go("https://anna-private-site.example.net/x");
  const rows = readAudit((e) => e.decision === "judge-skipped" && JSON.stringify(e.meta ?? {}).includes("reasonChars"));
  assert.ok(rows.length >= 1);
  const last = rows.at(-1)!;
  assert.equal((last.meta as { hostChars: number }).hostChars, "anna-private-site.example.net".length);
  assert.equal(readAudit((e) => JSON.stringify(e).includes("anna-private-site")).length, 0, "no row of her run names the site");
});
