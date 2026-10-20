import { test, after } from "node:test";
import assert from "node:assert/strict";
import { scopeOf } from "../src/turnscope.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A friend's Google tools (src/googlemcp.ts, src/modules/google.ts) against a fake stdio server (test/fakegoogle.ts): one process per friend with her own token,
// the token only in a private folder and that process (never an argument, never the model's environment), the tools her capability set allows and no others,
// and the same floor, judge and approval path as the owner's mail and calendar, asked in HER chat.
const dir = mkdtempSync(join(tmpdir(), "google-"));
process.env.HARNESS_DATA_DIR = dir;
process.env.GOOGLE_OAUTH_CLIENT_ID = "fake-client-id.example";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "fake-client-secret-not-real";

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants.ts");
const { GoogleHub, GoogleSession, googleProxy, credentialFile, sweepStaleCredentialDirs, TMP_PREFIX } = await import("../src/googlemcp.ts");
const { serversFor, LIFECYCLE, stopAll, dropAll } = await import("../src/modules/runtime.ts");
const { tenantCapabilities, tenantTools } = await import("../src/capabilities.ts");
const { makeCanUseTool } = await import("../src/permissions.ts");
const { classify } = await import("../src/policy.ts");
const { allows } = await import("../src/conversationmodel.ts");
const { GOOGLE_PREFIX } = await import("../src/modules/google.ts");

const FAKE = new URL("./fakegoogle.ts", import.meta.url).pathname;
const LOG = join(dir, "google.log");
const STATE = join(dir, "mailboxes.json");
const TOKENS: Record<string, string> = { anna: "fake-refresh-token-anna-0001", bea: "fake-refresh-token-bea-0002" };
const MAIL: Record<string, string> = { anna: "anna@example.com", bea: "bea@example.com" };
const msg = (id: string, from: string, subject: string, body: string) => ({ id, from, subject, date: "Tue, 20 Oct 2026 08:00:00 +0000", body, labels: ["INBOX"] });
writeFileSync(STATE, JSON.stringify({ "anna@example.com": { messages: [msg("a1", "Carl <carl@example.org>", "Lunch?", "Are you free Thursday?")] }, "bea@example.com": { messages: [msg("b1", "Dora <dora@example.org>", "Invoice", "Bea's private invoice 4711")] } }));

const TMP = mkdtempSync(join(dir, "tmp-")); // her credentials folders go here, never into the shared temp folder (another test file may be running at the same time)
const hub = () => new GoogleHub((id) => new GoogleSession(id, () => ({ command: process.execPath, args: [FAKE], clientId: settings.google.clientId, clientSecret: settings.google.clientSecret, tokenUrl: "https://token.invalid/token", scopes: ["s"], idleMs: 60_000, callMs: 20_000, tmpRoot: TMP, env: { FAKE_GOOGLE_LOG: LOG, FAKE_GOOGLE_STATE: STATE } }), async (t) => (TOKENS[t] ? { refreshToken: TOKENS[t]!, email: MAIL[t]! } : undefined)));
const calls = (): Record<string, any>[] => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const probe = async (h: InstanceType<typeof GoogleHub>, id: string) => JSON.parse((await h.session(id).call("_probe", {})).text);

after(() => {
  /* the sessions of each test are closed by the test */
});

