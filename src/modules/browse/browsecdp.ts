import { createServer } from "node:net";
import type { FrameInfo } from "./paymentrules.ts";
import { LIMITS } from "../../core/sanitize.ts";

// What is under a point of the page: a lookup owned by CODE, never by the model (clicking at a point, browsevision.ts).
// The browser is asked over its own debugging port (loopback, a random port, only while a click-mode run lives; browseserver.ts). The
// answer comes from the browser's hit test (DOM.getNodeForLocation: the same test a real click goes through, so an overlay on top counts),
// the browser's own accessible role and name (the accessibility tree) and a fixed function run in an ISOLATED world (a hostile page cannot
// patch the functions it uses). The page's own scripts are never asked anything.

export interface PointInfo {
  pageUrl: string; // the page address the lookup was made on
  role: string; // the nearest interactive role from the point upwards, else "generic"
  name: string; // its accessible name, else the text at the point
  tag: string;
  href: string; // a link around the point (it is followed by a click), else ""
  inForm: boolean;
  formName: string;
  hints: string; // name, id, autocomplete, type, placeholder, label of the element at the point: what kind of field it is
  password: boolean; // an input of type password
  opaque?: string; // what the point is, when code cannot read what a click there does (an embedded frame, object, embed)
  nothing?: boolean; // the hit test found no element at the point (empty area): a click there reaches nothing that can submit
}

// `pageUrl`: the address of the page the worker sees (the tab the browser server has selected), which picks the tab when several are open.
export type Probe = (x: number, y: number, pageUrl?: string) => Promise<PointInfo | string>; // a string: why the point could not be resolved

export interface Cdp {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>; // rejects on a protocol error
}

const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "slider", "spinbutton", "listbox", "treeitem", "DisclosureTriangle", "PopUpButton", "ComboBoxSelect", "TextField"]);
const OPAQUE = new Set(["iframe", "frame", "embed", "object"]); // a canvas, svg or video with no interactive ancestor is a plain surface: a click cannot submit anything
const SURFACE = new Set(["canvas", "svg", "video", "audio"]);
const NO_NODE = /no node found|no element/i; // the browser's own answer for an empty point: not a failed lookup

