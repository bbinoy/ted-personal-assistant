import { test } from "node:test";
import assert from "node:assert/strict";
import { standing } from "./util.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { browseSystem } from "../src/modules/browse/browse.ts";
import { BrowseGuard, resultText, withText } from "../src/modules/browse/browseguard.ts";
import { describePoint, freePort, openSession, pickPage, type Cdp, type PointInfo } from "../src/modules/browse/browsecdp.ts";
import { browserServer } from "../src/modules/browse/browseserver.ts";
import { hiddenBrowserTools, HIDDEN_BROWSER_TOOLS, isAllowedBrowserTool, type VisionMode } from "../src/modules/browse/browserules.ts";
import { clickProblem, MAX_POINT_CLICKS, MAX_SHOTS, screenshotInput, validPoint } from "../src/modules/browse/browsevision.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { loadSettings } from "../src/core/settings.ts";
import { cleanToolOutput } from "../src/core/toolclean.ts";
import { BROWSE_RUN } from "./runkinds.ts";

// The vision experiment (BROWSE_VISION): off changes nothing; read lets a screenshot reach the model; click resolves a point itself.

const B = "mcp__browser__browser_";
const opts = { signal: new AbortController().signal } as never;
const publicDns = async () => ["93.184.216.34"];
const PAGE = "https://shop.example.com/checkout";
const VIEW = `### Page\n- Page URL: ${PAGE}\n### Snapshot\n\`\`\`yaml\n- button "Search" [ref=e1]\n\`\`\``;

const guard = (vision: VisionMode, probe?: (x: number, y: number) => Promise<PointInfo | string>, over: Partial<ConstructorParameters<typeof BrowseGuard>[0]> = {}) => {
  const g = new BrowseGuard({ mode: "owner", task: "find a table for two", outDir: join(tmpdir(), "nope"), resolver: publicDns, vision, probe, ...over });
  g.shape(`${B}snapshot`, {}, VIEW);
  return g;
};
const info = (o: Partial<PointInfo> = {}): PointInfo => ({ pageUrl: PAGE, role: "button", name: "Search", tag: "button", href: "", inForm: false, formName: "", hints: "", password: false, ...o });
const at = (o: Partial<PointInfo> = {}) => async () => info(o);
const click = { x: 100, y: 200 };

// ---- off: nothing changes ----

test("vision off is today's behaviour: no screenshot, no point tools, the same hidden list, the same server flags, the same prompt", async () => {
  assert.equal(loadSettings({}).browseVision, "off");
  assert.throws(() => loadSettings({ BROWSE_VISION: "on" }), /BROWSE_VISION/);
  assert.equal(isAllowedBrowserTool(`${B}take_screenshot`), false);
  assert.equal(isAllowedBrowserTool(`${B}mouse_click_xy`), false);
  assert.deepEqual(hiddenBrowserTools(), HIDDEN_BROWSER_TOOLS);
  assert.deepEqual(hiddenBrowserTools("off"), HIDDEN_BROWSER_TOOLS);
  assert.equal(browseSystem(), browseSystem(undefined, "off"));
  assert.ok(!/screenshot/.test(browseSystem()));
  const g = guard("off");
  for (const t of ["take_screenshot", "mouse_click_xy", "mouse_move_xy", "mouse_wheel", "mouse_down", "mouse_drag_xy"]) assert.equal((await g.decide(B + t, { x: 1, y: 1 })).kind, "deny", t);
  const dir = mkdtempSync(join(tmpdir(), "bv-"));
  const cfg = browserServer({ ok: true, cli: "/c/cli.js", exe: "/e/chrome" }, dir, "UA/1", { mode: "off", unproxiedForTest: true }) as { args: string[] };
  assert.equal(cfg.args[cfg.args.indexOf("--image-responses") + 1], "omit");
  assert.ok(!cfg.args.includes("--caps"));
  assert.equal(JSON.parse(readFileSync(cfg.args[cfg.args.indexOf("--config") + 1]!, "utf8")).browser.launchOptions.args.some((a: string) => a.startsWith("--remote-debugging-port")), false, "no debugging port");
});

// ---- read: a screenshot reaches the model, clicks stay by ref ----

