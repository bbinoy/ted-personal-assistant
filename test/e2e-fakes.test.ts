import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The end-to-end eval (scripts/e2e-eval.ts) must never touch a real account and must grade truthfully. These tests use the fakes and a temporary folder only, no model:
// the fakes carry the real tool names, a run built by the production builder sees only the fakes and Ted's own servers, a call nobody answers fails the case, the real Mailbird client is blocked,
// the clock is the case's, and a scripted perfect run passes every case while a wrong one fails its checks.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "ted-e2e-test-"));
process.env.TZ = "Europe/London";
process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";

const { owner } = await import("../src/conversation/conversationmodel.ts");
const { runConversation } = await import("../src/run/agent.ts");
const { chatTurn } = await import("../src/run/chattail.ts");
const { settings } = await import("../src/core/settings.ts");
const { clockLine } = await import("../src/core/brief.ts");
const { entryFor } = await import("../src/policy/toolmanifest.ts");
const { Mailbird } = await import("../src/modules/mailbird/mailbird.ts");
const { Recorder } = await import("../scripts/e2e/fakeserver.ts");
const { FakeCalendar, CALENDAR_SERVER } = await import("../scripts/e2e/fakecalendar.ts");
const { FakeMail, MAILBIRD_SERVER } = await import("../scripts/e2e/fakemail.ts");
const { assertHermetic, blockRealMailbird, guardedQuery, initProblems, isAnswered, newGuardState } = await import("../scripts/e2e/guard.ts");
const { makeTime } = await import("../scripts/e2e/time.ts");
const { CASES } = await import("../scripts/e2e/cases.ts");
const { OWNER_EMAIL } = await import("../scripts/e2e/checks.ts");
const { play } = await import("../scripts/e2e/play.ts");

(settings as unknown as { warm: boolean }).warm = false;
const NOW = new Date("2026-10-31T10:00:00Z");
const ZONE = "Europe/London";

const rec = new Recorder();
const cal = new FakeCalendar(rec, ZONE, OWNER_EMAIL, [], () => NOW.getTime());
const mail = new FakeMail(rec, { email: OWNER_EMAIL }, []);
const fakes = { [CALENDAR_SERVER]: cal.service.config, [MAILBIRD_SERVER]: mail.service.config };
const fakeTools = new Set([...cal.service.tools, ...mail.service.tools]);

test("the fakes carry the real tool names: every one is in the production manifest", () => {
  for (const t of fakeTools) assert.ok(entryFor(t), `${t} is not a tool the manifest knows`);
  assert.ok(fakeTools.has("mcp__claude_ai_Google_Calendar__create_event"));
  assert.ok(fakeTools.has("mcp__mailbird__send_message_now"));
});

// A stand-in for the SDK's query: records the options it was given and streams a start-up message with the given servers, then a result.
function standIn(servers: string[], seen: { options?: Record<string, any>; prompt?: string }) {
  return ((args: { prompt: unknown; options: Record<string, any> }) => {
    seen.options = args.options;
    const gen = (async function* () {
      const first = await (args.prompt as AsyncIterable<{ message: { content: string } }>)[Symbol.asyncIterator]().next();
      seen.prompt = first.value.message.content;
      yield { type: "system", subtype: "init", mcp_servers: servers.map((name) => ({ name, status: "connected" })), tools: [] };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s", total_cost_usd: 0 };
    })();
    return Object.assign(gen, { mcpServerStatus: async () => servers.map((name) => ({ name, status: "connected" })), reconnectMcpServer: async () => {}, close: () => {} });
  }) as never;
}

test("a run built by the production builder sees only the fakes and Ted's own servers, with the clock the case gave it", async () => {
  const seen: { options?: Record<string, any>; prompt?: string } = {};
  const state = newGuardState();
  const own = ["send", "tasks", "memory", "people", "meetings"];
  const q = guardedQuery(standIn([...own, ...Object.keys(fakes)], seen), fakes, fakeTools, state);
  await runConversation(owner(), { now: NOW }, chatTurn(owner(), { prompt: "hi" }), undefined, { query: q });
  const o = seen.options!;
  assert.ok(Object.keys(fakes).every((n) => n in o.mcpServers), "the fakes are in the run's servers");
  assert.ok(Object.keys(o.mcpServers).every((n) => n in fakes || ["send", "files", "weather", "draw", "tasks", "voice", "memory", "people", "meetings", "browse", "tenants"].includes(n)), `only Ted's own servers besides: ${Object.keys(o.mcpServers)}`);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.settingSources, [], "no user or project settings (the owner's real Mailbird and connectors are user scope)");
  assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(state.inits, 1, "the start-up message was checked");
  assert.deepEqual(state.violations, []);
  assert.ok(seen.prompt!.includes(clockLine(NOW, ZONE)), "the clock is the case's");
});

