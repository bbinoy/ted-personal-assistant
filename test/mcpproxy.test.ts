import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// The credentialed proxy (src/intake/mcpproxy.ts) on its own, with a fake upstream per person: the credential belongs to the session that opened the connection and goes to
// that upstream only, it is in no result, error or log line the run or the console sees, sessions of two people are never shared, an idle one is closed and opened again on demand.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "mcpproxy-test-"));
const { UpstreamSession, SessionHub, UpstreamError, credentialedProxy } = await import("../src/intake/mcpproxy.ts");

type Opened = import("../src/intake/mcpproxy.ts").Opened;

const printed: string[] = [];
const realLog = console.log, realErr = console.error, realWarn = console.warn;
console.log = console.error = console.warn = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
import { after } from "node:test";
after(() => Object.assign(console, { log: realLog, error: realErr, warn: realWarn }));

const tokenOf = (id: string) => `FAKE-BEARER-${id}-not-a-real-token`;

// One upstream per person: remembers which credential every call came with, and which person's server it is.
interface Upstream {
  owner: string;
  calls: { tool: string; args: unknown; credential: string }[];
  closed: number;
  mode: "ok" | "fail-open" | "fail-call" | "slow";
}
const upstreams = new Map<string, Upstream>();
const upstreamOf = (id: string): Upstream => upstreams.get(id) ?? (upstreams.set(id, { owner: id, calls: [], closed: 0, mode: "ok" }), upstreams.get(id)!);