test("vision read: the screenshot is allowed as a small jpeg of the viewport, never saved under a name, never of a selector, a few per run", async () => {
  assert.equal(isAllowedBrowserTool(`${B}take_screenshot`, "read"), true);
  assert.equal(isAllowedBrowserTool(`${B}mouse_click_xy`, "read"), false);
  assert.ok(!hiddenBrowserTools("read").includes(`${B}take_screenshot`));
  assert.ok(hiddenBrowserTools("read").includes(`${B}evaluate`) && hiddenBrowserTools("read").includes(`${B}run_code_unsafe`));
  assert.match(browseSystem(undefined, "read"), /browser_take_screenshot/);
  assert.ok(!/mouse_click_xy/.test(browseSystem(undefined, "read")));
  const g = guard("read");
  const ok = await g.decide(`${B}take_screenshot`, { type: "png", scale: "device", element: "x" });
  assert.equal(ok.kind, "defer");
  assert.deepEqual(ok.input, { type: "jpeg", scale: "css" }, "narrowed by code");
  assert.deepEqual(screenshotInput({ target: "e12", element: "the chart" }), { input: { type: "jpeg", scale: "css", target: "e12", element: "the chart" } });
  for (const bad of [{ filename: "../../x.png" }, { fullPage: true }, { target: "#buy" }, { target: "button.buy" }]) assert.equal((await guard("read").decide(`${B}take_screenshot`, bad)).kind, "deny", JSON.stringify(bad));
  for (const t of ["mouse_click_xy", "mouse_move_xy", "mouse_wheel", "mouse_down", "mouse_up", "mouse_drag_xy"]) assert.equal((await g.decide(B + t, { ...click })).kind, "deny", t);
  const h = guard("read");
  for (let i = 0; i < MAX_SHOTS; i++) assert.equal((await h.decide(`${B}take_screenshot`, {})).kind, "defer");
  assert.equal((await h.decide(`${B}take_screenshot`, {})).kind, "deny", "the eleventh");
});

test("vision read: the server sends images; the ref rules are untouched (a commit by ref still goes to the judge)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-"));
  const cfg = browserServer({ ok: true, cli: "/c/cli.js", exe: "/e/chrome" }, dir, "UA/1", { mode: "read", unproxiedForTest: true }) as { args: string[] };
  assert.equal(cfg.args[cfg.args.indexOf("--image-responses") + 1], "allow");
  assert.ok(!cfg.args.includes("--caps"), "no point tools in read");
  assert.equal(JSON.parse(readFileSync(cfg.args[cfg.args.indexOf("--config") + 1]!, "utf8")).browser.launchOptions.args.some((a: string) => a.startsWith("--remote-debugging-port")), false);
  for (const f of ["--headless", "--isolated", "--block-service-workers", "--blocked-origins"]) assert.ok(cfg.args.includes(f), f);
  const g = guard("read");
  g.shape(`${B}snapshot`, {}, `### Page\n- Page URL: ${PAGE}\n### Snapshot\n\`\`\`yaml\n- button "Book now" [ref=e9]\n\`\`\``);
  const d = await g.decide(`${B}click`, { target: "e9" });
  assert.equal(d.kind, "ask");
  assert.equal(d.judge, true);
});

test("an image block survives the result path: shape keeps it, the door-cleaning keeps it, only the text is cleaned", () => {
  const image = { type: "image", data: "/9j/4AAQSkZJRg==", mimeType: "image/jpeg" };
  const result = { content: [{ type: "text", text: "### Result\n- [Screenshot of viewport](/tmp/x.jpeg)​" }, image] };
  const g = guard("read");
  const shaped = g.shape(`${B}take_screenshot`, {}, resultText(result));
  assert.ok(shaped !== undefined && !shaped.includes("​"), "hidden characters out of the text");
  const next = withText(result, shaped!) as { content: unknown[] };
  assert.deepEqual(next.content[1], image);
  assert.equal(cleanToolOutput(`${B}take_screenshot`, { content: [{ type: "text", text: "ok" }, image] }), undefined, "nothing to clean: left as it is");
  const cleaned = cleanToolOutput(`${B}take_screenshot`, next);
  assert.equal(cleaned, undefined);
});