test("google: one server process per friend, each with her own token and address; the child's environment holds nothing of the instance", async () => {
  const h = hub();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token";
  process.env.ANTHROPIC_API_KEY = "instance-key-not-real";
  try {
    const a = await probe(h, "anna");
    const b = await probe(h, "bea");
    assert.notEqual(a.pid, b.pid, "two friends, two processes");
    assert.equal(a.refresh, TOKENS.anna);
    assert.equal(b.refresh, TOKENS.bea);
    assert.equal(a.email, "anna@example.com");
    assert.equal(b.email, "bea@example.com");
    assert.equal(a.single, "1");
    assert.deepEqual(a.hasOpenAi, [], "no Anthropic, Claude or tenant variable reaches her server");
    // The same session is reused: one process for all her calls.
    assert.equal((await probe(h, "anna")).pid, a.pid);
    assert.equal(h.session("anna").starts, 1);
    // Her mail is hers alone.
    const mailA = (await h.session("anna").call("search_gmail_messages", { query: "in:inbox" })).text;
    const mailB = (await h.session("bea").call("search_gmail_messages", { query: "in:inbox" })).text;
    assert.match(mailA, /Lunch\?/);
    assert.doesNotMatch(mailA, /Invoice/);
    assert.match(mailB, /Invoice/);
    assert.doesNotMatch(mailB, /Lunch/);
  } finally {
    h.closeAll();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("google: the token is in a private folder only while her server runs; it is on no command line and the folder is gone after", async () => {
  const root = mkdtempSync(join(TMP, "own-")); // this test's own temp root: nothing else can create or remove a folder in it
  const h = new GoogleHub((id) => new GoogleSession(id, () => ({ command: process.execPath, args: [FAKE], clientId: settings.google.clientId, clientSecret: settings.google.clientSecret, tokenUrl: "https://token.invalid/token", scopes: ["s"], idleMs: 60_000, callMs: 20_000, tmpRoot: root, env: { FAKE_GOOGLE_LOG: LOG, FAKE_GOOGLE_STATE: STATE } }), async (t) => ({ refreshToken: TOKENS[t]!, email: MAIL[t]! })));
  const s = h.session("anna");
  try {
    await probe(h, "anna");
    const folders = readdirSync(root).filter((n) => n.startsWith(TMP_PREFIX));
    assert.equal(folders.length, 1, "her credentials are in one temp folder named for the server");
    const folder = join(root, folders[0]!);
    assert.equal(statSync(folder).mode & 0o077, 0, "owner-only folder");
    assert.equal(statSync(join(folder, credentialFile("anna@example.com"))).mode & 0o077, 0, "owner-only file");
    const creds = JSON.parse(readFileSync(join(folder, credentialFile("anna@example.com")), "utf8"));
    assert.equal(creds.refresh_token, TOKENS.anna);
    assert.equal(creds.client_id, settings.google.clientId);
    // The server is started with the folder in its environment, not the token: nothing the transport is given as an argument holds it.
    assert.ok(!JSON.stringify([process.execPath, FAKE]).includes(TOKENS.anna!));
    s.close();
    assert.equal(existsSync(folder), false, "deleted when the process stops");
    // And it starts again on demand.
    assert.equal((await probe(h, "anna")).refresh, TOKENS.anna);
    assert.equal(s.starts, 2);
  } finally {
    h.closeAll();
  }
  assert.deepEqual(readdirSync(root), [], "closeAll leaves no folder");
});

test("google: the start-up sweep removes only stale folders this app made (prefix, real directory, ours, 0700, old enough) and leaves everything else", () => {
  const root = mkdtempSync(join(TMP, "sweep-"));
  const old = Date.now() / 1000 - 3600;
  const make = (name: string, mode = 0o700, age = old) => {
    const p = join(root, name);
    mkdirSync(p, { mode });
    chmodSync(p, mode);
    writeFileSync(join(p, "x.json"), "{}");
    utimesSync(p, age, age);
    return p;
  };
  const stale = make(`${TMP_PREFIX}stale1`);
  const stale2 = make(`${TMP_PREFIX}stale2`);
  const fresh = make(`${TMP_PREFIX}fresh`, 0o700, Date.now() / 1000 - 30);
  const loose = make(`${TMP_PREFIX}loose`, 0o755);
  const other = make("someone-elses");
  const target = make("target-of-link");
  symlinkSync(target, join(root, `${TMP_PREFIX}link`));
  writeFileSync(join(root, `${TMP_PREFIX}file`), "x");
  assert.equal(sweepStaleCredentialDirs(root), 2);
  assert.equal(existsSync(stale) || existsSync(stale2), false);
  for (const kept of [fresh, loose, other, target, join(root, `${TMP_PREFIX}link`), join(root, `${TMP_PREFIX}file`)]) assert.equal(existsSync(kept), true, kept);
  assert.equal(sweepStaleCredentialDirs(join(root, "missing")), 0, "a missing temp root is nothing to do");
});

test("google: the module lifecycle: Google and Notion have stop and drop, and stop and drop of idle hubs are harmless", () => {
  assert.deepEqual(Object.keys(LIFECYCLE).sort(), ["google", "notion"]);
  assert.equal(typeof LIFECYCLE.google!.start, "function", "google sweeps at start-up");
  dropAll("nobody");
  stopAll();
  stopAll(); // twice is fine
});

test("google: the proxy fails closed: without her address the call is not forwarded at all, whatever account the model named", async () => {
  class Unknown extends GoogleSession {
    override get address(): string | undefined {
      return undefined;
    }
  }
  const root = mkdtempSync(join(TMP, "closed-"));
  const h = new GoogleHub((id) => new Unknown(id, () => ({ command: process.execPath, args: [FAKE], clientId: settings.google.clientId, clientSecret: settings.google.clientSecret, tokenUrl: "https://token.invalid/token", scopes: ["s"], idleMs: 60_000, callMs: 20_000, tmpRoot: root, env: { FAKE_GOOGLE_LOG: LOG, FAKE_GOOGLE_STATE: STATE } }), async (t) => ({ refreshToken: TOKENS[t]!, email: MAIL[t]! })));
  try {
    const cfg = googleProxy("anna", () => true, h);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await cfg.instance.connect(a as never);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const before = calls().length;
    const res = (await client.callTool({ name: "search_gmail_messages", arguments: { query: "in:inbox", user_google_email: "bea@example.com" } })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /not available/);
    assert.equal(calls().length, before, "nothing reached her server");
  } finally {
    h.closeAll();
  }
});

test("google: a friend who has not connected, or an instance without an OAuth client, gets a plain refusal, not a process", async () => {
  const h = hub();
  await assert.rejects(h.session("cleo").call("list_calendars", {}), /has not connected Google/);
  const none = new GoogleSession("anna", () => ({ command: process.execPath, args: [FAKE], clientId: undefined, clientSecret: undefined, tokenUrl: "", scopes: [], idleMs: 1000, callMs: 1000 }), async () => ({ refreshToken: "x", email: "a@b.c" }));
  await assert.rejects(none.call("list_calendars", {}), /not set up on this instance/);
});

// ---- the run's side: what a friend's capability set serves ----

let n = 0;
function friend(caps: (typeof T.CAPABILITIES)[number][]): ReturnType<typeof T.tenantContext> {
  const rec = T.redeemInvite(T.mintInvite("t")!.code, { aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name: "Friend" })!;
  T.provision(rec);
  T.recordConsent(T.tenantContext(rec), "Germany");
  for (const c of caps) T.grant(rec.id, c);
  return T.tenantContext(T.tenantById(rec.id)!);
}
const runCtx = (ctx: ReturnType<typeof T.tenantContext>) => {
  const tools = tenantTools(ctx);
  return { source: "group" as const, browsing: false, key: `tenant:${ctx.id}`, mode: "group" as const, tenant: { id: ctx.id } as never, offers: (t: string) => tools.has(t), browseRun: async () => ({ text: "", costUsd: 0 }), memory: { dir: ctx.notesDir } };
};

test("google: the capability set decides: google with mail and calendar offers the tools and a server; google alone, mail alone and nothing offer none", () => {
  const both = friend(["google", "mail", "calendar"]);
  const set = tenantTools(both);
  for (const t of ["search_gmail_messages", "send_gmail_message", "draft_gmail_message", "modify_gmail_message_labels", "get_events", "manage_event"]) assert.ok(set.has(GOOGLE_PREFIX + t), t);
  for (const t of ["get_gmail_attachment_content", "manage_gmail_filter", "start_google_auth", "_probe"]) assert.ok(!set.has(GOOGLE_PREFIX + t), `${t} is not a tool of hers`);
  assert.ok(![...set].some((t) => /claude_ai|mailbird/.test(t)), "never the owner's connectors");
  assert.deepEqual(Object.keys(serversFor(runCtx(both))).filter((k) => k === "google"), ["google"]);
  assert.equal(serversFor(runCtx(both)).google!.type, "sdk", "no command line and no environment for the CLI to carry");

  const mailOnly = friend(["google", "mail"]);
  assert.ok(tenantTools(mailOnly).has(GOOGLE_PREFIX + "search_gmail_messages") && !tenantTools(mailOnly).has(GOOGLE_PREFIX + "get_events"));
  const noGoogle = friend(["mail", "calendar"]);
  assert.equal([...tenantTools(noGoogle)].filter((t) => t.startsWith(GOOGLE_PREFIX)).length, 0, "mail and calendar are her own Google or nothing");
  assert.equal(serversFor(runCtx(noGoogle)).google, undefined);
  assert.equal(allows({ kind: "tenant", tenantId: noGoogle.id }, "mail"), false);
  assert.equal(allows({ kind: "tenant", tenantId: both.id }, "mail"), true);
  const plain = friend([]);
  assert.equal(serversFor(runCtx(plain)).google, undefined);
  assert.ok(tenantCapabilities(plain).has("chat"));
  // The owner's runs never have her server, whatever the set.
  assert.equal(serversFor({ ...runCtx(both), source: "chat", tenant: undefined, key: "owner", mode: "owner", offers: () => true }).google, undefined);
});

test("google: the proxy lists only her allowed tools, forces her own address into every call, and refuses what her set does not offer", async () => {
  const h = hub();
  try {
    const ctx = friend(["google", "mail", "calendar"]);
    const offered = tenantTools(ctx);
    const cfg = googleProxy("anna", (name) => offered.has(GOOGLE_PREFIX + name), h);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await cfg.instance.connect(a as never);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const listed = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(listed.includes("send_gmail_message") && listed.includes("manage_event"));
    for (const hidden of ["_probe", "get_gmail_attachment_content", "start_google_auth", "manage_gmail_filter"]) assert.ok(!listed.includes(hidden), hidden);
    const res = (await client.callTool({ name: "search_gmail_messages", arguments: { query: "in:inbox", user_google_email: "bea@example.com" } })) as { content: { text: string }[] };
    assert.match(res.content[0]!.text, /Lunch\?/, "she asked for bea's account and got her own");
    assert.doesNotMatch(res.content[0]!.text, /Invoice/);
    const last = calls().filter((c) => c.tool === "search_gmail_messages").pop()!;
    assert.equal(last.args.user_google_email, "anna@example.com");
    const refused = (await client.callTool({ name: "_probe", arguments: {} })) as { isError?: boolean };
    assert.equal(refused.isError, true);
  } finally {
    h.closeAll();
  }
});

// ---- the same floor, judge and approvals as the owner's mail ----

const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; message?: string };
const G = GOOGLE_PREFIX;

function rig(ctx: ReturnType<typeof T.tenantContext>, verdict: "auto" | "ask" = "ask") {
  const asked: string[] = [];
  const judged: { description: string; untrustedInput?: boolean }[] = [];
  const approve = async (description: string) => (asked.push(description), { approved: true });
  const judge = (async (i: { description: string; untrustedInput?: boolean }) => (judged.push(i), { decision: verdict, reason: "t" })) as never;
  const can = makeCanUseTool(approve as never, "group", ctx.notesDir, judge, undefined, tenantTools(ctx), true, { provenance: scopeOf(`tenant:${ctx.id}`).read, conversation: `tenant:${ctx.id}` });
  return { asked, judged, run: (tool: string, input: Record<string, unknown>) => can(G + tool, input, opts) as Promise<Out> };
}

test("google: reads run free; a send, a draft and a label go to the judge and, unless it passes them, to HER chat; the floor refuses what no verdict may allow", async () => {
  const ctx = friend(["google", "mail", "calendar"]);
  scopeOf(`tenant:${ctx.id}`).say("write to Carl that Thursday works");
  // reads
  let r = rig(ctx);
  assert.equal((await r.run("search_gmail_messages", { query: "in:inbox" })).behavior, "allow");
  assert.equal(r.judged.length, 0, "a read is not judged");
  // a send: asked, with the recipients shown, in her chat (the approver is hers); the judge is told the run has read mail
  assert.equal((await r.run("get_gmail_message_content", { message_id: "a1" })).behavior, "allow");
  assert.equal((await r.run("send_gmail_message", { to: "carl@example.org", subject: "Re: Lunch?", body: "Thursday works", thread_id: "t1" })).behavior, "allow");
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0]!, /Send reply now|Send email now/);
  assert.match(r.asked[0]!, /carl@example\.org/);
  assert.equal(r.judged.at(-1)!.untrustedInput, true, "after reading mail the arguments may be steered");
  // a draft is judged (auto passes it, nobody is asked)
  r = rig(ctx, "auto");
  assert.equal((await r.run("draft_gmail_message", { to: "carl@example.org", subject: "x", body: "y" })).behavior, "allow");
  assert.equal(r.asked.length, 0);
  assert.equal(r.judged.length, 1);
  // a send nobody can be named for cannot be shown: refused, not asked
  r = rig(ctx);
  const noTo = await r.run("send_gmail_message", { subject: "x", body: "y", thread_id: "t1" });
  assert.equal(noTo.behavior, "deny");
  assert.equal(r.asked.length, 0);
  // a send that names its recipients is judged like the owner's: an auto from the judge passes it
  r = rig(ctx, "auto");
  await r.run("send_gmail_message", { to: "carl@example.org", subject: "s", body: "b" });
  assert.equal(r.asked.length, 0);
  assert.equal(r.judged.length, 1);
  // the floor
  r = rig(ctx, "auto");
  for (const [tool, input] of [
    ["send_gmail_message", { to: "x@y.z", subject: "s", body: "b", attachments: [{ path: "/etc/passwd" }] }],
    ["draft_gmail_message", { to: "x@y.z", subject: "s", body: "b", attachments: [{ url: "file:///etc/passwd" }] }],
    ["send_gmail_message", { to: "x@y.z", subject: "s", body: "b", from_email: "boss@example.com" }],
    ["modify_gmail_message_labels", { message_id: "a1", add_label_ids: ["TRASH"] }],
    ["modify_gmail_message_labels", { message_id: "a1", add_label_ids: ["spam"] }],
    ["get_gmail_message_content", { message_id: "a1", full: true }],
    ["get_gmail_message_content", { message_id: "a1", body_format: "raw" }],
    ["get_gmail_attachment_content", { message_id: "a1", attachment_id: "x" }],
    ["manage_gmail_filter", { action: "create" }],
  ] as const) assert.equal((await r.run(tool, input)).behavior, "deny", `${tool} ${JSON.stringify(input)}`);
  assert.equal(r.asked.length + r.judged.length, 0, "refused before any judge or question");
  // archive: a label change is judged like the owner's
  r = rig(ctx, "auto");
  assert.equal((await r.run("modify_gmail_message_labels", { message_id: "a1", remove_label_ids: ["INBOX"] })).behavior, "allow");
  assert.equal(r.judged.length, 1);
});

