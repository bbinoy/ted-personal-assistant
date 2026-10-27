import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A conversation has two resumed sessions, one per track (run/sessionstore.ts): its chat and its looks. The same code keeps both (resume, taint, compaction, "cannot resume");
// they never share a record. (The looks and the chat running through them is test/oneagent.test.ts.)
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "looksession-"));

const { group } = await import("../src/conversation/conversationmodel.ts");
const { readSession, writeSession } = await import("../src/run/sessionstore.ts");
const { chatResume, compactDue, compactOptions, forgetUnresumable, sessionTaint } = await import("../src/run/chatsession.ts");
const { forgetShown, toldKey, unseen, markShown } = await import("../src/run/turncontext.ts");
const { settings } = await import("../src/core/settings.ts");

const old = () => new Date(Date.now() - 3_600_000).toISOString();

test("the two sessions of a conversation are separate records; a fresh one is { costUsd: 0 }", () => {
  const conv = group("looksession-records");
  assert.deepEqual(readSession(conv.convId, "look"), { costUsd: 0 });
  writeSession(conv.convId, { sessionId: "chat-1", costUsd: 1, lastTurnAt: old() }, "chat");
  assert.deepEqual(readSession(conv.convId, "look"), { costUsd: 0 }, "writing the chat session does not touch the look session");
  writeSession(conv.convId, { sessionId: "look-1", costUsd: 2, lastTurnAt: old(), seenAt: "2026-10-27T10:00:00.000Z" }, "look");
  assert.equal(readSession(conv.convId).sessionId, "chat-1", "the default is the chat session");
  assert.deepEqual([readSession(conv.convId, "look").sessionId, readSession(conv.convId, "look").seenAt, chatResume(conv.convId, "look").resume, chatResume(conv.convId).resume], ["look-1", "2026-10-27T10:00:00.000Z", "look-1", "chat-1"]);
});

test("the untrusted flag follows its own session: a look session that read mail does not taint the chat session", () => {
  const conv = group("looksession-taint");
  writeSession(conv.convId, { sessionId: "c", costUsd: 0, lastTurnAt: old() }, "chat");
  writeSession(conv.convId, { sessionId: "l", costUsd: 0, lastTurnAt: old() }, "look");
  sessionTaint(conv.convId, "l", "look").mark();
  assert.equal(sessionTaint(conv.convId, "l", "look").read(), true);
  assert.equal(sessionTaint(conv.convId, "c", "chat").read(), false);
  assert.equal(readSession(conv.convId, "look").untrustedIn, "l");
  assert.equal(readSession(conv.convId, "chat").untrustedIn, undefined);
});

test("a session the SDK cannot resume is dropped for its own track only", () => {
  const conv = group("looksession-gone");
  writeSession(conv.convId, { sessionId: "c", costUsd: 3, lastTurnAt: old() }, "chat");
  writeSession(conv.convId, { sessionId: "l", costUsd: 4, lastTurnAt: old() }, "look");
  assert.equal(forgetUnresumable(conv.convId, new Error("something else"), "group", "look"), false);
  assert.equal(forgetUnresumable(conv.convId, new Error("No conversation found with session ID: l"), "background", "look"), true);
  assert.deepEqual([readSession(conv.convId, "look").sessionId, readSession(conv.convId, "chat").sessionId], [undefined, "c"]);
});

test("compaction is due per session, on the model the session runs on, with the isolation of the conversation", () => {
  const conv = group("looksession-compact");
  writeSession(conv.convId, { sessionId: "c", costUsd: 0, lastTurnAt: old(), lastContextTokens: 10_000, baseTokens: 10_000 }, "chat");
  writeSession(conv.convId, { sessionId: "l", costUsd: 0, lastTurnAt: old(), lastContextTokens: 10_000, baseTokens: 10_000 }, "look");
  assert.equal(compactDue(conv.convId), false);
  writeSession(conv.convId, { sessionId: "l", costUsd: 0, lastTurnAt: old(), lastContextTokens: 10_000_000, baseTokens: 10_000 }, "look");
  assert.equal(compactDue(conv.convId), true, "the look session alone has outgrown the limit");
  assert.equal(compactOptions("l", true, undefined, undefined, "look").model, settings.heartbeatModel);
  assert.equal(compactOptions("c", true, "/n", undefined, "chat").model, settings.model);
  assert.equal(compactOptions("l", true, undefined, undefined, "look").strictMcpConfig, true);
});

test("what each session was told is remembered under its own key, and forgotten with the session", () => {
  const conv = group("looksession-told");
  assert.notEqual(toldKey(conv.convId, "look"), toldKey(conv.convId, "chat"));
  markShown(toldKey(conv.convId, "look"), "l", "STATUS");
  assert.equal(unseen(toldKey(conv.convId, "look"), "l", "STATUS"), undefined);
  assert.equal(unseen(toldKey(conv.convId, "chat"), "c", "STATUS"), "STATUS", "the chat session was not told");
  forgetShown(conv.convId, "look");
  assert.equal(unseen(toldKey(conv.convId, "look"), "l", "STATUS"), "STATUS");
});