test("a screenshot runs with the input code narrowed it to (permission path)", async () => {
  const g = guard("read");
  const canUse = makeCanUseTool(async () => ({ approved: false }), BROWSE_RUN, undefined, async (): Promise<Verdict> => ({ decision: "auto", reason: "x" }), g, undefined, false, { provenance: standing("t") });
  const r = (await canUse(`${B}take_screenshot`, { type: "png", scale: "device" }, opts)) as { behavior: string; updatedInput?: Record<string, unknown> };
  assert.equal(r.behavior, "allow");
  assert.deepEqual(r.updatedInput, { type: "jpeg", scale: "css" });
  const bad = (await canUse(`${B}take_screenshot`, { filename: "/etc/x" }, opts)) as { behavior: string };
  assert.equal(bad.behavior, "deny");
});

// ---- click: the guard resolves the point itself ----

test("vision click: the tools, the server (point tools and a loopback debugging port) and the prompt", () => {
  for (const t of ["take_screenshot", "mouse_click_xy", "mouse_move_xy", "mouse_wheel"]) assert.equal(isAllowedBrowserTool(B + t, "click"), true, t);
  for (const t of ["mouse_down", "mouse_up", "mouse_drag_xy", "evaluate", "run_code_unsafe", "drag", "file_upload"]) {
    assert.equal(isAllowedBrowserTool(B + t, "click"), false, t);
    assert.ok(hiddenBrowserTools("click").includes(B + t), t);
  }
  const dir = mkdtempSync(join(tmpdir(), "bv-"));
  const cfg = browserServer({ ok: true, cli: "/c/cli.js", exe: "/e/chrome" }, dir, "UA/1", { mode: "click", cdpPort: 41234, unproxiedForTest: true }) as { args: string[] };
  assert.equal(cfg.args[cfg.args.indexOf("--caps") + 1], "vision");
  assert.equal(cfg.args[cfg.args.indexOf("--image-responses") + 1], "allow");
  assert.deepEqual(JSON.parse(readFileSync(cfg.args[cfg.args.indexOf("--config") + 1]!, "utf8")).browser.launchOptions.args.filter((a: string) => a.startsWith("--remote-debugging-port")), ["--remote-debugging-port=41234"]);
  assert.match(browseSystem(undefined, "click"), /browser_mouse_click_xy/);
  assert.match(browseSystem(undefined, "click"), /Type only by ref/);
});

test("point clicks: an ordinary element goes through; the lookup is code's, so what the model says about the point does not matter", async () => {
  const seen: [number, number][] = [];
  const g = guard("click", async (x, y) => (seen.push([x, y]), info()));
  const d = await g.decide(`${B}mouse_click_xy`, { ...click, element: "the harmless Learn more link" });
  assert.equal(d.kind, "defer");
  assert.deepEqual(seen, [[100, 200]]);
  assert.match(d.description!, /click at \(100, 200\)/);
});

test("point clicks: the same commit classification and judge as a ref click", async () => {
  for (const [name, role, inForm] of [["Book now", "button", false], ["Submit order", "button", true], ["Confirm payment", "link", false], ["Go", "button", true]] as const) {
    const d = await guard("click", at({ name, role, inForm })).decide(`${B}mouse_click_xy`, click);
    assert.equal(d.kind, "ask", name);
    assert.equal(d.judge, true, `${name} goes to the judge first`);
    assert.equal(d.once, true);
    assert.match(d.description!, /Browser: confirm this step/);
    assert.ok(d.description!.includes(name));
    assert.match(d.description!, /shop\.example\.com\/checkout/);
  }
  // plain things are not commits
  for (const o of [{ name: "Search" }, { name: "Next", inForm: true }, { name: "", role: "button" }, { role: "textbox", name: "City" }, { role: "generic", name: "Two guests" }]) assert.equal((await guard("click", at(o)).decide(`${B}mouse_click_xy`, click)).kind, "defer", JSON.stringify(o));
  // a plain div that says Book now is a commit, whatever its role
  assert.equal((await guard("click", at({ role: "generic", name: "Buy now", tag: "div" })).decide(`${B}mouse_click_xy`, click)).judge, true);
});