class FakeSession extends UpstreamSession {
  protected readonly label = "her fake service";
  idleMs: number;
  callMs: number;
  constructor(id: string, idleMs = 60_000, callMs = 2000) {
    super(id);
    this.idleMs = idleMs;
    this.callMs = callMs;
  }
  protected limits() {
    return { idleMs: this.idleMs, callMs: this.callMs };
  }
  protected async open(): Promise<Opened> {
    const up = upstreamOf(this.tenantId);
    const credential = tokenOf(this.tenantId); // read at open time, held here; the run never sees it
    // a failure whose own message carries the credential, as a careless library might
    if (up.mode === "fail-open") throw new Error(`connect failed with Authorization: Bearer ${credential}`);
    const server = new Server({ name: "fake-upstream", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "search", description: "x".repeat(5000), inputSchema: { type: "object" } }, { name: "danger", inputSchema: { type: "object" } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      up.calls.push({ tool: req.params.name, args: req.params.arguments, credential });
      if (up.mode === "fail-call") throw new Error(`upstream blew up for ${credential}`);
      if (up.mode === "slow") await new Promise((r) => setTimeout(r, 400));
      return { content: [{ type: "text" as const, text: `answer for ${up.owner}` }] };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    return { transport: b, cleanup: () => void up.closed++ };
  }
}

async function runClient(session: () => InstanceType<typeof UpstreamSession>, allowed: (t: string) => boolean = (t) => t === "search", extra: Partial<Parameters<typeof credentialedProxy>[0]> = {}) {
  const cfg = credentialedProxy({ name: "fake", session, allowed, unavailable: (e) => (e instanceof UpstreamError ? `Not available: ${e.message}.` : "Not available."), ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(a as never);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return { cfg, client, call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean } };
}

test("the run's server is in-process: no command, environment or header can carry the credential; tools beyond the allowed set are hidden and never forwarded; descriptions are bounded", async () => {
  const s = new FakeSession("ann");
  try {
    const { cfg, client, call } = await runClient(() => s);
    assert.equal(cfg.type, "sdk");
    assert.ok(!JSON.stringify(Object.keys(cfg)).match(/command|args|env|headers|url/i));
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name), ["search"]);
    assert.equal(tools[0]!.description!.length, 1500);
    const refused = await call("danger");
    assert.equal(refused.isError, true);
    assert.equal(upstreamOf("ann").calls.filter((c) => c.tool === "danger").length, 0, "never reached the upstream");
    assert.match((await call("search", { q: "plans" })).content[0]!.text, /answer for ann/);
    assert.equal(upstreamOf("ann").calls.at(-1)!.credential, tokenOf("ann"));
  } finally {
    s.close();
  }
});

test("a service that names an account in every call gets HER account, whatever the model wrote", async () => {
  const s = new FakeSession("bo");
  try {
    const { call } = await runClient(() => s, undefined, { arguments: async (a) => ({ ...a, account: "bo@example.test" }) });
    await call("search", { q: "x", account: "owner@example.test" });
    assert.deepEqual(upstreamOf("bo").calls.at(-1)!.args, { q: "x", account: "bo@example.test" });
  } finally {
    s.close();
  }
});

test("two people never share a session or a credential: each call reaches her own upstream with her own token, and dropping one leaves the other running", async () => {
  const hub = new SessionHub((id) => new FakeSession(id));
  try {
    const ann = await runClient(() => hub.session("hub-ann"));
    const bo = await runClient(() => hub.session("hub-bo"));
    assert.notEqual(hub.session("hub-ann"), hub.session("hub-bo"));
    assert.equal(hub.session("hub-ann"), hub.session("hub-ann"));
    await ann.call("search");
    await bo.call("search");
    await bo.call("search");
    assert.deepEqual(upstreamOf("hub-ann").calls.map((c) => c.credential), [tokenOf("hub-ann")]);
    assert.deepEqual(upstreamOf("hub-bo").calls.map((c) => c.credential), [tokenOf("hub-bo"), tokenOf("hub-bo")]);
    assert.deepEqual([...hub.open].sort(), ["hub-ann", "hub-bo"]);
    // a model cannot name the other person: the tenant is the proxy's, not an argument
    await ann.call("search", { tenant: "hub-bo", tenantId: "hub-bo" });
    assert.equal(upstreamOf("hub-bo").calls.length, 2);
    hub.drop("hub-ann");
    assert.deepEqual(hub.open, ["hub-bo"]);
    assert.equal(upstreamOf("hub-ann").closed, 1, "her connection's cleanup ran");
    assert.match((await bo.call("search")).content[0]!.text, /answer for hub-bo/);
    hub.closeAll();
    assert.deepEqual(hub.open, []);
  } finally {
    hub.closeAll();
  }
});

test("an idle session is closed (cleanup runs) and opened again on the next call; concurrent first calls open one connection", async () => {
  const s = new FakeSession("cy", 40);
  const up = upstreamOf("cy");
  try {
    const { call } = await runClient(() => s);
    await Promise.all([call("search"), call("search"), call("search")]);
    assert.equal(s.starts, 1, "three callers at once, one connection");
    assert.equal(s.running, true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(s.running, false, "closed after the idle time");
    assert.equal(up.closed, 1);
    assert.match((await call("search")).content[0]!.text, /answer for cy/);
    assert.equal(s.starts, 2, "and opened again on demand");
    assert.equal(up.calls.at(-1)!.credential, tokenOf("cy"));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(up.closed, 2);
  } finally {
    s.close();
  }
});

test("a failure says a fixed sentence: the credential a library put in its own message reaches no result, log line or error the run reads", async () => {
  const secret = tokenOf("di");
  // the connection cannot be opened
  upstreamOf("di").mode = "fail-open";
  const s = new FakeSession("di");
  try {
    const { call, client } = await runClient(() => s);
    const r = await call("search");
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "Not available: her fake service did not start.");
    await assert.rejects(client.listTools(), (e: Error) => !e.message.includes(secret));
    // the connection opens but the call fails: the connection is dropped and opened again next time
    upstreamOf("di").mode = "fail-call";
    const r2 = await call("search");
    assert.equal(r2.content[0]!.text, "Not available: her fake service did not answer.");
    assert.equal(s.running, false);
    upstreamOf("di").mode = "ok";
    assert.match((await call("search")).content[0]!.text, /answer for di/);
    // too slow: said so, and the connection stays
    upstreamOf("di").mode = "slow";
    s.callMs = 50;
    const slow = await call("search");
    assert.equal(slow.content[0]!.text, "Not available: her fake service took too long.");
    assert.equal(s.running, true);
  } finally {
    s.close();
  }
  assert.ok(!printed.join("\n").includes("FAKE-BEARER"), "no console line holds a credential");
});