// Fixed. Runs in an isolated world on the element under the point (`this`).
const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const a = el.closest("a[href]");
  const f = el.closest("form");
  const at = (n) => el.getAttribute(n) || "";
  return {
    tag: el.tagName.toLowerCase(),
    type: at("type").toLowerCase(),
    hints: [at("name"), el.id, at("autocomplete"), at("type"), at("placeholder"), at("aria-label")].filter(Boolean).join(" "),
    href: a ? a.href : "",
    inForm: !!f,
    formName: f ? (f.getAttribute("aria-label") || f.getAttribute("name") || f.id || "") : "",
  };
}`;

interface AxNode { nodeId: string; parentId?: string; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }; ignored?: boolean }

const nothingAt = (pageUrl: string): PointInfo => ({ pageUrl, role: "generic", name: "(empty area)", tag: "none", href: "", inForm: false, formName: "", hints: "", password: false, nothing: true });

// Resolve the point on an open session. Pure apart from the calls on `cdp`.
export async function describePoint(cdp: Cdp, x: number, y: number, pageUrl: string): Promise<PointInfo | string> {
  try {
    await cdp.send("DOM.enable");
    await cdp.send("DOM.getDocument", { depth: 0 });
    const hit = await cdp.send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
    const backendNodeId = hit.backendNodeId as number | undefined;
    if (typeof backendNodeId !== "number") return nothingAt(pageUrl);

    const ax = ((await cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: true })).nodes ?? []) as AxNode[];
    const self = ax.find((n) => n.backendDOMNodeId === backendNodeId);
    const byId = new Map(ax.map((n) => [n.nodeId, n]));
    const chain: AxNode[] = [];
    for (let n = self, i = 0; n && i < 40; n = n.parentId ? byId.get(n.parentId) : undefined, i++) chain.push(n);
    const interactive = chain.find((n) => INTERACTIVE.has(n.role?.value ?? ""));
    const text = self ? ax.filter((n) => n.parentId === self.nodeId && n.role?.value === "StaticText").map((n) => n.name?.value ?? "").join(" ").trim() : "";
    const role = interactive?.role?.value ?? "generic";
    let name = (interactive?.name?.value ?? text ?? "").trim();

    const world = await cdp.send("Page.createIsolatedWorld", { frameId: hit.frameId, worldName: "ted-guard" });
    const node = await cdp.send("DOM.resolveNode", { backendNodeId, executionContextId: world.executionContextId });
    const ran = await cdp.send("Runtime.callFunctionOn", { objectId: node.object?.objectId, functionDeclaration: DESCRIBE, returnByValue: true });
    const d = ran.result?.value as { tag: string; type: string; hints: string; href: string; inForm: boolean; formName: string } | null | undefined;
    if (d === null) return nothingAt(pageUrl); // the hit is the document itself (no element around it): the page's background
    if (!d || typeof d.tag !== "string") return "the element at that point could not be described";
    if (!name && SURFACE.has(d.tag)) name = `(${d.tag})`;

    return {
      pageUrl,
      role,
      name,
      tag: d.tag,
      href: d.href,
      inForm: d.inForm,
      formName: d.formName,
      hints: d.hints,
      password: d.type === "password",
      ...(OPAQUE.has(d.tag) ? { opaque: d.tag === "iframe" || d.tag === "frame" ? "an embedded frame (payment and login widgets live in one)" : `an embedded ${d.tag}` } : {}),
    };
  } catch (e) {
    // "No node found for given location": the point is on nothing. A timeout, a closed target or any other error is a failed lookup.
    if (NO_NODE.test(String((e as Error)?.message ?? e))) return nothingAt(pageUrl);
    return `the lookup failed (${String((e as Error)?.message ?? e).slice(0, LIMITS.reason)})`;
  }
}

// ---- the connection (the only part that talks to a real browser) ----

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), ms)))]).finally(() => clearTimeout(t));
};

// Which of the browser's tabs the worker sees: one page is that one; with several, the one at `pageUrl`. Else why not.
export function pickPage<T extends { type: string; url: string; webSocketDebuggerUrl?: string }>(list: T[], pageUrl?: string): T | string {
  const all = list.filter((t) => t.type === "page");
  const bare = (u: string) => u.split("#")[0];
  const same = pageUrl ? all.filter((t) => t.url === pageUrl) : [];
  const pages = all.length <= 1 ? all : same.length ? same : pageUrl ? all.filter((t) => bare(t.url) === bare(pageUrl)) : all;
  if (pages.length !== 1 || !pages[0]!.webSocketDebuggerUrl) return all.length === 0 ? "no page is open" : `${all.length} tabs are open, so which one is shown is not certain`;
  return pages[0]!;
}

// A session on the page the worker sees. One page: that one. Several: the one whose address is `pageUrl` (the address the browser server shows
// for its selected tab: its tab list marks the selected one "(current)" and every page view is of that tab). Two tabs on the very same
// address, or none matching, cannot be told apart: no answer.
export async function openSession(port: number, timeoutMs = 4000, pageUrl?: string): Promise<{ cdp: Cdp; pageUrl: string; close: () => void } | string> {
  try {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })).json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
    const pick = pickPage(list, pageUrl);
    if (typeof pick === "string") return pick;
    const ws = new WebSocket(pick.webSocketDebuggerUrl!);
    await withTimeout(new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("connection failed"))))), timeoutMs, "connect");
    let id = 0;
    const pending = new Map<number, { res: (v: Record<string, any>) => void; rej: (e: Error) => void }>();
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, any>; error?: { message?: string } };
      const p = m.id !== undefined ? pending.get(m.id) : undefined;
      if (!p || m.id === undefined) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message ?? "protocol error"));
      else p.res(m.result ?? {});
    };
    const send: Cdp["send"] = (method, params = {}) => withTimeout(new Promise((res, rej) => (pending.set(++id, { res, rej }), ws.send(JSON.stringify({ id, method, params })))), timeoutMs, method);
    return { cdp: { send }, pageUrl: pick.url, close: () => ws.close() };
  } catch (e) {
    return `the browser could not be reached (${String((e as Error)?.message ?? e).slice(0, LIMITS.reason)})`;
  }
}

// A free loopback port for the browser's debugging port (picked just before the browser starts).
export const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

export const cdpProbe = (port: number): Probe => async (x, y, pageUrl) => {
  const s = await openSession(port, 4000, pageUrl);
  if (typeof s === "string") return s;
  try {
    return await describePoint(s.cdp, x, y, s.pageUrl);
  } finally {
    s.close();
  }
};

// ---- the frames of the page (a card payment: paymentrules.ts frameVerdict) ----

// The browser's own frame tree of the page the worker sees, main page first, then every frame under it (hidden ones too: a frame that is not in
// the page view is still a frame). The address of a frame comes from the browser, not from the page.
export type FrameProbe = (pageUrl: string) => Promise<FrameInfo[] | string>; // a string: why the frames could not be listed

interface FrameTree { frame?: { url?: string }; childFrames?: FrameTree[] }
function flattenFrames(tree: FrameTree | undefined, depth = 0): FrameInfo[] {
  if (!tree?.frame || depth > 8) return [];
  return [{ url: String(tree.frame.url ?? "") }, ...(tree.childFrames ?? []).flatMap((c) => flattenFrames(c, depth + 1))];
}

export const cdpFrames = (port: number): FrameProbe => async (pageUrl) => {
  const s = await openSession(port, 4000, pageUrl);
  if (typeof s === "string") return s;
  try {
    const frames = flattenFrames((await s.cdp.send("Page.getFrameTree")).frameTree as FrameTree | undefined);
    return frames.length ? frames : "the browser returned no frames";
  } catch (e) {
    return `the frames could not be listed (${String((e as Error)?.message ?? e).slice(0, LIMITS.reason)})`;
  } finally {
    s.close();
  }
};