test("point clicks: what code cannot resolve goes to the judge with its context, not straight to the owner", async () => {
  const unresolved: [string, (x: number, y: number) => Promise<PointInfo | string>][] = [
    ["another page than the last page view", async () => info({ pageUrl: "https://evil.example.net/" })],
    ["a lookup that keeps failing", async () => "the lookup failed (boom)"],
    ["tabs that cannot be told apart", async () => "2 tabs are open, so which one is shown is not certain"],
  ];
  for (const [why, probe] of unresolved) {
    const d = await guard("click", probe).decide(`${B}mouse_click_xy`, click);
    assert.equal(d.kind, "ask", why);
    assert.equal(d.judge, true, `${why}: the judge decides first`);
    assert.equal(d.once, true);
    assert.match(d.description!, /could not be identified/);
    assert.match(d.description!, /\(100, 200\)/);
    assert.match(d.description!, /find a table for two/);
    assert.match(d.description!, /Controls on the page: button “Search”/);
  }
  // an embedded frame can hold a payment or login widget code cannot read: the owner is asked directly, never the judge
  const framed = await guard("click", async () => info({ tag: "iframe", opaque: "an embedded frame (payment and login widgets live in one)" })).decide(`${B}mouse_click_xy`, click);
  assert.equal(framed.kind, "ask");
  assert.notEqual(framed.judge, true);
  // no page view yet
  const fresh = new BrowseGuard({ mode: "owner", task: "t", outDir: "/x", resolver: publicDns, vision: "click", probe: at() });
  assert.equal((await fresh.decide(`${B}mouse_click_xy`, click)).judge, true);
  // a lookup that fails once is retried and then resolves
  let n = 0;
  const flaky = guard("click", async () => (n++ === 0 ? "the lookup failed (timed out)" : info()));
  assert.equal((await flaky.decide(`${B}mouse_click_xy`, click)).kind, "defer");
  assert.equal(n, 2);
});

test("point clicks: an empty area, a canvas or a map surface is a plain click, logged with what was hit", async () => {
  for (const o of [{ role: "generic", name: "(empty area)", tag: "none", nothing: true }, { role: "generic", name: "(canvas)", tag: "canvas" }, { role: "generic", name: "(svg)", tag: "svg" }, { role: "generic", name: "", tag: "body" }]) {
    const d = await guard("click", at(o)).decide(`${B}mouse_click_xy`, click);
    assert.equal(d.kind, "defer", JSON.stringify(o));
  }
  // a canvas inside a link still follows the link rules
  assert.equal((await guard("click", at({ role: "link", name: "Admin", tag: "canvas", href: "http://192.168.1.1/" })).decide(`${B}mouse_click_xy`, click)).kind, "deny");
  // a canvas inside a booking button is that button
  assert.equal((await guard("click", at({ role: "button", name: "Book now", tag: "canvas" })).decide(`${B}mouse_click_xy`, click)).judge, true);
});

test("point clicks: the judge asking (or failing) reaches the owner for an unresolved point", async () => {
  const asked: string[] = [];
  const mk = (verdict: () => Promise<Verdict>) => makeCanUseTool(async (d) => (asked.push(d), { approved: false }), BROWSE_RUN, undefined, verdict, guard("click", async () => "the lookup failed (boom)"), undefined, false, { provenance: standing("find a table") });
  assert.equal(((await mk(async () => ({ decision: "ask", reason: "x" }))(`${B}mouse_click_xy`, click, opts)) as { behavior: string }).behavior, "deny");
  assert.equal(asked.length, 1);
  asked.length = 0;
  await mk(async () => ({ decision: "ask", reason: "the judge failed" }))(`${B}mouse_click_xy`, click, opts); // autojudge turns an error or junk into ask
  assert.equal(asked.length, 1, "a judge failure fails closed to the owner");
  asked.length = 0;
  const auto = await mk(async () => ({ decision: "auto", reason: "x" }))(`${B}mouse_click_xy`, { x: 301, y: 302 }, opts); // its own point: an auto-approved call is remembered by its input
  assert.equal(asked.length, 0);
  assert.equal((auto as { behavior: string }).behavior, "allow");
});

