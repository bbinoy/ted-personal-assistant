import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One agent (CLAUDE.md §2): a chat turn and a look of a conversation are the same agent, built by the same function. They differ in the table of runoptions.ts TRIGGERS: the
// model, the session they resume, the message, attended, the answer. These tests run both through the real entry points (runConversation, runLook) with a fake query and read
// what the SDK would have been given.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "oneagent-"));

const { settings } = await import("../src/core/settings.ts");
const { owner, group } = await import("../src/conversation/conversationmodel.ts");
const { runConversation, runLook } = await import("../src/run/agent.ts");
const { readSession, writeSession } = await import("../src/run/sessionstore.ts");
const { forgetShown } = await import("../src/run/turncontext.ts");
const { LOGIN } = await import("../src/tenants/payer.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { logSince } = await import("../src/conversation/gate.ts");

(settings as unknown as { warm: boolean }).warm = false;

type Call = { prompt: string; options: Record<string, any> };
let calls: Call[] = [];
const fake = (sessionId: string, fail?: string) =>
  ((p: { prompt: unknown; options: Record<string, any> }) => (
    calls.push({ prompt: String(p.prompt), options: p.options }),
    (async function* () {
      if (fail) throw new Error(fail);
      yield { type: "result", subtype: "success", is_error: false, result: "[[silent]]", session_id: sessionId, total_cost_usd: 0.01, structured_output: { message: "[[silent]]", nextCheckMinutes: 30 } };
    })()
  )) as never;
const approve = async () => ({ approved: false });
const noFacts = (over: Record<string, unknown> = {}) => ({ blocks: [] as string[], status: [] as string[], untrusted: false, done: () => {}, onDelegate: () => {}, onTool: () => {}, routines: "", ...over }) as never;
const seed = (conv: { convId: string }, track: "chat" | "look", sessionId: string) => writeSession(conv.convId as never, { sessionId, costUsd: 0, lastTurnAt: new Date().toISOString(), lastContextTokens: 1000, baseTokens: 1000 }, track);
const look = (conv: ReturnType<typeof owner>, o: { sid: string; fail?: string; facts?: unknown; build?: (since?: string) => { prompt: string; seenAt?: string } }) =>
  runLook(conv, LOGIN, o.build ?? (() => ({ prompt: "Background check" })), approve, { facts: (o.facts ?? noFacts()) as never }, { io: { query: fake(o.sid, o.fail) } });
const chat = (conv: ReturnType<typeof owner>, sid: string, text = "hello") => runConversation(conv, {}, () => ({ prompt: text }), undefined, { query: fake(sid) });

test("a look resumes the conversation's look session and a chat turn its chat session; the two never mix", async () => {
  calls = [];
  const conv = group("oneagent-sessions");
  seed(conv, "chat", "chat-1");
  seed(conv, "look", "look-1");
  await look(conv, { sid: "look-2" });
  await chat(conv, "chat-2");
  assert.equal(calls[0]!.options.resume, "look-1", "the look resumes the look session");
  assert.equal(calls[1]!.options.resume, "chat-1", "the chat resumes the chat session");
  assert.equal(readSession(conv.convId, "look").sessionId, "look-2");
  assert.equal(readSession(conv.convId, "chat").sessionId, "chat-2");
  // each session is on its own model
  assert.equal(calls[0]!.options.model, settings.heartbeatModel);
  assert.equal(calls[1]!.options.model, settings.model);
});

test("a conversation's chat and look have ONE system prompt; the owner's look has draw and voice like a group's look, per capabilities", async () => {
  for (const conv of [owner(), group("oneagent-prompt")]) {
    calls = [];
    await chat(conv, "c");
    await look(conv, { sid: "l" });
    const [c, l] = calls as [Call, Call];
    const text = (o: Record<string, any>) => (o.systemPrompt.type === "preset" ? o.systemPrompt.append : o.systemPrompt.prompt);
    assert.equal(text(l.options), text(c.options), `${conv.kind}: the same prompt, whatever starts the run`);
    const servers = Object.keys(l.options.mcpServers ?? {});
    for (const wanted of ["send", "tasks", "weather", "draw", ...(settings.tts.provider === "qwen" ? ["voice"] : [])]) assert.ok(servers.includes(wanted), `${conv.kind} look has ${wanted}`);
    assert.ok(!servers.includes("notes") && servers.includes("memory") && servers.includes("people"), "a look has the one memory server, like a chat");
    const memory = (o: Call) => Object.keys((o.options.mcpServers.memory as { instance: { _registeredTools: object } }).instance._registeredTools);
    assert.deepEqual(memory(l).sort(), memory(c).sort(), "the memory server of a look is a chat's");
    assert.deepEqual(memory(c).sort(), ["forget_note", "journal", "search_logs", ...(conv.kind === "owner" || conv.kind === "group" ? ["undo_dream"] : [])].sort());
    assert.ok(Object.keys(c.options.mcpServers ?? {}).includes("memory") && !Object.keys(c.options.mcpServers ?? {}).includes("notes"));
    assert.ok(l.options.tools.includes("Read") && c.options.tools.includes("Read"), "the notes' file tools are every run's");
    assert.equal(l.options.tools.includes("WebFetch"), c.options.tools.includes("WebFetch"), "opening a page follows the owner, look or chat");
  }
});

test("a look is told the context once per session and the chat lines it has not seen; the first look of a fresh session gets the tail", async () => {
  calls = [];
  const conv = group("oneagent-told");
  forgetShown(conv.convId, "look");
  const seen: (string | undefined)[] = [];
  const build = (since?: string) => (seen.push(since), { prompt: `check (since ${since ?? "never"})`, seenAt: logSince(conv, since).seenAt });
  recordMessage("owner", Date.now() - 5000, "first line", new Date(), conv.logFile);
  const facts = (claimed: string) => noFacts({ status: ["STATUS: three open tasks"], blocks: [claimed] });
  await look(conv, { sid: "l1", facts: facts("CLAIMED: water the plants"), build });
  assert.match(calls[0]!.prompt, /STATUS: three open tasks[\s\S]*CLAIMED: water the plants[\s\S]*check \(since never\)/);
  assert.equal(seen[0], undefined, "a fresh look session has seen nothing");
  assert.ok(readSession(conv.convId, "look").seenAt, "and remembers how far it has seen");
  recordMessage("member", Date.now() + 10, "second line", new Date(), conv.logFile);
  await look(conv, { sid: "l2", facts: facts("CLAIMED: water the ferns"), build });
  assert.doesNotMatch(calls[1]!.prompt, /STATUS: three open tasks/, "the same information is not told twice to the same session");
  assert.match(calls[1]!.prompt, /CLAIMED: water the ferns/, "a new claimed fact is told");
  assert.ok(seen[1], "the second look is built from the line its session last saw");
  assert.deepEqual(logSince(conv, seen[1]).lines.filter((l) => /first line/.test(l)), [], "what the look already saw is not shown again");
});

test("a failed look leaves its session as it was; a session the SDK cannot resume is dropped and the next look starts fresh; the chat session is untouched", async () => {
  calls = [];
  const conv = group("oneagent-fail");
  seed(conv, "chat", "chat-keep");
  seed(conv, "look", "look-keep");
  await assert.rejects(look(conv, { sid: "x", fail: "down" }), /down/);
  assert.equal(readSession(conv.convId, "look").sessionId, "look-keep");
  await assert.rejects(look(conv, { sid: "x", fail: "No conversation found with session ID: look-keep" }), /No conversation found/);
  assert.equal(readSession(conv.convId, "look").sessionId, undefined, "dropped");
  assert.equal(readSession(conv.convId, "chat").sessionId, "chat-keep", "the chat session is not the look's business");
  await look(conv, { sid: "look-new" });
  assert.equal(calls.at(-1)!.options.resume, undefined, "a fresh look session");
  assert.equal(readSession(conv.convId, "look").sessionId, "look-new");
});

test("a look that read a task made from mail marks its own session untrusted, which persists; the chat session stays clean", async () => {
  const conv = group("oneagent-taint");
  seed(conv, "chat", "chat-clean");
  seed(conv, "look", "look-1");
  await look(conv, { sid: "look-1", facts: noFacts({ untrusted: true, status: ["task list with a mail's words"] }) });
  assert.equal(readSession(conv.convId, "look").untrustedIn, "look-1");
  assert.equal(readSession(conv.convId, "chat").untrustedIn, undefined);
});

test("the owner's look gets browse like any look, but never her card or saved details: payment is a typed YES in her attended chat only", async () => {
  const { browseToolText } = await import("../src/modules/browse/browse.ts");
  assert.match(browseToolText({ mode: "owner", key: "owner", attended: true }), /saved payment card/);
  assert.doesNotMatch(browseToolText({ mode: "owner", key: "owner", attended: false }), /saved payment card/);
  assert.doesNotMatch(browseToolText({ mode: "group", key: "g", attended: true }), /saved payment card/);
});

test("a tool nobody declared asks the owner in a chat and is skipped in a look (never denied); a declared tool outside the run's set is denied", async () => {
  const { classify } = await import("../src/policy/policy.ts");
  const { capabilitiesOf, toolsFor } = await import("../src/policy/capabilities.ts");
  const { makeCanUseTool } = await import("../src/approvals/permissions.ts");
  const chatSet = toolsFor(capabilitiesOf({ kind: "owner" }), { who: "owner", attended: true });
  const lookSet = toolsFor(capabilitiesOf({ kind: "owner" }), { who: "owner", attended: false });
  assert.equal(classify("mcp__new_server__do_thing", {}, { who: "owner", attended: true }, undefined, chatSet), "ask");
  assert.equal(classify("mcp__memory__forget_note", { file: "x.md" }, { who: "owner", attended: false }, undefined, new Set(["Read"])), "deny");
  const can = makeCanUseTool(approve as never, { who: "owner", attended: false }, undefined, undefined, undefined, lookSet);
  const r = (await can("mcp__new_server__do_thing", {}, { signal: new AbortController().signal } as never)) as { behavior: string; message?: string };
  assert.match(r.message ?? "", /background work never asks/);
});