test("google: a calendar write that names guests, and every answer to an invite, always asks her, a delete is denied and is never judged; a plain one is judged", async () => {
  const ctx = friend(["google", "mail", "calendar"]);
  scopeOf(`tenant:${ctx.id}`).say("put the dentist on Wednesday");
  let r = rig(ctx, "auto");
  assert.equal((await r.run("get_events", {})).behavior, "allow");
  assert.equal((await r.run("manage_event", { action: "create", summary: "Dentist", start_time: "2026-10-21T10:00:00", end_time: "2026-10-21T11:00:00" })).behavior, "allow");
  assert.equal(r.judged.length, 1);
  assert.equal(r.asked.length, 0);
  r = rig(ctx, "auto");
  await r.run("manage_event", { action: "create", summary: "Lunch", attendees: ["carl@example.org"], start_time: "2026-10-21T12:00:00", end_time: "2026-10-21T13:00:00" });
  assert.equal(r.judged.length, 0, "guests: the judge is not asked");
  assert.equal(r.asked.length, 1, "she is");
  r = rig(ctx, "auto");
  assert.equal((await r.run("manage_event", { action: "delete", event_id: "e1" })).behavior, "deny", "a delete is never allowed, for a friend as for the owner");
  await r.run("manage_event", { action: "rsvp", event_id: "e2", response: "accepted" });
  // the real field names of the calendar schema all count as guests
  for (const guests of [{ attendeeEmails: ["a@example.org"] }, { addedAttendees: [{ email: "a@example.org" }] }, { addedAttendeeEmails: ["a@example.org"] }]) await r.run("manage_event", { action: "update", event_id: "e3", ...guests });
  assert.equal(r.judged.length, 0);
  assert.equal(r.asked.length, 4, "the answer to an invite and three updates that name guests are her call"); // (the delete was denied)
});