test("point clicks: payment and login fields always ask, no judge; the question names the kind, not a value", async () => {
  const fields: Partial<PointInfo>[] = [
    { role: "textbox", name: "Card number", tag: "input" },
    { role: "textbox", name: "", tag: "input", password: true },
    { role: "textbox", name: "", tag: "input", hints: "payment cc-csc" },
    { role: "textbox", name: "Sicherheitscode", tag: "input" },
    { role: "textbox", name: "", tag: "input", hints: "x one-time-code" },
  ];
  for (const f of fields) {
    const d = await guard("click", at(f)).decide(`${B}mouse_click_xy`, click);
    assert.equal(d.kind, "ask", JSON.stringify(f));
    assert.ok(!d.judge, "no judge");
    assert.match(d.description!, /payment or login detail/);
  }
  // end to end: a judge that says auto cannot skip it
  const asked: string[] = [];
  let judged = 0;
  const canUse = makeCanUseTool(async (d) => (asked.push(d), { approved: false }), BROWSE_RUN, undefined, async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "x" }), guard("click", at(fields[1]!)), undefined, false, { provenance: standing("t") });
  assert.equal(((await canUse(`${B}mouse_click_xy`, click, opts)) as { behavior: string }).behavior, "deny");
  assert.equal(asked.length, 1);
  assert.equal(judged, 0);
});

test("point clicks through the permission path: a commit is judged, then the owner is asked if the judge asks; an unidentified point is judged too", async () => {
  const asked: string[] = [];
  const judgedFor: string[] = [];
  const mk = (probe: Parameters<typeof guard>[1], verdict: Verdict["decision"]) => makeCanUseTool(async (d) => (asked.push(d), { approved: false }), BROWSE_RUN, undefined, async (i): Promise<Verdict> => (judgedFor.push(i.description), { decision: verdict, reason: "x" }), guard("click", probe), undefined, false, { provenance: standing("find a table") });
  const c1 = mk(at({ name: "Book now" }), "ask");
  assert.equal(((await c1(`${B}mouse_click_xy`, click, opts)) as { behavior: string }).behavior, "deny");
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /Book now/);
  const c2 = mk(async () => "no", "auto");
  asked.length = 0;
  judgedFor.length = 0;
  assert.equal(((await c2(`${B}mouse_click_xy`, { x: 401, y: 402 }, opts)) as { behavior: string }).behavior, "allow");
  assert.equal(asked.length, 0, "the judge said auto");
  assert.equal(judgedFor.length, 1, "the judge saw the unresolved point");
});

test("point clicks: links go through the address check, odd clicks and points are refused, caps hold", async () => {
  const link = (href: string) => guard("click", at({ role: "link", name: "Admin", href })).decide(`${B}mouse_click_xy`, click);
  assert.equal((await link("http://192.168.1.1/admin")).kind, "deny");
  assert.equal((await link("file:///etc/passwd")).kind, "deny");
  assert.equal((await link("javascript:void(0)")).kind, "deny");
  assert.equal((await link("https://shop.example.com/pricing")).kind, "defer");
  assert.equal((await link(`${PAGE}#details`)).kind, "defer", "an anchor on this page");
  for (const bad of [{ x: -1, y: 5 }, { x: 5, y: 800 }, { x: 1280, y: 5 }, { x: Number.NaN, y: 5 }, { x: "10", y: 5 }, {}, { ...click, button: "right" }, { ...click, button: "middle" }, { ...click, clickCount: 3 }, { ...click, delay: 5000 }]) {
    const g = guard("click", at());
    assert.equal((await g.decide(`${B}mouse_click_xy`, bad as never)).kind, "deny", JSON.stringify(bad));
  }
  assert.equal((await guard("click", at()).decide(`${B}mouse_click_xy`, { ...click, button: "left", clickCount: 2 })).kind, "defer");
  assert.equal((await guard("click").decide(`${B}mouse_click_xy`, click)).kind, "deny", "no lookup, no click");
  // the commit cap applies to a point click like to a ref click
  const capped = guard("click", at({ name: "Pay" }), { maxCommits: 0 });
  const d = await capped.decide(`${B}mouse_click_xy`, click);
  assert.equal(d.kind, "deny");
  assert.match(d.reason!, /confirmed step/);
  // and a run cannot click points forever
  const many = guard("click", at(), { maxCommits: 1 });
  let last = "";
  for (let i = 0; i <= MAX_POINT_CLICKS + 1 && last !== "deny"; i++) last = (await many.decide(`${B}mouse_click_xy`, click)).kind;
  assert.equal(last, "deny");
});