test("a start-up message with a real connector in it stops the run, and is kept as a violation", async () => {
  const state = newGuardState();
  const q = guardedQuery(standIn(["tasks", ...Object.keys(fakes), "claude.ai Gmail"], {}), fakes, fakeTools, state);
  await assert.rejects(runConversation(owner(), { now: NOW }, chatTurn(owner(), { prompt: "hi" }), undefined, { query: q }), /eval guard.*claude\.ai Gmail/);
  assert.ok(state.violations.some((v) => v.includes("claude.ai Gmail")));
  assert.equal(state.aborted, true);
  assert.deepEqual(initProblems({ mcp_servers: [{ name: "claude.ai Google Calendar", status: "connected" }, { name: "mailbird", status: "failed" }], tools: ["mcp__claude_ai_Google_Calendar__create_event"] }, Object.keys(fakes)), []);
  assert.deepEqual(initProblems({ mcp_servers: [], tools: ["mcp__claude_ai_Notion__notion-fetch"] }, Object.keys(fakes)), ["unexpected MCP tool mcp__claude_ai_Notion__notion-fetch"]);
});

test("a tool call nobody answers is refused, counted, and aborts the run", async () => {
  const seen: { options?: Record<string, any> } = {};
  const state = newGuardState();
  const q = guardedQuery(standIn(["tasks", ...Object.keys(fakes)], seen), fakes, fakeTools, state);
  await runConversation(owner(), { now: NOW }, chatTurn(owner(), { prompt: "hi" }), undefined, { query: q });
  const ask = seen.options!.canUseTool as (tool: string, input: Record<string, unknown>, o: unknown) => Promise<{ behavior: string }>;
  for (const tool of ["mcp__claude_ai_Notion__notion-fetch", "WebFetch", "mcp__browse__browse", "mcp__voice__speak"]) assert.equal((await ask(tool, {}, { signal: new AbortController().signal })).behavior, "deny", tool);
  assert.equal(state.violations.length, 4);
  assert.equal(state.aborted, true);
  assert.ok(isAnswered("mcp__tasks__add_task", fakeTools) && isAnswered("Read", fakeTools) && isAnswered("mcp__mailbird__get_message", fakeTools));
  assert.ok(!isAnswered("mcp__mailbird__trash_conversation", fakeTools), "a Mailbird tool the fake does not have is not answered");
});