test("google: nothing of the owner's or of the Google tools exists for a person without the capability, and the owner's source has none of these tools", () => {
  const plain = friend([]);
  const tools = tenantTools(plain);
  assert.equal(classify(G + "send_gmail_message", { to: "a@b.c" }, "group", plain.notesDir, tools), "deny");
  assert.equal(classify(G + "search_gmail_messages", { query: "x" }, "group", plain.notesDir, tools), "deny");
  for (const source of ["chat", "background", "handler", "brief", "radar"] as const) assert.equal(classify(G + "send_gmail_message", { to: "a@b.c" }, source, undefined), "deny", source);
  const full = friend(["google", "mail", "calendar"]);
  assert.equal(classify(G + "send_gmail_message", { to: "a@b.c" }, "group", full.notesDir, tenantTools(full)), "ask");
  assert.equal(classify(G + "search_gmail_messages", { query: "x" }, "group", full.notesDir, tenantTools(full)), "allow");
  assert.equal(classify("mcp__mailbird__send_message_now", {}, "group", full.notesDir, tenantTools(full)), "deny");
  assert.equal(classify(G + "delete_gmail_message", {}, "group", full.notesDir, tenantTools(full)), "deny");
});

test("google: the default server command pins the package and the day its dependencies resolve to", async () => {
  const { loadSettings } = await import("../src/settings.ts");
  const a = loadSettings({}).google.args;
  assert.equal(a[a.indexOf("--exclude-newer") + 1], "2026-10-20T00:00:00Z");
  assert.ok(a.indexOf("--exclude-newer") < a.indexOf("workspace-mcp==2.1.0"), "an option of uvx comes before the package");
  assert.deepEqual(loadSettings({ GOOGLE_MCP_ARGS: "workspace-mcp==2.1.0 --single-user" }).google.args, ["workspace-mcp==2.1.0", "--single-user"], "an explicit value replaces the default whole");
});

test("google: her server stays up between mail ticks: the idle default is the heartbeat interval plus a margin, at least 20 minutes, and an explicit value wins", async () => {
  const { loadSettings } = await import("../src/settings.ts");
  const hb = loadSettings({}).heartbeatMinutes;
  assert.equal(loadSettings({}).google.idleMinutes, Math.max(20, hb + 5));
  assert.ok(loadSettings({}).google.idleMinutes > hb, "longer than the heartbeat: a tick finds the server running");
  assert.equal(loadSettings({ HEARTBEAT_MINUTES: "30" }).google.idleMinutes, 35);
  assert.equal(loadSettings({ HEARTBEAT_MINUTES: "5" }).google.idleMinutes, 20);
  assert.equal(loadSettings({ GOOGLE_MCP_IDLE_MINUTES: "7" }).google.idleMinutes, 7);
});