test("point tools: hover and wheel are reads with limits; press, release and drag are never allowed; typing stays by ref", async () => {
  const g = guard("click", at());
  assert.equal((await g.decide(`${B}mouse_move_xy`, { x: 5, y: 5 })).kind, "defer");
  assert.equal((await g.decide(`${B}mouse_move_xy`, { x: 5000, y: 5 })).kind, "deny");
  assert.equal((await g.decide(`${B}mouse_wheel`, { deltaX: 0, deltaY: 400 })).kind, "defer");
  assert.equal((await g.decide(`${B}mouse_wheel`, { deltaX: 0, deltaY: 1e9 })).kind, "deny");
  for (const t of ["mouse_down", "mouse_up", "mouse_drag_xy", "evaluate", "run_code_unsafe", "drop"]) assert.equal((await g.decide(B + t, { startX: 1, startY: 1, endX: 2, endY: 2 })).kind, "deny", t);
  assert.equal((await g.decide(`${B}type`, { target: "100,200", text: "x" })).kind, "deny", "a point is not a ref");
  assert.equal((await g.decide(`${B}click`, { target: "xy:100,200" })).kind, "deny");
});

test("validPoint and clickProblem", () => {
  assert.deepEqual(validPoint(0, 0), { x: 0, y: 0 });
  assert.deepEqual(validPoint(1279.5, 799), { x: 1279.5, y: 799 });
  assert.equal(typeof validPoint(1280, 0), "string");
  assert.equal(clickProblem({}), undefined);
  assert.equal(clickProblem({ button: "left", clickCount: 1, delay: 100 }), undefined);
  assert.ok(clickProblem({ button: "right" }));
});

// ---- the lookup itself, against a scripted browser ----

function fakeCdp(script: Record<string, unknown>, calls: string[] = []): Cdp {
  return {
    send: async (method, params) => {
      calls.push(method);
      const r = script[method];
      if (r instanceof Error) throw r;
      return (typeof r === "function" ? (r as (p: unknown) => object)(params) : r ?? {}) as Record<string, any>;
    },
  };
}
const ax = (nodes: object[]) => ({ nodes });
const world = { "Page.createIsolatedWorld": { executionContextId: 7 }, "DOM.resolveNode": { object: { objectId: "o1" } } };
const described = (o: object) => ({ "Runtime.callFunctionOn": { result: { value: { tag: "span", type: "", hints: "", href: "", inForm: false, formName: "", ...o } } } });

test("describePoint: a text node inside a button is that button, with its form, and the hit test is the browser's", async () => {
  const calls: string[] = [];
  const cdp = fakeCdp(
    {
      "DOM.getNodeForLocation": { backendNodeId: 22, frameId: "F" },
      "Accessibility.getPartialAXTree": ax([
        { nodeId: "a", parentId: "b", backendDOMNodeId: 22, role: { value: "StaticText" }, name: { value: "Book now" } },
        { nodeId: "b", parentId: "c", backendDOMNodeId: 21, role: { value: "button" }, name: { value: "Book now" } },
        { nodeId: "c", backendDOMNodeId: 5, role: { value: "RootWebArea" }, name: { value: "Shop" } },
      ]),
      ...world,
      ...described({ tag: "span", inForm: true, formName: "Booking" }),
    },
    calls,
  );
  const p = (await describePoint(cdp, 10.4, 20.6, PAGE)) as PointInfo;
  assert.equal(p.role, "button");
  assert.equal(p.name, "Book now");
  assert.equal(p.inForm, true);
  assert.equal(p.formName, "Booking");
  assert.equal(p.pageUrl, PAGE);
  assert.ok(calls.includes("DOM.getNodeForLocation") && calls.includes("Page.createIsolatedWorld"));
  assert.ok(!calls.includes("Runtime.evaluate"), "nothing is run in the page's own world");
});