test("the real Mailbird client is blocked and counted, and the guard refuses to start without its environment", async () => {
  const state = newGuardState();
  blockRealMailbird(Mailbird, state);
  const client = new Mailbird();
  await assert.rejects(async () => client.connect(), /blocked/);
  await assert.rejects(async () => client.call("get_message", {}), /blocked/);
  assert.equal(state.realClientCalls, 2);
  assert.equal(state.violations.length, 2);
  assert.throws(() => assertHermetic({}, process.env.HARNESS_DATA_DIR), /claude\.ai connectors/);
  assert.throws(() => assertHermetic({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, "/tmp/somewhere"), /temporary folder/);
  assert.throws(() => assertHermetic({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, undefined), /temporary folder/);
});

test("the fake calendar and mail behave like the real ones in shape and in effect", async () => {
  const t = makeTime(NOW, ZONE);
  const r = new Recorder();
  const c = new FakeCalendar(r, ZONE, OWNER_EMAIL, [{ summary: "Existing", start: t.local(t.day(1), "09:00"), end: t.local(t.day(1), "10:00") }], () => NOW.getTime());
  const made = JSON.parse((await c.service.call("create_event", { summary: "Lunch", startTime: t.local(t.day(2), "12:00"), endTime: t.local(t.day(2), "13:00"), timeZone: ZONE, attendees: [{ email: "Guest@Example.com" }] })).text);
  assert.equal(made.start.timeZone, ZONE);
  assert.equal(made.attendees.length, 2, "the owner and the guest");
  const listed = JSON.parse((await c.service.call("list_events", { startTime: t.local(t.day(2), "00:00"), endTime: t.local(t.day(3), "00:00") })).text);
  assert.deepEqual(listed.events.map((e: { summary: string }) => e.summary), ["Lunch"]);
  assert.deepEqual(c.final().find((e) => e.summary === "Lunch")!.invited, ["guest@example.com"]);
  assert.equal(r.calls.length, 2);
  assert.equal((await c.service.call("get_event", { eventId: "nope" })).isError, true);

  const m = new FakeMail(r, { email: OWNER_EMAIL }, [{ from: "a@example.org", subject: "Hello", body: "<p>Hi</p>", receivedAt: NOW.toISOString() }]);
  const list = JSON.parse((await m.service.call("list_conversations", { folderId: 10 })).text);
  assert.equal(list.length, 1);
  const draft = JSON.parse((await m.service.call("reply_to_conversation", { conversationId: list[0].conversationId, body: "<p>Thanks</p>" })).text);
  assert.equal((await m.service.call("send_message_now", { messageId: draft.messageId })).isError, true, "send needs confirm: true");
  assert.equal(m.sent.length, 0);
  await m.service.call("send_message_now", { messageId: draft.messageId, confirm: true });
  assert.deepEqual(m.sent.map((s) => s.to), [["a@example.org"]]);
  assert.equal((m.readDraft(draft.messageId) as { body: string }).body, "<p>Thanks</p>", "the approval's read-back is answered by the fake");
  await m.service.call("archive_conversation", { conversationId: list[0].conversationId });
  assert.ok(m.folderOf("Hello").includes("archive"));
});

test("a scripted perfect run passes every case, with no needless question, nothing unsafe and no real client", async () => {
  for (const c of CASES) {
    const r = await play(c, { now: NOW, zone: ZONE, perfect: true });
    assert.deepEqual(r.checks.filter((k) => !k.pass), [], `${c.id}: every check passes`);
    assert.deepEqual([...r.never, ...r.guard.violations], [], `${c.id}: nothing unsafe`);
    assert.ok(r.asks.length <= c.maxQuestions, `${c.id}: no needless question`);
    assert.equal(r.guard.realClientCalls, 0);
  }
});

test("the grading fails what is wrong: a second dinner, an event without the guest, a send before the word", async () => {
  const t = makeTime(NOW, ZONE);
  const outcome = async (id: string, act: (c: InstanceType<typeof FakeCalendar>, m: InstanceType<typeof FakeMail>) => Promise<void>) => {
    const c = CASES.find((x) => x.id === id)!;
    const w = c.world(t);
    const r = new Recorder();
    const cc = new FakeCalendar(r, ZONE, OWNER_EMAIL, w.calendar, () => NOW.getTime());
    const mm = new FakeMail(r, { email: OWNER_EMAIL }, w.mail);
    await act(cc, mm);
    return { c, o: { time: t, calendar: cc.final(), mail: mm, tasks: [], notes: {}, notion: [], asks: [], web: { fetched: [], searches: [], submissions: [], payments: [], payClicks: [], ledger: [] }, calls: r.calls.map((x) => ({ tool: x.tool, turn: x.turn, args: x.args, ok: x.ok })), turns: [{ message: "", messages: [], sent: mm.sent, drafts: [] }, { message: "", messages: [], sent: mm.sent, drafts: [] }] } };
  };
  const e1 = await outcome("e1", async (c) => {
    for (let i = 0; i < 2; i++) await c.service.call("create_event", { summary: "Lunch", startTime: t.local(t.nextWeekday(4), "12:00"), endTime: t.local(t.nextWeekday(4), "13:00") });
  });
  const failed1 = e1.c.state(e1.o).filter((k) => !k.pass).map((k) => k.name);
  assert.ok(failed1.includes("exactly one event was created") && failed1.includes("Mira is a guest") && failed1.includes("the invitation was sent"), failed1.join());
  const e5 = await outcome("e5", async (c) => void (await c.service.call("create_event", { summary: "Dinner at Larkfield", startTime: t.local(t.day(1), "19:30") })));
  const failed5 = e5.c.state(e5.o).filter((k) => !k.pass).map((k) => k.name);
  assert.ok(failed5.some((n) => n.startsWith("exactly one dinner")) && failed5.some((n) => n.startsWith("no event was created")) && failed5.some((n) => n.startsWith("one open task")), failed5.join());
  const e6 = await outcome("e6", async (_c, m) => {
    const d = JSON.parse((await m.service.call("create_draft", { to: ["peter.lindgren@example.com"], subject: "Hi", body: "plain text\nwith newlines" })).text);
    await m.service.call("send_message_now", { messageId: d.messageId, confirm: true });
  });
  assert.equal(e6.c.never(e6.o).length, 1, "a send that is already in the first turn's state is unsafe");
  const failed6 = e6.c.state(e6.o).filter((k) => !k.pass).map((k) => k.name);
  assert.ok(failed6.includes("with HTML line breaks (<p> or <br>)"), failed6.join());
});

test("the fake web serves only the case's pages over its own certificate; a page fetch the case does not have is refused", async () => {
  const { startFakeWeb } = await import("../scripts/e2e/fakeweb.ts");
  const { request } = await import("node:https");
  const { readFileSync } = await import("node:fs");
  const web = await startFakeWeb({ "https://events.example.com/e/one": "<h1>One</h1>" });
  try {
    const local = web.rewrite("https://events.example.com/e/one#top");
    assert.match(local!, /^https:\/\/127\.0\.0\.1:\d+\/p0$/);
    assert.equal(web.rewrite("https://events.example.com/e/two"), undefined);
    const body = await new Promise<string>((resolve, reject) => request(local!, { ca: readFileSync(web.certFile) }, (res) => { let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve(s)); }).on("error", reject).end());
    assert.equal(body, "<h1>One</h1>");
    assert.deepEqual(web.hits, ["https://events.example.com/e/one"]);
    const seen: { options?: Record<string, any> } = {};
    const state = newGuardState();
    const q = guardedQuery(standIn(["tasks", ...Object.keys(fakes)], seen), fakes, fakeTools, state, web);
    await runConversation(owner(), { now: NOW }, chatTurn(owner(), { prompt: "hi" }), undefined, { query: q });
    assert.equal(seen.options!.env.NODE_EXTRA_CA_CERTS, web.certFile, "the run trusts the fake web's certificate");
    const ask = seen.options!.canUseTool as (tool: string, input: Record<string, unknown>, o: unknown) => Promise<{ behavior: string }>;
    assert.equal((await ask("WebFetch", { url: "https://www.example.org/real", prompt: "x" }, { signal: new AbortController().signal })).behavior, "deny");
    assert.ok(state.violations.some((v) => v.startsWith("un-faked page fetch")));
    // A web search is answered from the case's own pages (title, address, snippet), through the guard, and only when the run's own rules allow it.
    const found = (await ask("WebSearch", { query: "one page" }, { signal: new AbortController().signal })) as unknown as { behavior: string; message: string };
    assert.equal(found.behavior, "deny");
    assert.match(found.message, /1\. [^\n]*\nhttps:\/\/events\.example\.com\/e\/one\n/);
    assert.match(web.search("nothing like it zzz"), /^No results/);
    assert.deepEqual(web.searches, ["one page", "nothing like it zzz"]);
  } finally {
    await web.close();
  }
});

test("the fake Notion creates rows in a data source and refuses an unknown one", async () => {
  const { FakeNotion } = await import("../scripts/e2e/fakenotion.ts");
  const n = new FakeNotion(new Recorder(), [{ id: "db1", title: "Media", dataSourceId: "ds1", schema: { Name: { type: "title" } } }]);
  const found = JSON.parse((await n.service.call("notion-search", { query: "media" })).text);
  assert.equal(found.results[0].id, "db1");
  assert.match(JSON.parse((await n.service.call("notion-fetch", { id: "db1" })).text).text, /collection:\/\/ds1/);
  await n.service.call("notion-create-pages", { parent: { type: "data_source_id", data_source_id: "ds1" }, pages: [{ properties: { Name: "A book" } }] });
  assert.equal(n.final()[0]!.title, "A book");
  assert.equal(n.final()[0]!.dataSourceId, "ds1");
  assert.equal((await n.service.call("notion-create-pages", { parent: { data_source_id: "nope" }, pages: [{ properties: {} }] })).isError, true);
});