test("describePoint: links, password fields, canvases and frames are described as they are; failures are strings", async () => {
  const hit = { "DOM.getNodeForLocation": { backendNodeId: 9, frameId: "F" } };
  const one = (role: string, name: string) => ({ "Accessibility.getPartialAXTree": ax([{ nodeId: "n", backendDOMNodeId: 9, role: { value: role }, name: { value: name } }]) });
  const link = (await describePoint(fakeCdp({ ...hit, ...one("link", "Admin"), ...world, ...described({ tag: "a", href: "http://192.168.1.1/admin" }) }), 1, 1, PAGE)) as PointInfo;
  assert.equal(link.href, "http://192.168.1.1/admin");
  const pw = (await describePoint(fakeCdp({ ...hit, ...one("textbox", "Secret"), ...world, ...described({ tag: "input", type: "password", hints: "pw password" }) }), 1, 1, PAGE)) as PointInfo;
  assert.equal(pw.password, true);
  const canvas = (await describePoint(fakeCdp({ ...hit, ...one("generic", ""), ...world, ...described({ tag: "canvas" }) }), 1, 1, PAGE)) as PointInfo;
  assert.equal(canvas.opaque, undefined, "a canvas is a plain surface");
  assert.equal(canvas.name, "(canvas)");
  const frame = (await describePoint(fakeCdp({ ...hit, ...one("generic", ""), ...world, ...described({ tag: "iframe" }) }), 1, 1, PAGE)) as PointInfo;
  assert.match(frame.opaque ?? "", /frame/);
  assert.equal(((await describePoint(fakeCdp({ "DOM.getNodeForLocation": {} }), 1, 1, PAGE)) as PointInfo).nothing, true, "no element: an empty area");
  assert.equal(((await describePoint(fakeCdp({ "DOM.getNodeForLocation": new Error("No node found for given location") }), 1, 1, PAGE)) as PointInfo).nothing, true, "the browser's own no node answer");
  assert.match((await describePoint(fakeCdp({ "DOM.getNodeForLocation": new Error("getNodeForLocation timed out") }), 1, 1, PAGE)) as string, /lookup failed/, "a timeout is a failed lookup");
  assert.match((await describePoint(fakeCdp({ "DOM.getNodeForLocation": new Error("Target closed") }), 1, 1, PAGE)) as string, /lookup failed/);
  assert.equal(typeof (await describePoint(fakeCdp({ "DOM.getNodeForLocation": new Error("gone") }), 1, 1, PAGE)), "string", "a protocol error");
  assert.equal(typeof (await describePoint(fakeCdp({ ...hit, ...one("button", "x"), ...world, "Runtime.callFunctionOn": { result: {} } }), 1, 1, PAGE)), "string", "the element could not be described");
  assert.equal(((await describePoint(fakeCdp({ ...hit, ...one("generic", ""), ...world, "Runtime.callFunctionOn": { result: { value: null } } }), 1, 1, PAGE)) as PointInfo).nothing, true, "the document itself is the page background");
});

test("the connection: with several tabs the worker's own is picked, else no answer; a port that answers nothing means no answer", async () => {
  const serve = (body: unknown) =>
    new Promise<{ port: number; close: () => void }>((res) => {
      const s = createServer((_q, r) => r.end(JSON.stringify(body))).listen(0, "127.0.0.1", () => res({ port: (s.address() as { port: number }).port, close: () => s.close() }));
    });
  const two = await serve([{ type: "page", url: "https://a.example/", webSocketDebuggerUrl: "ws://127.0.0.1:1/x" }, { type: "page", url: "https://b.example/", webSocketDebuggerUrl: "ws://127.0.0.1:1/y" }]);
  assert.match((await openSession(two.port, 1000)) as string, /2 tabs/);
  two.close();
  const tab = (url: string) => ({ type: "page", url, webSocketDebuggerUrl: "ws://x/" + url });
  assert.equal((pickPage([tab("https://a.example/"), tab("https://b.example/")], "https://b.example/") as { url: string }).url, "https://b.example/", "two tabs: the one the worker sees");
  assert.equal((pickPage([tab("https://a.example/"), tab("https://b.example/#x")], "https://b.example/") as { url: string }).url, "https://b.example/#x", "a fragment does not matter");
  assert.match(pickPage([tab("https://a.example/"), tab("https://b.example/")], "https://c.example/") as string, /2 tabs/, "no tab matches");
  assert.match(pickPage([tab("https://a.example/"), tab("https://a.example/")], "https://a.example/") as string, /2 tabs/, "two tabs on one address cannot be told apart");
  const none = await serve([{ type: "service_worker", url: "x" }]);
  assert.match((await openSession(none.port, 1000)) as string, /no page/);
  none.close();
  const port = await freePort();
  assert.equal(typeof (await openSession(port, 500)), "string");
});
